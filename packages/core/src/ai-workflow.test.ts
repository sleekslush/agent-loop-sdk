import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileAiWorkflow, validateAiWorkflow } from "./ai-workflow.js";
import type { WorkflowState } from "./types.js";

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: "state-1",
    workflowId: "wf-1",
    trigger: {
      id: "trigger-1",
      source: "test",
      type: "test.start",
      payload: { ticketKey: "AC-123" },
      receivedAt: new Date(),
    },
    status: "running",
    iteration: 0,
    spendUsd: 0,
    startedAt: new Date(),
    context: {},
    sessions: {
      reader: {
        id: "reader",
        role: "reader",
        harness: "mock",
        status: "idle",
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        lastOutput: "hello world",
      },
    },
    history: [],
    ...overrides,
  };
}

describe("validateAiWorkflow", () => {
  it("passes for a valid workflow", () => {
    const errors = validateAiWorkflow({
      id: "wf",
      goal: "test",
      sessions: [{ id: "a", role: "role" }],
      transitions: [{ from: "start", to: "a" }],
      constraints: { maxIterations: 10 },
      exitConditions: {},
    });
    assert.equal(errors.length, 0);
  });

  it("reports missing id and goal", () => {
    const errors = validateAiWorkflow({
      id: "",
      goal: "",
      sessions: [],
      transitions: [],
      constraints: { maxIterations: 10 },
      exitConditions: {},
    });
    assert.ok(errors.some((e) => e.includes("id")));
    assert.ok(errors.some((e) => e.includes("goal")));
    assert.ok(errors.some((e) => e.includes("session")));
  });

  it("reports unknown session references", () => {
    const errors = validateAiWorkflow({
      id: "wf",
      goal: "test",
      sessions: [{ id: "a", role: "role" }],
      transitions: [{ from: "start", to: "b" }],
      constraints: { maxIterations: 10 },
      exitConditions: {},
    });
    assert.ok(errors.some((e) => e.includes('"b"')));
  });
});

describe("compileAiWorkflow", () => {
  it("compiles templates and expressions", () => {
    const workflow = compileAiWorkflow({
      id: "wf",
      goal: "test",
      sessions: [
        {
          id: "reader",
          role: "reader",
          parseOutput: {
            approved: { type: "boolean", pattern: "APPROVED" },
            count: { type: "number", pattern: "COUNT:\\s*(\\d+)", group: 1 },
          },
        },
      ],
      transitions: [
        { from: "start", to: "reader", input: "Read {{sessions.reader.lastOutput}}" },
        {
          from: "reader",
          to: "reader",
          when: "state.context.approved === true",
          input: "Done",
        },
      ],
      constraints: { maxIterations: 10 },
      exitConditions: {
        goalMet: "state.context.approved === true",
      },
    });

    const state = makeState();
    const input = workflow.transitions[0].input as (state: WorkflowState) => string;
    assert.equal(input(state), "Read hello world");

    const parse = workflow.sessions[0].parseOutput!;
    const extracted = parse("APPROVED COUNT: 5", state) as Record<string, unknown>;
    assert.equal(extracted.approved, true);
    assert.equal(extracted.count, 5);

    const when = workflow.transitions[1].when as (state: WorkflowState) => boolean;
    assert.equal(when(makeState({ context: { approved: true } })), true);
    assert.equal(when(makeState({ context: { approved: false } })), false);

    const goalMet = workflow.exitConditions.goalMet as (state: WorkflowState) => boolean;
    assert.equal(goalMet(makeState({ context: { approved: true } })), true);
  });

  it("defaults harness to pi", () => {
    const workflow = compileAiWorkflow({
      id: "wf",
      goal: "test",
      sessions: [{ id: "a", role: "role" }],
      transitions: [{ from: "start", to: "a" }],
      constraints: { maxIterations: 10 },
      exitConditions: {},
    });
    assert.equal(workflow.sessions[0].harness, "pi");
  });

  it("respects custom default harness", () => {
    const workflow = compileAiWorkflow(
      {
        id: "wf",
        goal: "test",
        sessions: [{ id: "a", role: "role" }],
        transitions: [{ from: "start", to: "a" }],
        constraints: { maxIterations: 10 },
        exitConditions: {},
      },
      { defaultHarness: "mock" },
    );
    assert.equal(workflow.sessions[0].harness, "mock");
  });

  it("throws on invalid workflow", () => {
    assert.throws(() => {
      compileAiWorkflow({
        id: "",
        goal: "test",
        sessions: [],
        transitions: [],
        constraints: { maxIterations: 10 },
        exitConditions: {},
      });
    });
  });
});
