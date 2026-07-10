import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { taskManager } from "./agents/task-manager";
import { robotAgents } from "./agents/robots";
import { eventClassifier } from "./agents/event-classifier";
import { comurosMission } from "./workflows/mission";
import { apiRoutes } from "./server/routes";

/**
 * CoMuRoS on Mastra (arXiv:2511.22354).
 *
 * Storage is required: suspended mission snapshots must survive between the
 * suspend at dispatch time and the webhook-driven resume.
 */
export const mastra = new Mastra({
  agents: { taskManager, eventClassifier, ...robotAgents },
  workflows: { comurosMission },
  storage: new LibSQLStore({
    id: "comuros-storage",
    url: "file:./comuros.db",
  }),
  server: {
    port: Number(process.env.COMUROS_PORT ?? 4113),
    apiRoutes,
  },
});
