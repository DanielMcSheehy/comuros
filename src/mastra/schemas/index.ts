import { z } from "zod";

/**
 * CoMuRoS schemas (arXiv:2511.22354).
 *
 * The paper's four-way task classification (§I) is the structured-output
 * contract of the Task Manager LLM. Task status (§III-A) is exactly the
 * paper's three values plus PENDING for not-yet-dispatched subtasks.
 */

export const TaskClassificationSchema = z
  .enum(["independent", "sequential", "coordinated", "infeasible"])
  .describe(
    "independent: parallel without cooperation; sequential: successive subtask execution; coordinated: tightly coupled motion; infeasible: beyond system capabilities",
  );
export type TaskClassification = z.infer<typeof TaskClassificationSchema>;

export const TaskStatusSchema = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "INTERRUPTED",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const SubtaskSchema = z.object({
  id: z
    .string()
    .describe("short kebab-case id, unique within the plan, e.g. 'go2-carry-green'"),
  assignee: z
    .string()
    .describe("robot id from the scenario config, or 'human' when no robot is capable"),
  instruction: z
    .string()
    .describe("natural-language high-level command for the assignee's local LLM"),
  dependsOn: z
    .array(z.string())
    .describe(
      "subtask ids that must be COMPLETED before this one starts; empty for immediate start",
    ),
});
export type Subtask = z.infer<typeof SubtaskSchema>;

export const MissionPlanSchema = z.object({
  classification: TaskClassificationSchema,
  reasoning: z
    .string()
    .describe("why this classification and allocation respect capabilities, morphologies, and scenario rules"),
  subtasks: z
    .array(SubtaskSchema)
    .describe("empty when classification is 'infeasible'"),
  infeasibleReason: z
    .string()
    .nullable()
    .describe("set only when classification is 'infeasible', otherwise null"),
});
export type MissionPlan = z.infer<typeof MissionPlanSchema>;

/** Robot Brain output (§III-B): Python composed from the primitive skill library. */
export const RobotCodePlanSchema = z.object({
  explanation: z.string().describe("one-paragraph plan for the task"),
  functionsUsed: z
    .array(z.string())
    .describe("names of primitive functions used, drawn only from the robot's skill library"),
  code: z
    .string()
    .describe("ready-to-run Python composing only the robot's primitive functions"),
});
export type RobotCodePlan = z.infer<typeof RobotCodePlanSchema>;

/** Decentralized event filtering (§III-B): relevant events reach the Task Manager. */
export const EventRelevanceSchema = z.object({
  relevant: z
    .boolean()
    .describe("true only if the event affects the team's task progress"),
  reasoning: z.string(),
});
export type EventRelevance = z.infer<typeof EventRelevanceSchema>;

/** Chat interface entry (§III-C): color-coded, temporally ordered, preserved for replanning context. */
export const ChatEntrySchema = z.object({
  role: z.enum(["user", "task_manager", "robot", "event"]),
  speaker: z.string(),
  content: z.string(),
  at: z.string(),
});
export type ChatEntry = z.infer<typeof ChatEntrySchema>;

/** Shared workflow state: the Task Manager's dynamic context. */
export const MissionStateSchema = z.object({
  command: z.string(),
  classification: TaskClassificationSchema.nullable(),
  subtasks: z.array(SubtaskSchema),
  taskStatuses: z.record(z.string(), TaskStatusSchema),
  robotStatuses: z.record(z.string(), z.string()),
  chat: z.array(ChatEntrySchema),
  replanCount: z.number(),
});
export type MissionState = z.infer<typeof MissionStateSchema>;

/** What wakes a suspended mission: robot status report, relevant event, or anytime user input. */
export const WakeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    robotId: z.string(),
    taskId: z.string(),
    status: TaskStatusSchema,
    robotStatus: z.string().optional(),
    note: z.string().optional(),
  }),
  z.object({
    kind: z.literal("event"),
    robotId: z.string(),
    description: z.string(),
    reasoning: z.string().optional(),
  }),
  z.object({
    kind: z.literal("user"),
    message: z.string(),
    taskId: z.string().optional(),
    status: TaskStatusSchema.optional(),
  }),
]);
export type Wake = z.infer<typeof WakeSchema>;

export const CycleIOSchema = z.object({
  done: z.boolean(),
  note: z.string(),
});
export type CycleIO = z.infer<typeof CycleIOSchema>;

export const initialMissionState: MissionState = {
  command: "",
  classification: null,
  subtasks: [],
  taskStatuses: {},
  robotStatuses: {},
  chat: [],
  replanCount: 0,
};
