/**
 * Scenario configuration file (CoMuRoS §III-A, contribution 4).
 *
 * The architecture generalizes to new robots and scenarios by swapping this
 * config only: robot capabilities, morphologies, constraints, primitive skill
 * libraries, and scenario-specific rules. The static Task Manager prompt and
 * the mission workflow never change.
 *
 * This default scenario mirrors hardware experiment IV-A1 of the paper:
 * a Turtlebot Waffle-pi with OpenManipulator-X arm, a Turtlebot Burger,
 * and a Unitree Go2 quadruped.
 */

export interface SkillSpec {
  /** Python signature of the primitive, e.g. `find(object: str) -> Pose` */
  signature: string;
  /** What it does, inputs/outputs, when to use it. */
  description: string;
}

export interface RobotSpec {
  /** Stable id used in plans, webhooks, and agent registration. */
  id: string;
  name: string;
  morphology: string;
  capabilities: string[];
  constraints: string[];
  /** Primitive skill library (ROS2 nodes / policies) the local LLM composes from. */
  skills: SkillSpec[];
}

export interface ScenarioConfig {
  name: string;
  description: string;
  /** Scenario-specific rules the Task Manager must respect. */
  rules: string[];
  robots: RobotSpec[];
  /** Humans available for task assignment when robot capabilities are insufficient. */
  humans: string[];
}

const COMMON_STATUS_SKILLS: SkillSpec[] = [
  {
    signature: "update_task_status(status: str, note: str) -> None",
    description:
      "Report task status to the Task Manager: 'COMPLETED', 'IN_PROGRESS', or 'INTERRUPTED'. Every generated program must end by reporting COMPLETED, or INTERRUPTED with a reason on failure.",
  },
  {
    signature: "update_robot_status(descriptor: str) -> None",
    description:
      "Publish the robot's physical state descriptor, e.g. 'sitting', 'standing', 'holding green_object', or coordinates like '(3, 0)'.",
  },
];

export const scenario: ScenarioConfig = {
  name: "lab-recovery",
  description:
    "An indoor lab with a bottle on the floor, a green object that can be carried, and a goal location at (3, 0). Robots operate on a shared flat floor.",
  rules: [
    "Waffle's OpenManipulator-X arm has limited vertical reach: it can only place objects on the quadruped's back when the quadruped is SITTING, never while it is standing.",
    "Only Waffle can grasp and place objects; Burger and Go2 have no manipulator.",
    "Go2 can transport objects placed on its back.",
    "A robot executes exactly one high-level task at a time.",
    "If no robot has the capability required to recover from a failure, assign that subtask to a human.",
  ],
  robots: [
    {
      id: "waffle",
      name: "Waffle",
      morphology:
        "Turtlebot3 Waffle-pi differential-drive base with an OpenManipulator-X 4-DOF arm and gripper.",
      capabilities: [
        "indoor 2D navigation",
        "object search with onboard camera",
        "pick and place of small objects (low heights only)",
      ],
      constraints: [
        "arm cannot reach above 0.3 m: quadruped must sit for any handover",
        "can carry only one small object in the gripper",
      ],
      skills: [
        {
          signature: "find(object_name: str) -> Pose",
          description:
            "Search the environment with the onboard camera and return the pose of the named object.",
        },
        {
          signature: "reach(target: Pose | str) -> None",
          description:
            "Navigate to a pose or named object and stop next to it.",
        },
        {
          signature: "pick(object_name: str) -> None",
          description:
            "Grasp a small object at floor level with the OpenManipulator-X gripper.",
        },
        {
          signature: "place_on(target: str) -> None",
          description:
            "Place the currently held object on a named target (e.g. 'go2_back'). Fails if the target surface is above 0.3 m.",
        },
        ...COMMON_STATUS_SKILLS,
      ],
    },
    {
      id: "burger",
      name: "Burger",
      morphology: "Turtlebot3 Burger differential-drive base with camera.",
      capabilities: [
        "indoor 2D navigation",
        "visual patrol and event detection (VLM-based scene monitoring)",
      ],
      constraints: ["no manipulator", "cannot carry payloads"],
      skills: [
        {
          signature: "go_to(x: float, y: float) -> None",
          description: "Navigate to the given coordinate on the lab floor.",
        },
        {
          signature: "patrol(waypoints: list[tuple[float, float]]) -> None",
          description:
            "Loop through waypoints while the onboard VLM monitors the scene for events.",
        },
        {
          signature: "watch_scene(duration_s: float) -> None",
          description:
            "Hold position and continuously monitor the scene, raising events for anything observed.",
        },
        ...COMMON_STATUS_SKILLS,
      ],
    },
    {
      id: "go2",
      name: "Go2",
      morphology: "Unitree Go2 quadruped with a flat back payload area.",
      capabilities: [
        "indoor navigation over minor obstacles",
        "payload transport on its back",
        "sit and stand posture changes",
      ],
      constraints: [
        "no manipulator: cannot pick up dropped objects itself",
        "objects must be placed on its back by another agent",
      ],
      skills: [
        {
          signature: "go_to(x: float, y: float) -> None",
          description: "Walk to the given coordinate.",
        },
        {
          signature: "sit() -> None",
          description:
            "Sit down, lowering the back payload area below 0.3 m so Waffle's arm can reach it.",
        },
        {
          signature: "stand() -> None",
          description: "Stand up from sitting.",
        },
        {
          signature: "carry_to(x: float, y: float) -> None",
          description:
            "Transport whatever is on the back to the coordinate. Fails (INTERRUPTED) if the payload falls off.",
        },
        ...COMMON_STATUS_SKILLS,
      ],
    },
  ],
  humans: ["operator"],
};

/** Render the scenario config as the dynamic-prompt block the Task Manager consumes. */
export function renderScenario(config: ScenarioConfig = scenario): string {
  const robots = config.robots
    .map(
      (r) => `- id "${r.id}" (${r.name}): ${r.morphology}
  capabilities: ${r.capabilities.join("; ")}
  constraints: ${r.constraints.join("; ")}
  skills: ${r.skills.map((s) => s.signature).join(", ")}`,
    )
    .join("\n");
  return `SCENARIO: ${config.name}
${config.description}

ROBOTS:
${robots}

HUMANS AVAILABLE: ${config.humans.join(", ") || "none"}

SCENARIO RULES:
${config.rules.map((r) => `- ${r}`).join("\n")}`;
}
