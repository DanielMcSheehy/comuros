import type { Mastra } from "@mastra/core";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  CycleIOSchema,
  MissionPlanSchema,
  MissionStateSchema,
  RobotCodePlanSchema,
  WakeSchema,
  type ChatEntry,
  type MissionPlan,
  type MissionState,
  type TaskStatus,
  type Wake,
} from "../schemas";
import { missionRegistry } from "../lib/registry";
import { dispatchToFleet } from "../lib/fleet-client";

/**
 * CoMuRoS mission workflow: centralized deliberation (plan/replan steps call
 * the Task Manager LLM with structured output) + decentralized execution
 * (robot sub-agents compose Python, the fleet runs it) + event-driven
 * replanning (the supervise cycle suspends until a webhook resumes it with a
 * status report, a relevant event, or anytime user input).
 */

function chatEntry(role: ChatEntry["role"], speaker: string, content: string): ChatEntry {
  return { role, speaker, content, at: new Date().toISOString() };
}

function formatPlan(plan: MissionPlan, label: string): string {
  if (plan.classification === "infeasible") {
    return `${label}: INFEASIBLE — ${plan.infeasibleReason ?? plan.reasoning}`;
  }
  const tasks = plan.subtasks
    .map(
      (t) =>
        `  [${t.id}] ${t.assignee}: ${t.instruction}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`,
    )
    .join("\n");
  return `${label} (${plan.classification}): ${plan.reasoning}\n${tasks}`;
}

function renderDynamicContext(state: MissionState): string {
  const statuses = state.subtasks
    .map((t) => `  [${t.id}] ${t.assignee} — ${state.taskStatuses[t.id] ?? "PENDING"} — ${t.instruction}`)
    .join("\n");
  const robots = Object.entries(state.robotStatuses)
    .map(([id, s]) => `  ${id}: ${s}`)
    .join("\n");
  const transcript = state.chat
    .map((c) => `  [${c.role}] ${c.speaker}: ${c.content}`)
    .join("\n");
  return `USER GOAL: ${state.command}

CURRENT TASK STATUSES:
${statuses || "  (none)"}

ROBOT STATUSES:
${robots || "  (unknown)"}

CHAT HISTORY (temporal order):
${transcript}`;
}

function publish(runId: string, state: MissionState): void {
  missionRegistry.upsert(runId, {
    command: state.command,
    classification: state.classification,
    subtasks: state.subtasks,
    taskStatuses: state.taskStatuses,
    robotStatuses: state.robotStatuses,
    chat: state.chat,
    replanCount: state.replanCount,
  });
}

/**
 * Replanning (§III-A): only non-COMPLETED tasks are reconsidered. The merged
 * plan keeps completed subtasks for the record, keeps identical IN_PROGRESS
 * subtasks running (no double dispatch), and re-dispatches everything else.
 */
async function replan(
  mastra: Mastra,
  state: MissionState,
  trigger: string,
): Promise<MissionState> {
  const taskManager = mastra.getAgent("taskManager");
  const prompt = `REPLANNING REQUEST.

${renderDynamicContext(state)}

TRIGGER:
${trigger}

Follow the REPLANNING PROCEDURE from your instructions. Output the full plan for all remaining (non-COMPLETED) work.`;
  const response = await taskManager.generate(prompt, {
    structuredOutput: { schema: MissionPlanSchema },
  });
  const plan = response.object;

  const completed = state.subtasks.filter((t) => state.taskStatuses[t.id] === "COMPLETED");
  const completedIds = new Set(completed.map((t) => t.id));
  const fresh = plan.subtasks.filter((t) => !completedIds.has(t.id));

  const taskStatuses: Record<string, TaskStatus> = {};
  for (const t of completed) taskStatuses[t.id] = "COMPLETED";
  for (const t of fresh) {
    const old = state.subtasks.find((s) => s.id === t.id);
    const keepRunning =
      old !== undefined &&
      state.taskStatuses[t.id] === "IN_PROGRESS" &&
      old.assignee === t.assignee;
    taskStatuses[t.id] = keepRunning ? "IN_PROGRESS" : "PENDING";
  }

  return {
    ...state,
    classification: plan.classification,
    subtasks: [...completed, ...fresh],
    taskStatuses,
    replanCount: state.replanCount + 1,
    chat: [
      ...state.chat,
      chatEntry("task_manager", "Task Manager", formatPlan(plan, `Replan #${state.replanCount + 1}`)),
    ],
  };
}

/** Fold a wake payload (status / relevant event / user input) into mission state. */
async function handleWake(
  mastra: Mastra,
  state: MissionState,
  wake: Wake,
): Promise<MissionState> {
  switch (wake.kind) {
    case "status": {
      const known = state.subtasks.some((t) => t.id === wake.taskId);
      const already = state.taskStatuses[wake.taskId];
      let next: MissionState = {
        ...state,
        chat: [
          ...state.chat,
          chatEntry(
            "robot",
            wake.robotId,
            `task ${wake.taskId} -> ${wake.status}${wake.note ? ` (${wake.note})` : ""}`,
          ),
        ],
      };
      if (wake.robotStatus) {
        next = {
          ...next,
          robotStatuses: { ...next.robotStatuses, [wake.robotId]: wake.robotStatus },
        };
      }
      // Ignore reports for superseded tasks and never regress a COMPLETED task.
      if (known && already !== "COMPLETED") {
        next = {
          ...next,
          taskStatuses: { ...next.taskStatuses, [wake.taskId]: wake.status },
        };
      }
      return next;
    }
    case "event": {
      const withEvent: MissionState = {
        ...state,
        chat: [
          ...state.chat,
          chatEntry("event", wake.robotId, `RELEVANT EVENT: ${wake.description}`),
        ],
      };
      return replan(
        mastra,
        withEvent,
        `Robot ${wake.robotId} reported a relevant event: ${wake.description}`,
      );
    }
    case "user": {
      const withMsg: MissionState = {
        ...state,
        chat: [...state.chat, chatEntry("user", "user", wake.message)],
      };
      // A user report scoped to one task (e.g. a human finishing an assigned
      // subtask) is a status update, not an intent change: no replan.
      if (wake.taskId && wake.status) {
        if (withMsg.taskStatuses[wake.taskId] === "COMPLETED") return withMsg;
        return {
          ...withMsg,
          taskStatuses: { ...withMsg.taskStatuses, [wake.taskId]: wake.status },
        };
      }
      return replan(mastra, withMsg, `User input (possible intent change): ${wake.message}`);
    }
  }
}

const planMission = createStep({
  id: "plan-mission",
  description: "Task Manager LLM interprets the goal, classifies it, and allocates subtasks.",
  inputSchema: z.object({ command: z.string() }),
  outputSchema: CycleIOSchema,
  stateSchema: MissionStateSchema,
  execute: async ({ inputData, state, setState, mastra, runId }) => {
    const taskManager = mastra.getAgent("taskManager");
    const response = await taskManager.generate(
      `USER GOAL: ${inputData.command}\n\nClassify the goal and allocate subtasks per your instructions.`,
      { structuredOutput: { schema: MissionPlanSchema } },
    );
    const plan = response.object;

    const chat: ChatEntry[] = [
      chatEntry("user", "user", inputData.command),
      chatEntry("task_manager", "Task Manager", formatPlan(plan, "Plan")),
    ];
    const infeasible = plan.classification === "infeasible";
    const subtasks = infeasible ? [] : plan.subtasks;
    const next: MissionState = {
      ...state,
      command: inputData.command,
      classification: plan.classification,
      subtasks,
      taskStatuses: Object.fromEntries(subtasks.map((t) => [t.id, "PENDING" as const])),
      robotStatuses: state.robotStatuses ?? {},
      chat,
      replanCount: 0,
    };
    await setState(next);
    publish(runId, next);
    return {
      done: infeasible,
      note: infeasible
        ? `infeasible: ${plan.infeasibleReason ?? plan.reasoning}`
        : `planned ${subtasks.length} subtasks (${plan.classification})`,
    };
  },
});

const superviseCycle = createStep({
  id: "supervise-cycle",
  description:
    "Dispatch ready subtasks to robot brains, then suspend until a status report, relevant event, or user input resumes the run.",
  inputSchema: CycleIOSchema,
  outputSchema: CycleIOSchema,
  resumeSchema: WakeSchema,
  suspendSchema: z.object({ waitingOn: z.array(z.string()) }),
  stateSchema: MissionStateSchema,
  execute: async ({ inputData, state, setState, resumeData, suspend, mastra, runId }) => {
    if (inputData.done) return inputData;

    let st: MissionState = state;
    if (resumeData) {
      st = await handleWake(mastra, st, resumeData);
      await setState(st);
      publish(runId, st);
    }

    const statusOf = (id: string) => st.taskStatuses[id] ?? "PENDING";
    const allCompleted = () => st.subtasks.every((t) => statusOf(t.id) === "COMPLETED");

    if (allCompleted()) {
      return { done: true, note: `all ${st.subtasks.length} subtasks COMPLETED` };
    }

    // Dispatch every subtask whose dependencies are COMPLETED. Failure-driven
    // safety net: if nothing is running and nothing is dispatchable (e.g. an
    // INTERRUPTED task blocks the frontier and no event arrived), replan.
    for (let round = 0; round < 2; round++) {
      const ready = st.subtasks.filter(
        (t) => statusOf(t.id) === "PENDING" && t.dependsOn.every((d) => statusOf(d) === "COMPLETED"),
      );
      const running = st.subtasks.filter((t) => statusOf(t.id) === "IN_PROGRESS");
      if (ready.length > 0 || running.length > 0 || allCompleted()) break;
      if (round === 1) {
        return { done: true, note: `halted: no runnable subtasks (${JSON.stringify(st.taskStatuses)})` };
      }
      st = await replan(
        mastra,
        st,
        "No subtask is runnable: at least one task is INTERRUPTED or blocked by an incomplete dependency, and nothing is in progress. Produce a recovery plan.",
      );
      await setState(st);
      publish(runId, st);
    }

    for (const task of st.subtasks) {
      if (statusOf(task.id) !== "PENDING") continue;
      if (!task.dependsOn.every((d) => statusOf(d) === "COMPLETED")) continue;

      if (task.assignee === "human") {
        st = {
          ...st,
          taskStatuses: { ...st.taskStatuses, [task.id]: "IN_PROGRESS" },
          chat: [
            ...st.chat,
            chatEntry(
              "task_manager",
              "Task Manager",
              `@human: please "${task.instruction}" and confirm via POST /webhooks/user {taskId: "${task.id}", status: "COMPLETED"}`,
            ),
          ],
        };
        continue;
      }

      const robot = mastra.getAgent(`robot-${task.assignee}`);
      const response = await robot.generate(
        `TASK FROM TASK MANAGER: ${task.instruction}\n\nCompose the Python program for this task from your primitive skill library.`,
        { structuredOutput: { schema: RobotCodePlanSchema } },
      );
      const codePlan = response.object;
      st = {
        ...st,
        taskStatuses: { ...st.taskStatuses, [task.id]: "IN_PROGRESS" },
        chat: [
          ...st.chat,
          chatEntry(
            "robot",
            task.assignee,
            `executing [${task.id}] using ${codePlan.functionsUsed.join(", ")}:\n${codePlan.code}`,
          ),
        ],
      };
      await dispatchToFleet({
        runId,
        robotId: task.assignee,
        taskId: task.id,
        instruction: task.instruction,
        code: codePlan.code,
      });
    }

    await setState(st);
    publish(runId, st);

    if (allCompleted()) {
      return { done: true, note: `all ${st.subtasks.length} subtasks COMPLETED` };
    }
    const waitingOn = st.subtasks
      .filter((t) => statusOf(t.id) === "IN_PROGRESS")
      .map((t) => t.id);
    return await suspend({ waitingOn });
  },
});

const missionReport = createStep({
  id: "mission-report",
  description: "Render the color-codable chat transcript and final statuses.",
  inputSchema: CycleIOSchema,
  outputSchema: z.object({ report: z.string() }),
  stateSchema: MissionStateSchema,
  execute: async ({ inputData, state }) => {
    const transcript = state.chat
      .map((c) => `[${c.at}] (${c.role}) ${c.speaker}: ${c.content}`)
      .join("\n");
    const statuses = state.subtasks
      .map((t) => `  [${t.id}] ${t.assignee}: ${state.taskStatuses[t.id]}`)
      .join("\n");
    return {
      report: `MISSION ${inputData.done ? "FINISHED" : "INCOMPLETE"}: ${inputData.note}
Classification: ${state.classification} | Replans: ${state.replanCount}
Subtasks:
${statuses || "  (none)"}

Transcript:
${transcript}`,
    };
  },
});

export const comurosMission = createWorkflow({
  id: "comuros-mission",
  description:
    "CoMuRoS: hierarchical task planning with event-driven replanning for a heterogeneous robot team.",
  inputSchema: z.object({ command: z.string() }),
  outputSchema: z.object({ report: z.string() }),
  stateSchema: MissionStateSchema,
})
  .then(planMission)
  .dountil(superviseCycle, async ({ inputData }) => inputData.done === true)
  .then(missionReport)
  .commit();
