import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryObservationStore } from "./memory-store.js";
import type { ObservationEvent, Run, SessionRecord, SessionSnapshot } from "./types.js";
import type { HarnessSessionRef } from "../types.js";

function event(runId: string, workflowId: string, type: string, payload: Record<string, unknown> = {}): ObservationEvent {
  return {
    id: `${runId}-${type}`,
    runId,
    workflowId,
    type,
    timestamp: new Date(),
    payload,
  };
}

function run(id: string, workflowId: string): Run {
  return {
    id,
    workflowId,
    goal: "test",
    status: "running",
    startedAt: new Date(),
    iterationCount: 0,
    totalCostUsd: 0,
    triggerSource: "test",
  };
}

function session(runId: string, sessionId: string, workflowId: string): SessionRecord {
  return {
    id: `${runId}:${sessionId}`,
    runId,
    workflowId,
    sessionId,
    role: "coder",
    harness: "mock",
    turnCount: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

describe("createMemoryObservationStore", () => {
  it("stores and queries events", async () => {
    const store = new MemoryObservationStore();
    await store.appendEvent(event("r1", "wf1", "workflow.started"));
    await store.appendEvent(event("r1", "wf1", "turn.completed", { sessionId: "s1" }));
    await store.appendEvent(event("r2", "wf1", "workflow.started"));

    const events = await store.queryEvents({ runId: "r1" });
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "workflow.started");
  });

  it("upserts and retrieves runs", async () => {
    const store = new MemoryObservationStore();
    await store.upsertRun(run("r1", "wf1"));
    await store.upsertRun({ ...run("r1", "wf1"), status: "completed", outcome: "success" });

    const retrieved = await store.getRun("r1");
    assert.equal(retrieved?.status, "completed");
    assert.equal(retrieved?.outcome, "success");
  });

  it("upserts and queries sessions", async () => {
    const store = new MemoryObservationStore();
    const ref: HarnessSessionRef = { harness: "mock", sessionId: "s1" };
    await store.upsertSession({ ...session("r1", "s1", "wf1"), harnessSessionRef: ref });

    const sessions = await store.querySessions({ runId: "r1" });
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].harnessSessionRef, ref);

    const retrievedRef = await store.getSessionRef("r1", "s1");
    assert.deepEqual(retrievedRef, ref);
  });

  it("stores and retrieves session snapshots", async () => {
    const store = new MemoryObservationStore();
    const snapshot: SessionSnapshot = {
      runId: "r1",
      sessionId: "s1",
      harness: "mock",
      exportedAt: new Date(),
      format: "jsonl",
      content: "{}",
    };
    await store.storeSessionSnapshot(snapshot);

    const retrieved = await store.getSessionSnapshot("r1", "s1");
    assert.equal(retrieved?.content, "{}");
  });

  it("stores and queries rollups", async () => {
    const store = new MemoryObservationStore();
    await store.upsertWorkflowRollup({
      workflowId: "wf1",
      period: "2024-07",
      runs: 2,
      successCount: 1,
      failureCount: 1,
      pauseCount: 0,
      totalCostUsd: 0.02,
      totalDurationMs: 200,
      totalIterations: 4,
    });

    const rollups = await store.queryWorkflowRollups({ workflowId: "wf1" });
    assert.equal(rollups.length, 1);
    assert.equal(rollups[0].runs, 2);
  });
});
