/**
 * End-to-end demo driver reproducing the paper's hardware experiments:
 *
 *  default ("relevant"):   IV-A1 — mid-mission, the green object is knocked
 *                          off Go2's back. Burger raises the event, the
 *                          classifier marks it relevant, the Task Manager
 *                          replans (Waffle assists, Go2 resumes), and the
 *                          mission still completes. Expect >= 1 replan.
 *
 *  --scenario irrelevant:  Fig. 5 — a red object is thrown in front of
 *                          Burger. The event is classified irrelevant and
 *                          dropped; no replanning occurs. Expect 0 replans.
 *
 * Prerequisites: `npm run dev` (Mastra, :4111) and `npm run fleet` (:4222).
 */
import { z } from "zod";

const MASTRA_URL = process.env.MASTRA_URL ?? "http://localhost:4113";
const FLEET_URL = process.env.FLEET_URL ?? "http://localhost:4222";
const scenarioArg = process.argv.includes("--scenario")
  ? process.argv[process.argv.indexOf("--scenario") + 1]
  : "relevant";

const COMMAND =
  "Waffle: go to the bottle and stay next to it. Go2: carry the green object on your back to coordinate (3, 0). Burger: hold position and watch the scene for anything unusual.";

const COLORS: Record<string, string> = {
  user: "\x1b[34m", // blue, as in the paper's chat interface
  task_manager: "\x1b[33m", // orange-ish
  event: "\x1b[32m", // green
  robot: "\x1b[36m",
};
const RESET = "\x1b[0m";

const ChatEntrySchema = z.object({
  role: z.string(),
  speaker: z.string(),
  content: z.string(),
  at: z.string(),
});
const MissionViewSchema = z.object({
  runId: z.string(),
  status: z.string(),
  mission: z
    .object({
      replanCount: z.number(),
      taskStatuses: z.record(z.string(), z.string()),
      chat: z.array(ChatEntrySchema),
      subtasks: z.array(z.object({ id: z.string(), assignee: z.string(), instruction: z.string() })),
    })
    .nullable(),
});

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main(): Promise<void> {
  console.log(`scenario: ${scenarioArg}`);
  console.log(`starting mission: "${COMMAND}"`);
  const started = z
    .object({ runId: z.string(), status: z.string() })
    .parse(await postJson(`${MASTRA_URL}/missions`, { command: COMMAND }));
  console.log(`mission started: runId=${started.runId} status=${started.status}`);

  // Wait until Go2 is physically executing on the fleet, then disrupt.
  const HealthSchema = z.object({ ok: z.boolean(), running: z.array(z.string()) });
  let disrupted = false;
  for (let i = 0; i < 60 && !disrupted; i++) {
    const health = HealthSchema.parse(await (await fetch(`${FLEET_URL}/health`)).json());
    const targetRunning =
      scenarioArg === "relevant" ? health.running.includes("go2") : health.running.length > 0;
    if (targetRunning) {
      await sleep(1000); // mid-execution, like the paper's deliberate knock
      if (scenarioArg === "relevant") {
        console.log("\n>>> DISRUPTION: knocking the green object off Go2's back\n");
        await postJson(`${FLEET_URL}/disrupt`, {
          runId: started.runId,
          cancelRobot: "go2",
          statusNote: "payload lost: the green object fell off my back",
          eventFrom: "burger",
          eventDescription:
            "I observed the green object fall off the quadruped's back onto the floor at roughly (1.5, 0). The quadruped is continuing without its payload.",
        });
      } else {
        console.log("\n>>> DISTRACTION: throwing a red object in front of Burger\n");
        await postJson(`${FLEET_URL}/disrupt`, {
          runId: started.runId,
          eventFrom: "burger",
          eventDescription:
            "A red object was just thrown onto the floor in front of me. It is not one of the objects involved in our tasks.",
        });
      }
      disrupted = true;
    }
    if (!disrupted) await sleep(500);
  }
  if (!disrupted) throw new Error("fleet never reported a running robot; is `npm run fleet` up?");

  // Follow the mission chat until the run terminates.
  let printed = 0;
  const deadline = Date.now() + 300_000;
  let finalStatus = "unknown";
  let replanCount = 0;
  let taskStatuses: Record<string, string> = {};
  while (Date.now() < deadline) {
    const view = MissionViewSchema.parse(
      await (await fetch(`${MASTRA_URL}/missions/${started.runId}`)).json(),
    );
    if (view.mission) {
      for (; printed < view.mission.chat.length; printed++) {
        const entry = view.mission.chat[printed];
        const color = COLORS[entry.role] ?? "";
        console.log(`${color}(${entry.role}) ${entry.speaker}: ${entry.content}${RESET}\n`);
      }
      replanCount = view.mission.replanCount;
      taskStatuses = view.mission.taskStatuses;
    }
    finalStatus = view.status;
    if (["success", "failed", "canceled"].includes(view.status)) break;
    await sleep(2000);
  }

  console.log(`\n=== mission ${finalStatus} | replans: ${replanCount} ===`);
  console.log(`task statuses: ${JSON.stringify(taskStatuses)}`);

  const failures: string[] = [];
  if (finalStatus !== "success") failures.push(`expected status success, got ${finalStatus}`);
  const incomplete = Object.entries(taskStatuses).filter(([, s]) => s !== "COMPLETED");
  if (incomplete.length > 0) failures.push(`incomplete tasks: ${JSON.stringify(incomplete)}`);
  if (scenarioArg === "relevant" && replanCount < 1) {
    failures.push("expected at least one replan after the relevant event");
  }
  if (scenarioArg === "irrelevant" && replanCount !== 0) {
    failures.push(`expected zero replans for the irrelevant event, got ${replanCount}`);
  }

  if (failures.length > 0) {
    console.error(`\nFAIL:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
