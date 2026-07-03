import { randomUUID } from "node:crypto";
import type { AgentHarness, OrchestratorEvent } from "../types.js";
import type {
  ObservationEvent,
  ObservationStore,
  Run,
  SessionRecord,
  SessionSnapshot,
} from "./types.js";

function periodFromDate(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function eventToObservationEvent(event: OrchestratorEvent): ObservationEvent {
  const { type, ...payload } = event;
  const timestamp = new Date();
  return {
    id: randomUUID(),
    runId: "runId" in event ? (event.runId as string) : "unknown",
    workflowId: "workflowId" in event ? (event.workflowId as string) : "unknown",
    type,
    timestamp,
    payload: { ...payload, _observedAt: timestamp.toISOString() } as Record<string, unknown>,
  };
}

export interface ObservationCollectorOptions {
  harnesses?: AgentHarness[];
}

export class ObservationCollector {
  private store: ObservationStore;
  private harnessMap: Map<string, AgentHarness>;
  private runs: Map<string, Run> = new Map();
  private sessions: Map<string, SessionRecord> = new Map();
  private rebuilding = false;

  constructor(store: ObservationStore, options: ObservationCollectorOptions = {}) {
    this.store = store;
    this.harnessMap = options.harnesses ? new Map(options.harnesses.map((h) => [h.name, h])) : new Map();
  }

  async onEvent(event: OrchestratorEvent): Promise<void> {
    const observation = eventToObservationEvent(event);
    await this.store.appendEvent(observation);

    switch (event.type) {
      case "workflow.started": {
        const observedAt =
          typeof (event as Record<string, unknown>)._observedAt === "string"
            ? new Date((event as Record<string, unknown>)._observedAt as string)
            : new Date();
        const run: Run = {
          id: event.runId,
          workflowId: event.workflowId,
          goal: event.goal,
          status: "running",
          startedAt: observedAt,
          iterationCount: 0,
          totalCostUsd: 0,
          triggerSource: event.triggerSource,
        };
        this.runs.set(run.id, run);
        await this.store.upsertRun(run);
        break;
      }

      case "session.created": {
        const run = this.runs.get(event.runId);
        if (!run) break;
        const session: SessionRecord = {
          id: `${event.runId}:${event.sessionId}`,
          runId: event.runId,
          workflowId: run.workflowId,
          sessionId: event.sessionId,
          role: event.role,
          harness: event.harness,
          model: event.model,
          turnCount: 0,
          totalCostUsd: 0,
          totalDurationMs: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          harnessSessionRef: event.harnessSessionRef,
        };
        this.sessions.set(session.id, session);
        await this.store.upsertSession(session);
        break;
      }

      case "turn.completed": {
        const session = this.sessions.get(`${event.runId}:${event.sessionId}`);
        if (session) {
          session.turnCount += 1;
          session.totalCostUsd += event.costUsd;
          session.totalDurationMs += event.durationMs;
          session.totalInputTokens += event.inputTokens;
          session.totalOutputTokens += event.outputTokens;
          await this.store.upsertSession(session);
        }

        const run = this.runs.get(event.runId);
        if (run) {
          run.totalCostUsd += event.costUsd;
          run.iterationCount = Math.max(run.iterationCount, event.iteration);
          await this.store.upsertRun(run);
        }
        break;
      }

      case "workflow.completed": {
        const run = this.runs.get(event.runId);
        if (run) {
          run.status = event.outcome === "success" ? "completed" : event.outcome === "paused" ? "paused" : "failed";
          run.outcome = event.outcome;
          run.failureReason = event.failureReason;
          run.endedAt = new Date();
          run.durationMs = event.durationMs;
          run.iterationCount = event.iteration;
          run.totalCostUsd = event.spendUsd;
          await this.store.upsertRun(run);
          if (!this.rebuilding) {
            await this.updateRollups(run);
            await this.exportSnapshots(run);
          }
        }
        break;
      }

      case "turn.started":
      case "constraint.breached":
      case "checkpoint.written":
        // These are stored as raw events only.
        break;
    }
  }

  async reindex(): Promise<void> {
    this.rebuilding = true;
    try {
      this.runs.clear();
      this.sessions.clear();

      const events = await this.store.queryEvents({ limit: 100000 });
      events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      for (const observation of events) {
        const event = { type: observation.type, ...observation.payload } as OrchestratorEvent;
        await this.onEvent(event);
      }
    } finally {
      this.rebuilding = false;
    }
  }

  private async updateRollups(run: Run): Promise<void> {
    const period = periodFromDate(run.startedAt);
    const workflowRollup = await this.store.queryWorkflowRollups({
      workflowId: run.workflowId,
      period,
    });
    const existingWorkflow = workflowRollup[0] ?? {
      workflowId: run.workflowId,
      period,
      runs: 0,
      successCount: 0,
      failureCount: 0,
      pauseCount: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      totalIterations: 0,
    };

    existingWorkflow.runs += 1;
    if (run.outcome === "success") existingWorkflow.successCount += 1;
    else if (run.outcome === "failure") existingWorkflow.failureCount += 1;
    else if (run.outcome === "paused") existingWorkflow.pauseCount += 1;
    existingWorkflow.totalCostUsd += run.totalCostUsd;
    existingWorkflow.totalDurationMs += run.durationMs ?? 0;
    existingWorkflow.totalIterations += run.iterationCount;
    await this.store.upsertWorkflowRollup(existingWorkflow);

    const runSessions = await this.store.querySessions({ runId: run.id });
    for (const session of runSessions) {
      const roleRollups = await this.store.queryRoleRollups({
        workflowId: run.workflowId,
        role: session.role,
        period,
      });
      const existingRole = roleRollups[0] ?? {
        workflowId: run.workflowId,
        role: session.role,
        period,
        runs: 0,
        turnCount: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
      };

      existingRole.runs += 1;
      existingRole.turnCount += session.turnCount;
      existingRole.totalCostUsd += session.totalCostUsd;
      existingRole.totalDurationMs += session.totalDurationMs;
      await this.store.upsertRoleRollup(existingRole);
    }
  }

  private async exportSnapshots(run: Run): Promise<void> {
    if (this.harnessMap.size === 0) return;

    const sessions = await this.store.querySessions({ runId: run.id });
    for (const session of sessions) {
      const ref = session.harnessSessionRef;
      if (!ref) continue;

      const harness = this.harnessMap.get(ref.harness);
      if (!harness?.exportSession) continue;

      try {
        const content = await harness.exportSession(ref, "jsonl");
        const snapshot: SessionSnapshot = {
          runId: run.id,
          sessionId: session.sessionId,
          harness: ref.harness,
          exportedAt: new Date(),
          format: "jsonl",
          content,
        };
        await this.store.storeSessionSnapshot(snapshot);
      } catch {
        // Snapshot export is best-effort; do not fail the workflow.
      }
    }
  }
}
