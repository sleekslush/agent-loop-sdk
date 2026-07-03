import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, markCompleted, recordTurn } from "./state.js";
import type { SessionSpec, Trigger, Workflow } from "./types.js";

function makeTrigger(): Trigger {
  return {
    id: "trigger-1",
    source: "test",
    type: "test.start",
    payload: { key: "value" },
    receivedAt: new Date("2024-01-01T00:00:00Z"),
  };
}

function makeWorkflow(sessions: SessionSpec[] = []): Workflow {
  return {
    id: "wf-1",
    goal: "test goal",
    sessions,
    transitions: [],
    constraints: { maxIterations: 10 },
    exitConditions: {},
  };
}

describe("createInitialState", () => {
  it("creates a running state with sessions", () => {
    const workflow = makeWorkflow([
      { id: "reader", role: "reader", harness: "mock" },
      { id: "writer", role: "writer", harness: "mock", model: "claude" },
    ]);
    const state = createInitialState(workflow, makeTrigger());

    assert.equal(state.status, "running");
    assert.equal(state.workflowId, "wf-1");
    assert.equal(state.iteration, 0);
    assert.equal(state.spendUsd, 0);
    assert.ok(state.sessions.reader);
    assert.ok(state.sessions.writer);
    assert.equal(state.sessions.writer.harness, "mock");
  });
});

describe("recordTurn", () => {
  it("records a turn and updates iteration, spend, and session output", () => {
    const workflow = makeWorkflow([{ id: "reader", role: "reader", harness: "mock" }]);
    let state = createInitialState(workflow, makeTrigger());

    state = recordTurn(state, "reader", "read this", {
      text: "done",
      costUsd: 0.05,
      durationMs: 1200,
    });

    assert.equal(state.iteration, 1);
    assert.equal(state.spendUsd, 0.05);
    assert.equal(state.currentSessionId, "reader");
    assert.equal(state.sessions.reader.lastOutput, "done");
    assert.equal(state.sessions.reader.costUsd, 0.05);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].prompt, "read this");
  });

  it("defaults cost to 0 when not provided", () => {
    const workflow = makeWorkflow([{ id: "reader", role: "reader", harness: "mock" }]);
    let state = createInitialState(workflow, makeTrigger());

    state = recordTurn(state, "reader", "prompt", { text: "ok", durationMs: 100 });

    assert.equal(state.spendUsd, 0);
    assert.equal(state.history[0].costUsd, 0);
  });
});

describe("markCompleted", () => {
  it("marks success as completed", () => {
    const workflow = makeWorkflow();
    const state = createInitialState(workflow, makeTrigger());
    const finished = markCompleted(state, "success");

    assert.equal(finished.status, "completed");
    assert.equal(finished.outcome, "success");
    assert.ok(finished.endedAt);
  });

  it("marks failure as failed with a reason", () => {
    const workflow = makeWorkflow();
    const state = createInitialState(workflow, makeTrigger());
    const finished = markCompleted(state, "failure", "budget exhausted");

    assert.equal(finished.status, "failed");
    assert.equal(finished.outcome, "failure");
    assert.equal(finished.failureReason, "budget exhausted");
  });
});
