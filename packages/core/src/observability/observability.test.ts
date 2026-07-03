import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  AgentHarness,
  HarnessSession,
  OrchestratorEvent,
  SessionConfig,
  SessionTurnResult,
  Workflow,
} from "../types.js";
import { Orchestrator, defineWorkflow } from "../engine.js";
import { createFileCheckpointStore } from "../checkpoint.js";
import {
  createObservationStore,
  MemoryObservationStore,
  JsonlObservationStore,
  ObservationCollector,
  ObservationClient,
} from "./index.js";
import type { ObservationStore, Run, SessionRecord } from "./types.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    workflowId: "wf-1",
    goal: "test goal",
    status: "completed",
    outcome: "success",
    startedAt: new Date("2024-07-15T10:00:00Z"),
    iterationCount: 3,
    totalCostUsd: 0.03,
    triggerSource: "test",
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: `${overrides.runId ?? "run-1"}:${overrides.sessionId ?? "coder"}`,
    runId: overrides.runId ?? "run-1",
    workflowId: overrides.workflowId ?? "wf-1",
    sessionId: overrides.sessionId ?? "coder",
    role: overrides.role ?? "coder",
    harness: overrides.harness ?? "mock",
    turnCount: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  };
}

async function runStoreSmokeTest(store: ObservationStore): Promise<void> {
  const run = makeRun({ id: "run-1", workflowId: "wf-1", status: "running" });
  await store.upsertRun(run);

  const got = await store.getRun(run.id);
  assert.equal(got?.id, run.id);
  assert.equal(got?.status, "running");

  run.status = "completed";
  run.outcome = "success";
  run.endedAt = new Date();
  run.durationMs = 1000;
  await store.upsertRun(run);
  const updated = await store.getRun(run.id);
  assert.equal(updated?.status, "completed");
  assert.equal(updated?.outcome, "success");

  const session = makeSession({ runId: run.id, sessionId: "coder", role: "coder" });
  await store.upsertSession(session);
  const sessions = await store.querySessions({ runId: run.id });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.sessionId, "coder");

  await store.storeSessionSnapshot({
    runId: run.id,
    sessionId: "coder",
    harness: "mock",
    exportedAt: new Date(),
    format: "jsonl",
    content: "snapshot content",
  });
  const snapshot = await store.getSessionSnapshot(run.id, "coder");
  assert.equal(snapshot?.content, "snapshot content");

  await store.appendEvent({
    id: randomUUID(),
    runId: run.id,
    workflowId: run.workflowId,
    type: "turn.completed",
    timestamp: new Date(),
    payload: { sessionId: "coder" },
  });
  const events = await store.queryEvents({ runId: run.id });
  assert.equal(events.length, 1);

  await store.upsertWorkflowRollup({
    workflowId: "wf-1",
    period: "2024-07",
    runs: 1,
    successCount: 1,
    failureCount: 0,
    pauseCount: 0,
    totalCostUsd: 0.03,
    totalDurationMs: 1000,
    totalIterations: 3,
  });
  const wfRollups = await store.queryWorkflowRollups({ workflowId: "wf-1" });
  assert.equal(wfRollups.length, 1);

  await store.upsertRoleRollup({
    workflowId: "wf-1",
    role: "coder",
    period: "2024-07",
    runs: 1,
    turnCount: 3,
    totalCostUsd: 0.03,
    totalDurationMs: 1000,
  });
  const roleRollups = await store.queryRoleRollups({ workflowId: "wf-1", role: "coder" });
  assert.equal(roleRollups.length, 1);
}

describe("MemoryObservationStore", () => {
  it("passes the smoke test", async () => {
    const store = new MemoryObservationStore();
    await runStoreSmokeTest(store);
  });
});

describe("JsonlObservationStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `agent-loop-jsonl-test-${randomUUID()}`);
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("passes the smoke test", async () => {
    const store = new JsonlObservationStore({ baseDir });
    await runStoreSmokeTest(store);
  });

  it("survives reopening", async () => {
    const run = makeRun({ id: "run-2" });
    const store1 = new JsonlObservationStore({ baseDir });
    await store1.upsertRun(run);

    const store2 = new JsonlObservationStore({ baseDir });
    const got = await store2.getRun(run.id);
    assert.equal(got?.id, run.id);
  });
});

describe("ObservationCollector", () => {
  let store: MemoryObservationStore;
  let collector: ObservationCollector;

  beforeEach(() => {
    store = new MemoryObservationStore();
    collector = new ObservationCollector(store);
  });

  it("builds a run and session from events", async () => {
    const runId = randomUUID();
    const workflowId = "wf-test";
    const constraints = { maxIterations: 10 };

    await collector.onEvent({
      type: "workflow.started",
      runId,
      workflowId,
      stateId: runId,
      goal: "test goal",
      triggerSource: "manual",
      constraints,
    });

    await collector.onEvent({
      type: "session.created",
      runId,
      sessionId: "coder",
      role: "coder",
      harness: "mock",
      model: "mock/model",
      harnessSessionRef: { harness: "mock", sessionId: "s1" },
    });

    await collector.onEvent({
      type: "turn.completed",
      runId,
      sessionId: "coder",
      role: "coder",
      iteration: 1,
      durationMs: 100,
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 20,
    });

    await collector.onEvent({
      type: "workflow.completed",
      runId,
      workflowId,
      stateId: runId,
      outcome: "success",
      iteration: 1,
      spendUsd: 0.01,
      durationMs: 100,
    });

    const run = await store.getRun(runId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.outcome, "success");
    assert.equal(run?.iterationCount, 1);
    assert.equal(run?.totalCostUsd, 0.01);

    const sessions = await store.querySessions({ runId });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.turnCount, 1);
    assert.equal(sessions[0]?.totalInputTokens, 10);
    assert.equal(sessions[0]?.totalOutputTokens, 20);
    assert.deepEqual(sessions[0]?.harnessSessionRef, { harness: "mock", sessionId: "s1" });

    const wfRollups = await store.queryWorkflowRollups({ workflowId });
    assert.equal(wfRollups.length, 1);
    assert.equal(wfRollups[0]?.runs, 1);
    assert.equal(wfRollups[0]?.successCount, 1);

    const roleRollups = await store.queryRoleRollups({ workflowId, role: "coder" });
    assert.equal(roleRollups.length, 1);
    assert.equal(roleRollups[0]?.turnCount, 1);
  });

  it("exports snapshots when harnesses are provided", async () => {
    const runId = randomUUID();
    const harness: AgentHarness = {
      name: "mock",
      async createSession() {
        throw new Error("not used");
      },
      async exportSession() {
        return "exported content";
      },
    };

    collector = new ObservationCollector(store, { harnesses: [harness] });

    await collector.onEvent({
      type: "workflow.started",
      runId,
      workflowId: "wf-snap",
      stateId: runId,
      goal: "snapshot test",
      triggerSource: "manual",
      constraints: { maxIterations: 10 },
    });

    await collector.onEvent({
      type: "session.created",
      runId,
      sessionId: "coder",
      role: "coder",
      harness: "mock",
      harnessSessionRef: { harness: "mock", sessionId: "s1" },
    });

    await collector.onEvent({
      type: "workflow.completed",
      runId,
      workflowId: "wf-snap",
      stateId: runId,
      outcome: "success",
      iteration: 0,
      spendUsd: 0,
      durationMs: 0,
    });

    const snapshot = await store.getSessionSnapshot(runId, "coder");
    assert.equal(snapshot?.content, "exported content");
  });

  it("rebuilds derived records from events", async () => {
    const runId = randomUUID();
    const workflowId = "wf-reindex";

    await collector.onEvent({
      type: "workflow.started",
      runId,
      workflowId,
      stateId: runId,
      goal: "reindex test",
      triggerSource: "manual",
      constraints: { maxIterations: 10 },
    });

    await collector.onEvent({
      type: "session.created",
      runId,
      sessionId: "coder",
      role: "coder",
      harness: "mock",
    });

    await collector.onEvent({
      type: "turn.completed",
      runId,
      sessionId: "coder",
      role: "coder",
      iteration: 1,
      durationMs: 100,
      costUsd: 0.01,
      inputTokens: 5,
      outputTokens: 5,
    });

    await collector.onEvent({
      type: "workflow.completed",
      runId,
      workflowId,
      stateId: runId,
      outcome: "failure",
      iteration: 1,
      spendUsd: 0.01,
      durationMs: 100,
    });

    // Corrupt the in-memory derived records to ensure reindex rebuilds from events.
    await store.upsertRun({ ...(await store.getRun(runId)!), totalCostUsd: 999 } as Run);

    const freshCollector = new ObservationCollector(store);
    await freshCollector.reindex();

    const run = await store.getRun(runId);
    assert.equal(run?.totalCostUsd, 0.01);
    assert.equal(run?.outcome, "failure");
  });
});

describe("ObservationClient", () => {
  let store: MemoryObservationStore;
  let client: ObservationClient;

  beforeEach(() => {
    store = new MemoryObservationStore();
    client = new ObservationClient(store);
  });

  it("computes convenience metrics", async () => {
    await store.upsertWorkflowRollup({
      workflowId: "wf-1",
      period: "2024-07",
      runs: 4,
      successCount: 3,
      failureCount: 1,
      pauseCount: 0,
      totalCostUsd: 0.4,
      totalDurationMs: 4000,
      totalIterations: 12,
    });

    assert.equal(await client.getSuccessRate({ workflowId: "wf-1" }), 0.75);
    assert.equal(await client.getTotalSpend({ workflowId: "wf-1" }), 0.4);
    assert.equal(await client.getAverageDuration({ workflowId: "wf-1" }), 1000);
  });

  it("returns zero metrics when no rollups exist", async () => {
    assert.equal(await client.getSuccessRate({ workflowId: "missing" }), 0);
    assert.equal(await client.getTotalSpend({ workflowId: "missing" }), 0);
    assert.equal(await client.getAverageDuration({ workflowId: "missing" }), 0);
  });
});

describe("createObservationStore", () => {
  it("creates the configured store types", () => {
    assert.ok(createObservationStore({ type: "memory" }) instanceof MemoryObservationStore);
    assert.ok(createObservationStore({ type: "jsonl", baseDir: "/tmp/x" }) instanceof JsonlObservationStore);
  });
});

class MockHarnessSession implements HarnessSession {
  readonly id: string;
  readonly harness = "mock";

  constructor(id: string) {
    this.id = id;
  }

  getRef() {
    return { harness: "mock", sessionId: this.id };
  }

  async prompt(text: string): Promise<SessionTurnResult> {
    return {
      text: `response to ${text}`,
      usage: { inputTokens: 5, outputTokens: 5 },
      costUsd: 0.01,
      durationMs: 50,
      isError: false,
    };
  }

  dispose(): void {
    // no-op
  }
}

class MockHarness implements AgentHarness {
  readonly name = "mock";

  async createSession(_config: SessionConfig): Promise<HarnessSession> {
    return new MockHarnessSession("mock-session-1");
  }
}

describe("Orchestrator event enrichment", () => {
  it("emits runId, role, and token usage in events", async () => {
    const harness = new MockHarness();
    const events: OrchestratorEvent[] = [];

    const orchestrator = new Orchestrator({
      harnesses: [harness],
      checkpointStore: createFileCheckpointStore({ baseDir: join(tmpdir(), `agent-loop-events-${randomUUID()}`) }),
      onEvent: (event) => {
        events.push(event);
      },
    });

    const workflow: Workflow = defineWorkflow({
      id: "enrich",
      goal: "enrichment test",
      sessions: [{ id: "coder", role: "coder", harness: "mock" }],
      transitions: [{ from: "start", to: "coder", input: "do it" }],
      constraints: { maxIterations: 5 },
      exitConditions: {
        goalMet: (state) => state.iteration >= 1,
      },
    });

    await orchestrator.start(workflow);

    const started = events.find((e) => e.type === "workflow.started");
    assert.ok(started);
    assert.equal(started!.runId, started!.stateId);
    assert.equal(started!.goal, "enrichment test");

    const created = events.find((e) => e.type === "session.created");
    assert.ok(created);
    assert.equal(created!.role, "coder");
    assert.equal(created!.harness, "mock");
    assert.deepEqual(created!.harnessSessionRef, { harness: "mock", sessionId: "mock-session-1" });

    const turnCompleted = events.find((e) => e.type === "turn.completed");
    assert.ok(turnCompleted);
    assert.equal(turnCompleted!.role, "coder");
    assert.equal(turnCompleted!.inputTokens, 5);
    assert.equal(turnCompleted!.outputTokens, 5);

    const completed = events.find((e) => e.type === "workflow.completed");
    assert.ok(completed);
    assert.equal(completed!.outcome, "success");
    assert.equal(completed!.spendUsd, 0.01);
    assert.ok(completed!.durationMs >= 0);
  });
});
