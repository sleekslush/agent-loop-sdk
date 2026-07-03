import { defineWorkflow, Orchestrator } from "@agent-loop/core";
import { PiHarness } from "@agent-loop/harness-pi";

const workflow = defineWorkflow({
  id: "jira-to-mr",
  goal: "Read a ticket summary, draft an implementation plan, and review it",
  sessions: [
    { id: "reader", role: "ticket-reader", harness: "pi", model: "claude-sonnet-4-20250514" },
    { id: "planner", role: "implementer", harness: "pi", model: "claude-sonnet-4-20250514" },
    { id: "reviewer", role: "reviewer", harness: "pi", model: "claude-sonnet-4-20250514" },
  ],
  transitions: [
    {
      from: "start",
      to: "reader",
      input: "Summarize the Jira ticket AC-123: build a login form.",
    },
    {
      from: "reader",
      to: "planner",
      input: (state) => `Draft an implementation plan for:\n${state.sessions.reader.lastOutput}`,
    },
    {
      from: "planner",
      to: "reviewer",
      input: (state) => `Review this plan:\n${state.sessions.planner.lastOutput}`,
    },
  ],
  constraints: {
    maxIterations: 10,
    maxSpendUsd: 2.0,
  },
  exitConditions: {
    goalMet: (state) => state.currentSessionId === "reviewer" && state.iteration >= 3,
  },
});

const orchestrator = new Orchestrator({
  harnesses: [new PiHarness()],
  onEvent: (event) => console.log("[event]", event.type),
});

// In a real app, this would be triggered by a webhook or cron job.
orchestrator
  .start(workflow)
  .then((state) => {
    console.log("Workflow finished:", state.outcome);
    console.log("Final context:", state.context);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
