# Observability

The `@agent-loop/core` observability layer persists workflow events, runs,
sessions, rollups, and harness session snapshots to a queryable store. It is
built from small, composable pieces so you can use only what you need.

## Quick start

```ts
import { Orchestrator, defineWorkflow, createObservationStore, ObservationCollector, ObservationClient } from "@agent-loop/core";
import { PiHarness } from "@agent-loop/harness-pi";

const store = createObservationStore({ type: "jsonl", baseDir: ".checkpoints/observations" });
const collector = new ObservationCollector(store, { harnesses: [new PiHarness()] });
const client = new ObservationClient(store);

const orchestrator = new Orchestrator({
  harnesses: [new PiHarness()],
  onEvent: (event) => collector.onEvent(event),
});

const workflow = defineWorkflow({
  id: "jira-to-mr",
  goal: "Implement AC-123",
  sessions: [
    { id: "coder", role: "coder", harness: "pi" },
    { id: "reviewer", role: "reviewer", harness: "pi" },
  ],
  transitions: [
    { from: "start", to: "coder", input: "Implement the feature." },
    { from: "coder", to: "reviewer", input: "Review the implementation." },
  ],
  constraints: { maxIterations: 10 },
  exitConditions: { goalMet: (state) => state.context.approved === true },
});

const state = await orchestrator.start(workflow);

// Query the store after the run.
const runs = await client.getRuns({ workflowId: "jira-to-mr", limit: 10 });
const sessions = await client.getSessions({ runId: state.id });
const successRate = await client.getSuccessRate({ workflowId: "jira-to-mr" });

// Recall a session in the harness.
const ref = await client.getSessionRef(state.id, "coder");
const harness = new PiHarness();
const session = await harness.resumeSession!(ref);
await session.prompt("Continue from where we left off.");
```

## Storage adapters

- `jsonl` (default): append-friendly files, no dependencies. Best for local
  development and low-volume deployments.
- `sqlite`: single SQLite file with indexed tables. Requires `better-sqlite3` to
  be installed. Best for production and dashboards.
- `memory`: in-memory store for tests and short-lived usage.

## Collector

`ObservationCollector` bridges orchestrator events to the store. Pass it as the
orchestrator's `onEvent` callback. It maintains denormalized runs, sessions, and
rollups as events stream in, and can export harness session snapshots when the
harness adapter supports `exportSession`.

Call `collector.reindex()` to rebuild derived records from the raw event stream.

## Query client

`ObservationClient` wraps the store with convenience methods such as
`getSuccessRate`, `getTotalSpend`, and `getAverageDuration`.

## Per-session output summarization

A `SessionSpec` can set `summarizeOutput: true` to ask the session to summarize
its own output after each turn. The summary is stored as
`state.sessions[sessionId].lastSummary` and in the observation store as
`SessionRecord.lastSummary`. This is useful when the next transition only needs
a compact digest instead of the full session output.

```ts
const workflow = defineWorkflow({
  id: "review-loop",
  goal: "Review a code change",
  sessions: [
    {
      id: "reviewer",
      role: "reviewer",
      harness: "pi",
      summarizeOutput: true,
      summaryPrompt: "Summarize your review in one paragraph and end with VERDICT: APPROVED or VERDICT: REJECTED.",
    },
  ],
  transitions: [
    {
      from: "start",
      to: "reviewer",
      input: "Review this change.",
    },
  ],
  constraints: { maxIterations: 10 },
  exitConditions: {
    goalMet: (state) => /APPROVED/i.test(state.sessions.reviewer.lastSummary ?? ""),
  },
});
```

When summarization is enabled, the orchestrator emits a `turn.summarized`
event after the main turn. The `ObservationCollector` aggregates the summary
prompt's cost, duration, and tokens into the session and run totals without
incrementing the turn count.

## Session recall and snapshots

Harness sessions can expose a lightweight `HarnessSessionRef` via
`session.getRef()`. The store keeps that ref so consumers can resume the session
later through `AgentHarness.resumeSession()`.

For dashboard viewing, the collector caches session snapshots produced by
`AgentHarness.exportSession()`. Retrieve them with
`client.getSessionSnapshot(runId, sessionId)`.
