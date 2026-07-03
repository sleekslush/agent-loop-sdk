import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlObservationStore } from "./jsonl-store.js";
import type { ObservationEvent, Run, SessionRecord, SessionSnapshot } from "./types.js";

function event(runId: string, workflowId: string, type: string, payload: Record<string, unknown> = {}): ObservationEvent {
  return {
    id: `${runId}-${type}`,
    runId,
    workflowId,
    type,
    timestamp: new Date("2024-07-15T12:00:00Z"),
    payload,
  };
}

describe("JsonlObservationStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "agent-loop-jsonl-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("writes events to daily jsonl files", async () => {
    const store = new JsonlObservationStore({ baseDir });
    await store.appendEvent(event("r1", "wf1", "workflow.started"));

    const events = await store.queryEvents({ runId: "r1" });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "workflow.started");
  });

  it("upserts runs", async () => {
    const store = new JsonlObservationStore({ baseDir });
    const run: Run = {
      id: "r1",
      workflowId: "wf1",
      goal: "test",
      status: "running",
      startedAt: new Date(),
      iterationCount: 0,
      totalCostUsd: 0,
      triggerSource: "test",
    };
    await store.upsertRun(run);
    await store.upsertRun({ ...run, status: "completed", outcome: "success" });

    const retrieved = await store.getRun("r1");
    assert.equal(retrieved?.status, "completed");
  });

  it("stores session refs and snapshots", async () => {
    const store = new JsonlObservationStore({ baseDir });
    const session: SessionRecord = {
      id: "r1:s1",
      runId: "r1",
      workflowId: "wf1",
      sessionId: "s1",
      role: "coder",
      harness: "mock",
      turnCount: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      harnessSessionRef: { harness: "mock", sessionId: "s1" },
    };
    await store.upsertSession(session);

    const ref = await store.getSessionRef("r1", "s1");
    assert.equal(ref?.sessionId, "s1");

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
});
