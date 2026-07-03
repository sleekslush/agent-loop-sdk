import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryObservationStore } from "./memory-store.js";
import { ObservationCollector } from "./collector.js";
import { ObservationClient } from "./client.js";
import type { OrchestratorEvent } from "../types.js";

describe("ObservationCollector", () => {
  it("builds a run from workflow events", async () => {
    const store = new MemoryObservationStore();
    const collector = new ObservationCollector(store);
    const client = new ObservationClient(store);

    const runId = "run-1";
    const workflowId = "wf-1";

    await collector.onEvent({
      type: "workflow.started",
      runId,
      workflowId,
      stateId: runId,
      goal: "implement feature",
      triggerSource: "test",
      constraints: { maxIterations: 10 },
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "session.created",
      runId,
      sessionId: "coder",
      role: "coder",
      harness: "mock",
      model: "mock-model",
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "turn.completed",
      runId,
      sessionId: "coder",
      role: "coder",
      iteration: 1,
      durationMs: 100,
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 10,
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "workflow.completed",
      runId,
      workflowId,
      stateId: runId,
      outcome: "success",
      iteration: 1,
      spendUsd: 0.01,
      durationMs: 100,
    } as OrchestratorEvent);

    const run = await client.getRun(runId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.outcome, "success");
    assert.equal(run?.totalCostUsd, 0.01);

    const sessions = await client.getSessions({ runId });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].turnCount, 1);

    const metrics = await client.getWorkflowMetrics({ workflowId });
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].successCount, 1);
    assert.equal(metrics[0].runs, 1);
  });

  it("reindexes from raw events", async () => {
    const store = new MemoryObservationStore();
    const collector = new ObservationCollector(store);
    const client = new ObservationClient(store);

    await collector.onEvent({
      type: "workflow.started",
      runId: "r1",
      workflowId: "wf1",
      stateId: "r1",
      goal: "test",
      triggerSource: "test",
      constraints: { maxIterations: 10 },
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "workflow.completed",
      runId: "r1",
      workflowId: "wf1",
      stateId: "r1",
      outcome: "failure",
      iteration: 0,
      spendUsd: 0,
      durationMs: 0,
    } as OrchestratorEvent);

    await collector.reindex();

    const run = await client.getRun("r1");
    assert.equal(run?.status, "failed");
    assert.equal(run?.outcome, "failure");
  });

  it("does not double-count rollups on reindex", async () => {
    const store = new MemoryObservationStore();
    const collector = new ObservationCollector(store);
    const client = new ObservationClient(store);

    await collector.onEvent({
      type: "workflow.started",
      runId: "r1",
      workflowId: "wf1",
      stateId: "r1",
      goal: "test",
      triggerSource: "test",
      constraints: { maxIterations: 10 },
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "session.created",
      runId: "r1",
      sessionId: "coder",
      role: "coder",
      harness: "mock",
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "turn.completed",
      runId: "r1",
      sessionId: "coder",
      role: "coder",
      iteration: 1,
      durationMs: 100,
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 10,
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "workflow.completed",
      runId: "r1",
      workflowId: "wf1",
      stateId: "r1",
      outcome: "success",
      iteration: 1,
      spendUsd: 0.01,
      durationMs: 100,
    } as OrchestratorEvent);

    let metrics = await client.getWorkflowMetrics({ workflowId: "wf1" });
    assert.equal(metrics[0]?.runs, 1);
    assert.equal(metrics[0]?.successCount, 1);

    await collector.reindex();

    metrics = await client.getWorkflowMetrics({ workflowId: "wf1" });
    assert.equal(metrics[0]?.runs, 1);
    assert.equal(metrics[0]?.successCount, 1);
    assert.equal(metrics[0]?.totalCostUsd, 0.01);

    const roleMetrics = await client.getRoleMetrics({ workflowId: "wf1", role: "coder" });
    assert.equal(roleMetrics[0]?.runs, 1);
    assert.equal(roleMetrics[0]?.turnCount, 1);
  });

  it("records summary events without incrementing turn count", async () => {
    const store = new MemoryObservationStore();
    const collector = new ObservationCollector(store);
    const client = new ObservationClient(store);

    const runId = "run-2";
    const workflowId = "wf-2";

    await collector.onEvent({
      type: "workflow.started",
      runId,
      workflowId,
      stateId: runId,
      goal: "summarize test",
      triggerSource: "test",
      constraints: { maxIterations: 10 },
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "session.created",
      runId,
      sessionId: "coder",
      role: "coder",
      harness: "mock",
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "turn.summarized",
      runId,
      sessionId: "coder",
      role: "coder",
      iteration: 1,
      summary: "concise summary",
      durationMs: 50,
      costUsd: 0.005,
      inputTokens: 5,
      outputTokens: 5,
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "turn.completed",
      runId,
      sessionId: "coder",
      role: "coder",
      iteration: 1,
      durationMs: 100,
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 10,
    } as OrchestratorEvent);

    await collector.onEvent({
      type: "workflow.completed",
      runId,
      workflowId,
      stateId: runId,
      outcome: "success",
      iteration: 1,
      spendUsd: 0.015,
      durationMs: 150,
    } as OrchestratorEvent);

    const sessions = await client.getSessions({ runId });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].turnCount, 1);
    assert.equal(sessions[0].lastSummary, "concise summary");
    assert.equal(sessions[0].totalCostUsd, 0.015);
    assert.equal(sessions[0].totalDurationMs, 150);
    assert.equal(sessions[0].totalInputTokens, 15);
    assert.equal(sessions[0].totalOutputTokens, 15);

    const run = await client.getRun(runId);
    assert.equal(run?.totalCostUsd, 0.015);
  });
});
