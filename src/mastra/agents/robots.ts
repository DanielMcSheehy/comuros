import { Agent } from "@mastra/core/agent";
import { scenario, type RobotSpec } from "../config/scenario";

/**
 * Robot Brain (§III-B): each robot runs a local LLM that decomposes the
 * high-level command from the Task Manager and composes ready-to-run Python
 * from its primitive skill library (ROS2 nodes / policies).
 *
 * Robots are agnostic to whether tasks are sequential or independent; each
 * processes one high-level command at a time.
 */

export const ROBOT_MODEL = process.env.COMUROS_ROBOT_MODEL ?? process.env.COMUROS_MODEL ?? "openai/gpt-4o";

function makeRobotAgent(spec: RobotSpec): Agent {
  const skills = spec.skills
    .map((s) => `- ${s.signature}\n  ${s.description}`)
    .join("\n");
  return new Agent({
    id: `robot-${spec.id}`,
    name: spec.name,
    description: `${spec.name} (${spec.id}): ${spec.morphology} Capabilities: ${spec.capabilities.join("; ")}. Delegate a high-level physical task and it returns executable Python composed from its primitive skills.`,
    model: ROBOT_MODEL,
    instructions: `You are the onboard LLM ("robot brain") of the robot "${spec.name}" (id: ${spec.id}).

MORPHOLOGY: ${spec.morphology}
CAPABILITIES: ${spec.capabilities.join("; ")}
CONSTRAINTS: ${spec.constraints.join("; ")}

PRIMITIVE SKILL LIBRARY (the ONLY functions you may call):
${skills}

Given one high-level task in natural language from the Task Manager:
1. Decompose it into a sequence of primitive skill calls.
2. Emit ready-to-run Python that composes ONLY the functions above. No imports, no function definitions, no invented APIs.
3. The program MUST call update_task_status("COMPLETED", ...) as its final action, and use update_robot_status(...) whenever your physical state changes (e.g. after sit(), after reaching a coordinate).
4. If the task violates your constraints, do not fake it: emit a single update_task_status("INTERRUPTED", "<why>") call.

You handle exactly one command at a time. Be literal and minimal.`,
  });
}

/** One sub-agent per robot in the scenario config, keyed for Mastra registration. */
export const robotAgents: Record<string, Agent> = Object.fromEntries(
  scenario.robots.map((spec) => [`robot-${spec.id}`, makeRobotAgent(spec)]),
);
