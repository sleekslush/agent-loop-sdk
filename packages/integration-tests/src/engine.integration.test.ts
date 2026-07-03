import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineWorkflow, Orchestrator, createFileCheckpointStore } from "@agent-loop/core";
import { PiHarness } from "@agent-loop/harness-pi";

/**
 * Integration tests that exercise the orchestrator loop against a real harness.
 *
 * These are skipped by default because they make live LLM calls. Run them with:
 *
 *   pnpm -F @agent-loop/integration-tests test:integration
 *
 * Pi auth must be configured (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, or a
 * subscription via `pi /login`). Set AGENT_LOOP_INTEGRATION_MODEL to pin a
 * specific model; otherwise the harness uses its default.
 */

const runIntegration = process.env.AGENT_LOOP_RUN_INTEGRATION_TESTS === "true";
const describeIntegration = runIntegration ? describe : describe.skip;
const integrationModel = process.env.AGENT_LOOP_INTEGRATION_MODEL;

describeIntegration("engine integration with PiHarness", () => {
  let baseDir: string;
  let originalSessionDir: string | undefined;

  before(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "agent-loop-integration-"));
    originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = join(baseDir, "sessions");
  });

  after(async () => {
    if (originalSessionDir !== undefined) {
      process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
    } else {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    }
    await rm(baseDir, { recursive: true, force: true });
  });

  it("runs a single-session workflow to completion", async () => {
    const harness = new PiHarness({ cwd: baseDir });
    const checkpointStore = createFileCheckpointStore({
      baseDir: join(baseDir, "checkpoints"),
    });

    const workflow = defineWorkflow({
      id: "hello-world",
      goal: "Get a greeting",
      sessions: [
        {
          id: "greeter",
          role: "greeter",
          harness: "pi",
          model: integrationModel,
        },
      ],
      transitions: [
        { from: "start", to: "greeter", input: "Say a one-word greeting." },
      ],
      constraints: { maxIterations: 3, maxSpendUsd: 0.5 },
      exitConditions: {
        goalMet: (state) => (state.sessions.greeter?.lastOutput?.length ?? 0) > 0,
      },
    });

    const orchestrator = new Orchestrator({ harnesses: [harness], checkpointStore });
    const state = await orchestrator.start(workflow);

    assert.equal(state.outcome, "success");
    assert.ok((state.sessions.greeter?.lastOutput?.length ?? 0) > 0);
  });

  it("summarizes session output", async () => {
    const harness = new PiHarness({ cwd: baseDir });
    const checkpointStore = createFileCheckpointStore({
      baseDir: join(baseDir, "checkpoints"),
    });

    const workflow = defineWorkflow({
      id: "summarize-test",
      goal: "Get a summarized greeting",
      sessions: [
        {
          id: "greeter",
          role: "greeter",
          harness: "pi",
          model: integrationModel,
          summarizeOutput: true,
          summaryPrompt:
            "Summarize the greeting in one sentence. End with VERDICT: HELLO",
        },
      ],
      transitions: [
        { from: "start", to: "greeter", input: "Greet the user." },
      ],
      constraints: { maxIterations: 3, maxSpendUsd: 0.5 },
      exitConditions: {
        goalMet: (state) =>
          (state.sessions.greeter?.lastSummary?.length ?? 0) > 0,
      },
    });

    const orchestrator = new Orchestrator({ harnesses: [harness], checkpointStore });
    const state = await orchestrator.start(workflow);

    assert.equal(state.outcome, "success");
    assert.ok(state.sessions.greeter?.lastSummary);
  });
});
