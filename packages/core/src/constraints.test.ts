import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkConstraints, validateModel } from "./constraints.js";
import type { Constraints, WorkflowState } from "./types.js";

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: "state-1",
    workflowId: "wf-1",
    trigger: {
      id: "trigger-1",
      source: "test",
      type: "test.start",
      payload: {},
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    },
    status: "running",
    iteration: 0,
    spendUsd: 0,
    startedAt: new Date("2024-01-01T00:00:00Z"),
    context: {},
    sessions: {},
    history: [],
    ...overrides,
  };
}

describe("checkConstraints", () => {
  it("passes when no limits are reached", () => {
    const constraints: Constraints = { maxIterations: 5 };
    const state = makeState({ iteration: 3 });
    const result = checkConstraints(constraints, state);
    assert.equal(result.breached, false);
  });

  it("breaches maxIterations", () => {
    const constraints: Constraints = { maxIterations: 5 };
    const state = makeState({ iteration: 5 });
    const result = checkConstraints(constraints, state);
    assert.equal(result.breached, true);
    assert.match(result.reason!, /maxIterations/);
  });

  it("breaches maxSpendUsd", () => {
    const constraints: Constraints = { maxIterations: 100, maxSpendUsd: 1.0 };
    const state = makeState({ spendUsd: 1.0 });
    const result = checkConstraints(constraints, state);
    assert.equal(result.breached, true);
    assert.match(result.reason!, /maxSpendUsd/);
  });

  it("breaches maxWallClockMs", () => {
    const constraints: Constraints = { maxIterations: 100, maxWallClockMs: 1000 };
    const state = makeState({ startedAt: new Date(Date.now() - 2000) });
    const result = checkConstraints(constraints, state);
    assert.equal(result.breached, true);
    assert.match(result.reason!, /maxWallClockMs/);
  });
});

describe("validateModel", () => {
  it("passes when no allowedModels list is set", () => {
    const constraints: Constraints = { maxIterations: 10 };
    const result = validateModel(constraints, "claude-sonnet");
    assert.equal(result.breached, false);
  });

  it("passes for an allowed model", () => {
    const constraints: Constraints = { maxIterations: 10, allowedModels: ["claude-sonnet", "gpt-4o"] };
    const result = validateModel(constraints, "gpt-4o");
    assert.equal(result.breached, false);
  });

  it("breaches for a disallowed model", () => {
    const constraints: Constraints = { maxIterations: 10, allowedModels: ["claude-sonnet"] };
    const result = validateModel(constraints, "gpt-4o");
    assert.equal(result.breached, true);
    assert.match(result.reason!, /not in allowedModels/);
  });
});
