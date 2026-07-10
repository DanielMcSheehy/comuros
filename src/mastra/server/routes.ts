import { registerApiRoute } from "@mastra/core/server";
import { EventRelevanceSchema, TaskStatusSchema, initialMissionState } from "../schemas";
import { missionRegistry, resumeMission } from "../lib/registry";

/**
 * Mocked event-detection layer (§III-B) as REST webhooks. In the paper this
 * boundary is onboard perception (VLMs / image processing) plus ROS2 status
 * topics; here each simulated robot POSTs the same signals over HTTP:
 *
 *  - POST /missions                       start a mission from a natural-language goal
 *  - GET  /missions/:runId                observe status, statuses, and chat transcript
 *  - POST /webhooks/robots/:id/status     robot task/robot status report -> resumes the run
 *  - POST /webhooks/robots/:id/events     raw perception event -> classified on the "robot",
 *                                         forwarded (resume) only when relevant
 *  - POST /webhooks/user                  anytime human input: intent change or task confirmation
 */
export const apiRoutes = [
  registerApiRoute("/missions", {
    method: "POST",
    handler: async (c) => {
      const { command } = await c.req.json();
      if (typeof command !== "string" || command.length === 0) {
        return c.json({ error: "body must be { command: string }" }, 400);
      }
      const mastra = c.get("mastra");
      const workflow = mastra.getWorkflow("comurosMission");
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: { command },
        initialState: initialMissionState,
      });
      return c.json({
        runId: run.runId,
        status: result.status,
        suspended: result.status === "suspended" ? result.suspended : [],
      });
    },
  }),

  registerApiRoute("/missions/:runId", {
    method: "GET",
    handler: async (c) => {
      const runId = c.req.param("runId");
      const mastra = c.get("mastra");
      const snapshot = await mastra.getWorkflow("comurosMission").getWorkflowRunById(runId);
      if (!snapshot) return c.json({ error: `unknown run ${runId}` }, 404);
      return c.json({ runId, status: snapshot.status, mission: missionRegistry.get(runId) ?? null });
    },
  }),

  registerApiRoute("/webhooks/robots/:robotId/status", {
    method: "POST",
    handler: async (c) => {
      const robotId = c.req.param("robotId");
      const body = await c.req.json();
      const status = TaskStatusSchema.safeParse(body.status);
      if (typeof body.runId !== "string" || typeof body.taskId !== "string" || !status.success) {
        return c.json({ error: "body must be { runId, taskId, status, robotStatus?, note? }" }, 400);
      }
      const result = await resumeMission(c.get("mastra"), body.runId, {
        kind: "status",
        robotId,
        taskId: body.taskId,
        status: status.data,
        robotStatus: typeof body.robotStatus === "string" ? body.robotStatus : undefined,
        note: typeof body.note === "string" ? body.note : undefined,
      });
      return c.json(result);
    },
  }),

  registerApiRoute("/webhooks/robots/:robotId/events", {
    method: "POST",
    handler: async (c) => {
      const robotId = c.req.param("robotId");
      const body = await c.req.json();
      if (typeof body.runId !== "string" || typeof body.description !== "string") {
        return c.json({ error: "body must be { runId, description }" }, 400);
      }
      const mastra = c.get("mastra");
      const mission = missionRegistry.get(body.runId);
      const context = mission
        ? `TEAM MISSION: ${mission.command}\nCURRENT SUBTASKS:\n${mission.subtasks
            .map((t) => `  [${t.id}] ${t.assignee} — ${mission.taskStatuses[t.id]} — ${t.instruction}`)
            .join("\n")}`
        : "TEAM MISSION: unknown (no registry entry)";

      // Decentralized filtering: classification happens "on the robot";
      // irrelevant events never reach the Task Manager.
      const response = await mastra.getAgent("eventClassifier").generate(
        `${context}\n\nREPORTING ROBOT: ${robotId}\nOBSERVED EVENT: ${body.description}\n\nClassify this event.`,
        { structuredOutput: { schema: EventRelevanceSchema } },
      );
      const verdict = response.object;
      if (!verdict.relevant) {
        console.log(`[events] ${robotId}: irrelevant, dropped — ${verdict.reasoning}`);
        return c.json({ relevant: false, reasoning: verdict.reasoning, forwarded: false });
      }
      const result = await resumeMission(mastra, body.runId, {
        kind: "event",
        robotId,
        description: body.description,
        reasoning: verdict.reasoning,
      });
      return c.json({ relevant: true, reasoning: verdict.reasoning, forwarded: !result.skipped });
    },
  }),

  registerApiRoute("/webhooks/user", {
    method: "POST",
    handler: async (c) => {
      const body = await c.req.json();
      if (typeof body.runId !== "string" || typeof body.message !== "string") {
        return c.json({ error: "body must be { runId, message, taskId?, status? }" }, 400);
      }
      const status = body.status !== undefined ? TaskStatusSchema.safeParse(body.status) : undefined;
      const result = await resumeMission(c.get("mastra"), body.runId, {
        kind: "user",
        message: body.message,
        taskId: typeof body.taskId === "string" ? body.taskId : undefined,
        status: status?.success ? status.data : undefined,
      });
      return c.json(result);
    },
  }),
];
