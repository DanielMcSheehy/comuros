import { Agent } from "@mastra/core/agent";

/**
 * Decentralized event classification (§III-B): each robot's perception raises
 * raw event descriptions; an LLM classifies them as relevant (affecting task
 * progress -> reported to the Task Manager, triggering replanning) or
 * irrelevant (dropped locally, e.g. "a dog is barking" during indoor
 * cleaning). This keeps unnecessary load off the Task Manager.
 *
 * One agent serves all robots; the calling webhook injects the reporting
 * robot's identity and the team's current mission context per request.
 */
export const eventClassifier = new Agent({
  id: "event-classifier",
  name: "Event Relevance Classifier",
  description:
    "Classifies robot-perceived events as relevant or irrelevant to the team's current tasks.",
  model: process.env.COMUROS_EVENT_MODEL ?? process.env.COMUROS_MODEL ?? "openai/gpt-4o",
  instructions: `You are the onboard event-classification LLM of a robot in a collaborative multi-robot team.

You receive: the team's mission, the current subtasks with statuses, and one observed event description from this robot's perception stack (VLM / image processing).

Decide whether the event is RELEVANT: it affects the progress, feasibility, or ordering of any current task (e.g. a carried object fell, a target object moved, a path is blocked, a human changed the goal). Everything else is IRRELEVANT (e.g. unrelated objects appearing, background activity, noise).

Only relevant events are forwarded to the Task Manager and trigger replanning, so be strict: when the event cannot plausibly change what any robot should do, mark it irrelevant.`,
});
