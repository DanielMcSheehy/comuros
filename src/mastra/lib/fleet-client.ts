/**
 * Mocked actuation boundary: where the paper's robots run generated Python on
 * ROS2, we POST the composed program to a simulated fleet (sim/fleet.ts). The
 * fleet reports back through the same REST webhooks a real event-detection
 * layer would use.
 */
export interface FleetExecution {
  runId: string;
  robotId: string;
  taskId: string;
  instruction: string;
  code: string;
}

const FLEET_URL = process.env.FLEET_URL ?? "http://localhost:4222";

/**
 * Returns true when the fleet accepted the execution. When the fleet is
 * unreachable the dispatch degrades to dry-run: the task stays IN_PROGRESS
 * and can be driven manually via the status webhook (curl).
 */
export async function dispatchToFleet(exec: FleetExecution): Promise<boolean> {
  try {
    const res = await fetch(`${FLEET_URL}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exec),
    });
    return res.ok;
  } catch {
    console.warn(
      `[fleet] unreachable at ${FLEET_URL}; task ${exec.taskId} dispatched dry-run (drive it via POST /webhooks/robots/${exec.robotId}/status)`,
    );
    return false;
  }
}
