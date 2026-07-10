/**
 * Simulated robot fleet: the mocked actuation + event-detection layer.
 *
 * Receives composed Python programs from the mission workflow's dispatch step
 * (POST /execute), "runs" them for EXEC_MS per task (one task per robot at a
 * time, like the paper's robots), and reports completion through the same
 * REST webhooks a real perception/status stack would use.
 *
 * POST /disrupt injects the paper's hardware-experiment disruptions:
 * cancel a running task (INTERRUPTED) and/or raise a perception event from an
 * observer robot, which the server-side classifier filters for relevance.
 */
import http from "node:http";
import { z } from "zod";

const PORT = Number(process.env.FLEET_PORT ?? 4222);
const EXEC_MS = Number(process.env.EXEC_MS ?? 6000);
const MASTRA_URL = process.env.MASTRA_URL ?? "http://localhost:4113";

interface Execution {
  runId: string;
  robotId: string;
  taskId: string;
  instruction: string;
  code: string;
  cancelled?: boolean;
}

const queues = new Map<string, Execution[]>();
const running = new Map<string, Execution>();

function log(msg: string): void {
  console.log(`[fleet ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function postWebhook(path: string, body: unknown): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${MASTRA_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) {
        log(`webhook ${path} -> ${res.status} ${text.slice(0, 160)}`);
        return;
      }
      log(`webhook ${path} attempt ${attempt} failed: ${res.status} ${text.slice(0, 160)}`);
    } catch (err) {
      log(`webhook ${path} attempt ${attempt} error: ${err}`);
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1000 * attempt);
    await promise;
  }
  log(`webhook ${path} gave up after 3 attempts`);
}

function pump(robotId: string): void {
  if (running.has(robotId)) return;
  const queue = queues.get(robotId) ?? [];
  const exec = queue.shift();
  if (!exec) return;
  running.set(robotId, exec);
  log(`${robotId} started [${exec.taskId}] "${exec.instruction}" (~${EXEC_MS}ms)`);
  setTimeout(async () => {
    running.delete(robotId);
    if (!exec.cancelled) {
      await postWebhook(`/webhooks/robots/${robotId}/status`, {
        runId: exec.runId,
        taskId: exec.taskId,
        status: "COMPLETED",
        robotStatus: `finished: ${exec.instruction}`,
        note: "execution finished nominally",
      });
    }
    pump(robotId);
  }, EXEC_MS);
}

const ExecutionSchema = z.object({
  runId: z.string(),
  robotId: z.string(),
  taskId: z.string(),
  instruction: z.string(),
  code: z.string(),
});

const DisruptSchema = z.object({
  runId: z.string(),
  cancelRobot: z.string().optional(),
  statusNote: z.string().optional(),
  eventFrom: z.string().optional(),
  eventDescription: z.string().optional(),
});

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  const respond = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "POST" && req.url === "/execute") {
      const exec: Execution = ExecutionSchema.parse(await readJson(req));
      const queue = queues.get(exec.robotId) ?? [];
      queue.push(exec);
      queues.set(exec.robotId, queue);
      log(`${exec.robotId} queued [${exec.taskId}]`);
      pump(exec.robotId);
      return respond(202, { accepted: true });
    }

    if (req.method === "POST" && req.url === "/disrupt") {
      const { runId, cancelRobot, statusNote, eventFrom, eventDescription } = DisruptSchema.parse(
        await readJson(req),
      );
      let interrupted: string | null = null;

      if (cancelRobot !== undefined) {
        const current = running.get(cancelRobot);
        if (current && current.runId === runId) {
          current.cancelled = true;
          interrupted = current.taskId;
          log(`${cancelRobot} task [${current.taskId}] cancelled by disruption`);
          await postWebhook(`/webhooks/robots/${cancelRobot}/status`, {
            runId,
            taskId: current.taskId,
            status: "INTERRUPTED",
            note: statusNote ?? "execution disrupted",
          });
        } else {
          log(`disrupt: ${cancelRobot} has no running task for this run; skipping cancel`);
        }
      }

      if (typeof eventFrom === "string" && typeof eventDescription === "string") {
        await postWebhook(`/webhooks/robots/${eventFrom}/events`, {
          runId,
          description: eventDescription,
        });
      }
      return respond(200, { interrupted });
    }

    if (req.method === "GET" && req.url === "/health") {
      return respond(200, { ok: true, running: [...running.keys()] });
    }

    respond(404, { error: "not found" });
  } catch (err) {
    respond(500, { error: String(err) });
  }
});

server.listen(PORT, () => log(`simulated fleet listening on :${PORT} (exec ${EXEC_MS}ms, mastra ${MASTRA_URL})`));
