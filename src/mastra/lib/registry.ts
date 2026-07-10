import type { Mastra } from "@mastra/core";
import type { ChatEntry, Subtask, TaskStatus, Wake } from "../schemas";

/**
 * In-memory mission registry.
 *
 * Webhook handlers need mission context (command, subtasks, statuses) to
 * classify event relevance and to report progress without deserializing
 * workflow snapshots. Steps publish their state here after every transition.
 *
 * Mock-layer limitation: process-local. A multi-instance deployment would
 * move this into the storage layer.
 */
export interface MissionInfo {
  command: string;
  classification: string | null;
  subtasks: Subtask[];
  taskStatuses: Record<string, TaskStatus>;
  robotStatuses: Record<string, string>;
  chat: ChatEntry[];
  replanCount: number;
}

const missions = new Map<string, MissionInfo>();

export const missionRegistry = {
  upsert(runId: string, info: MissionInfo): void {
    missions.set(runId, info);
  },
  get(runId: string): MissionInfo | undefined {
    return missions.get(runId);
  },
};

const resumeQueues = new Map<string, Promise<unknown>>();

const WORKFLOW_KEY = "comurosMission";

/**
 * Resume a suspended mission run with a wake payload.
 *
 * Webhooks can fire while the run is mid-execution (not yet re-suspended), so
 * this (a) serializes resumes per run and (b) polls until the run snapshot
 * reports `suspended` before resuming. Terminal runs are skipped, not errors:
 * the fleet may report completion of a task that a replan already superseded.
 */
export function resumeMission(
  mastra: Mastra,
  runId: string,
  resumeData: Wake,
): Promise<{ skipped: boolean; status: string }> {
  const prev = resumeQueues.get(runId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const workflow = mastra.getWorkflow(WORKFLOW_KEY);
      let status = "unknown";
      for (let attempt = 0; attempt < 40; attempt++) {
        const snapshot = await workflow.getWorkflowRunById(runId);
        if (!snapshot) throw new Error(`unknown run ${runId}`);
        status = snapshot.status;
        if (status === "suspended") break;
        if (status === "success" || status === "failed" || status === "canceled") {
          return { skipped: true, status };
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 500);
        await promise;
      }
      if (status !== "suspended") {
        throw new Error(`run ${runId} never suspended (last status: ${status})`);
      }
      const run = await workflow.createRun({ runId });
      const result = await run.resume({ resumeData });
      return { skipped: false, status: result.status };
    });
  resumeQueues.set(runId, next);
  return next;
}
