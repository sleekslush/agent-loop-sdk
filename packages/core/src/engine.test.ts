import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, defineWorkflow } from "./engine.js";
import { createFileCheckpointStore } from "./checkpoint.js";
import type {
  AgentHarness,
  HarnessSession,
  SessionConfig,
  SessionTurnResult,
  Trigger,
  Workflow,
} from "./types.js";

class MockHarnessSession implements HarnessSession {
  readonly id: string;
  readonly harness = "mock";
  private responses: Map<string, string>;

  constructor(id: string, responses: Map<string, string>) {
    this.id = id;
    this.responses = responses;
  }

  async prompt(text: string): Promise<SessionTurnResult> {
    const response = this.responses.get(text) ?? `mock response for ${this.id}`;
    return {
      text: response,
      usage: { inputTokens: 10, outputTokens: 10 },
      costUsd: 0.01,
      durationMs: 100,
      isError: false,
    };
  }

  dispose(): void {
    // no-op
  }
}

class MockHarness implements AgentHarness {
  readonly name = "mock";
  private sessions: MockHarnessSession[] = [];
  private responses: Map<string, string> = new Map();

  setResponse(promptPattern: string, response: string): void {
    this.responses.set(promptPattern, response);
  }

  async createSession(_config: SessionConfig): Promise<HarnessSession> {
    const session = new MockHarnessSession(`mock-session-${this.sessions.length}`, this.responses);
    this.sessions.push(session);
    return session;
  }

  getSessions(): MockHarnessSession[] {
    return this.sessions;
  }
}

function makeTrigger(): Trigger {
  return {
    id: "trigger-1",
    source: "test",
    type: "test.start",
    payload: { task: "do something" },
    receivedAt: new Date(),
  };
}

describe("Orchestrator", () => {
  let harness: MockHarness;
  let orchestrator: Orchestrator;
  let events: string[] = [];

  beforeEach(() => {
    harness = new MockHarness();
    events = [];
    orchestrator = new Orchestrator({
      harnesses: [harness],
      checkpointStore: createFileCheckpointStore({ baseDir: ".checkpoints-test" }),
      onEvent: (event) => {
        events.push(event.type);
      },
    });
  });

  it("runs a simple linear workflow", async () => {
    const workflow: Workflow = defineWorkflow({
      id: "linear",
      goal: "linear test",
      sessions: [
        { id: "reader", role: "reader", harness: "mock" },
        { id: "writer", role: "writer", harness: "mock" },
      ],
      transitions: [
        { from: "start", to: "reader", input: "read" },
        { from: "reader", to: "writer", input: (state) => `write: ${state.sessions.reader.lastOutput}` },
      ],
      constraints: { maxIterations: 10 },
      exitConditions: {
        goalMet: (state) => state.currentSessionId === "writer",
      },
    });

    const state = await orchestrator.start(workflow, undefined, makeTrigger());

    assert.equal(state.status, "completed");
    assert.equal(state.outcome, "success");
    assert.equal(state.iteration, 2);
    assert.equal(state.sessions.reader.lastOutput, "mock response for mock-session-0");
    assert.ok(events.includes("workflow.started"));
    assert.ok(events.includes("workflow.completed"));
  });

  it("loops until a guard stops the cycle", async () => {
    const workflow: Workflow = defineWorkflow({
      id: "loop",
      goal: "loop test",
      sessions: [
        { id: "generator", role: "generator", harness: "mock" },
        { id: "checker", role: "checker", harness: "mock" },
      ],
      transitions: [
        { from: "start", to: "generator", input: "generate" },
        { from: "generator", to: "checker", input: "check" },
        {
          from: "checker",
          to: "generator",
          when: (state) => state.iteration < 4,
          input: "generate again",
        },
      ],
      constraints: { maxIterations: 10 },
      exitConditions: {
        goalMet: (state) => state.iteration >= 4 && state.currentSessionId === "checker",
      },
    });

    const state = await orchestrator.start(workflow, undefined, makeTrigger());

    assert.equal(state.status, "completed");
    assert.equal(state.outcome, "success");
    assert.equal(state.iteration, 4);
  });

  it("fails when maxIterations is reached", async () => {
    const workflow: Workflow = defineWorkflow({
      id: "iter-limit",
      goal: "iteration limit test",
      sessions: [{ id: "step", role: "step", harness: "mock" }],
      transitions: [{ from: "start", to: "step", input: "step" }],
      constraints: { maxIterations: 1 },
      exitConditions: {},
    });

    const state = await orchestrator.start(workflow, undefined, makeTrigger());

    assert.equal(state.status, "failed");
    assert.equal(state.outcome, "failure");
    assert.match(state.failureReason!, /maxIterations/);
    assert.ok(events.includes("constraint.breached"));
  });

  it("applies session parseOutput to shared context", async () => {
    const workflow: Workflow = defineWorkflow({
      id: "parse",
      goal: "parse output test",
      sessions: [
        {
          id: "parser",
          role: "parser",
          harness: "mock",
          parseOutput: (output) => ({ parsed: output.toUpperCase() }),
        },
      ],
      transitions: [{ from: "start", to: "parser", input: "parse" }],
      constraints: { maxIterations: 10 },
      exitConditions: {
        goalMet: (state) => state.context.parsed === "HELLO",
      },
    });

    harness.setResponse("parse", "hello");

    const state = await orchestrator.start(workflow, undefined, makeTrigger());

    assert.equal(state.status, "completed");
    assert.equal(state.outcome, "success");
    assert.equal(state.context.parsed, "HELLO");
  });

  it("summarizes output and passes the summary to the next transition", async () => {
    const defaultSummaryPrompt =
      "Summarize your previous response concisely so it can be used as context for the next step in this workflow. End with a single line: VERDICT: APPROVED or VERDICT: REJECTED if applicable.";

    harness.setResponse("implement", "implementation complete");
    harness.setResponse(defaultSummaryPrompt, "Summary: implementation looks good. VERDICT: APPROVED");
    harness.setResponse("review: Summary: implementation looks good. VERDICT: APPROVED", "review complete");

    const workflow: Workflow = defineWorkflow({
      id: "summarize",
      goal: "summarize output test",
      sessions: [
        {
          id: "coder",
          role: "coder",
          harness: "mock",
          summarizeOutput: true,
        },
        {
          id: "reviewer",
          role: "reviewer",
          harness: "mock",
        },
      ],
      transitions: [
        { from: "start", to: "coder", input: "implement" },
        {
          from: "coder",
          to: "reviewer",
          input: (state) => `review: ${state.sessions.coder.lastSummary}`,
        },
      ],
      constraints: { maxIterations: 10 },
      exitConditions: {
        goalMet: (state) => state.currentSessionId === "reviewer",
      },
    });

    const state = await orchestrator.start(workflow, undefined, makeTrigger());

    assert.equal(state.status, "completed");
    assert.equal(state.outcome, "success");
    assert.equal(state.sessions.coder.lastSummary, "Summary: implementation looks good. VERDICT: APPROVED");
    assert.equal(state.sessions.reviewer.lastOutput, "review complete");
    assert.equal(state.iteration, 2);
    assert.equal(state.spendUsd, 0.03);
    assert.ok(events.includes("turn.summarized"));
    assert.ok(events.includes("turn.completed"));
  });

  it("does nothing when resumed from a non-running state", async () => {
    const workflow: Workflow = defineWorkflow({
      id: "resume",
      goal: "resume test",
      sessions: [],
      transitions: [],
      constraints: { maxIterations: 10 },
      exitConditions: {},
    });

    // Passing a completed state returns it unchanged.
    const completed = {
      id: "completed-state",
      workflowId: workflow.id,
      trigger: makeTrigger(),
      status: "completed" as const,
      outcome: "success" as const,
      iteration: 1,
      spendUsd: 0,
      startedAt: new Date(),
      endedAt: new Date(),
      context: {},
      sessions: {},
      history: [],
    };

    const state = await orchestrator.start(workflow, completed);
    assert.equal(state.status, "completed");
    assert.equal(state.iteration, 1);
  });
});
