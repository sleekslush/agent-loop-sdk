import type {
  EventFilter,
  ObservationEvent,
  ObservationStore,
  RollupFilter,
  RoleRollup,
  Run,
  RunFilter,
  SessionFilter,
  SessionRecord,
  SessionSnapshot,
  WorkflowRollup,
} from "./types.js";
import type { HarnessSessionRef } from "../types.js";

export class ObservationClient {
  private store: ObservationStore;

  constructor(store: ObservationStore) {
    this.store = store;
  }

  async getEvents(filter: EventFilter = {}): Promise<ObservationEvent[]> {
    return this.store.queryEvents(filter);
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.store.getRun(id);
  }

  async getRuns(filter: RunFilter = {}): Promise<Run[]> {
    return this.store.queryRuns(filter);
  }

  async getRunCount(filter: Omit<RunFilter, "limit" | "offset"> = {}): Promise<number> {
    const runs = await this.store.queryRuns(filter);
    return runs.length;
  }

  async getSessions(filter: SessionFilter = {}): Promise<SessionRecord[]> {
    return this.store.querySessions(filter);
  }

  async getSessionRef(runId: string, sessionId: string): Promise<HarnessSessionRef | undefined> {
    return this.store.getSessionRef(runId, sessionId);
  }

  async getSessionSnapshot(runId: string, sessionId: string): Promise<SessionSnapshot | undefined> {
    return this.store.getSessionSnapshot(runId, sessionId);
  }

  async getWorkflowMetrics(filter: RollupFilter = {}): Promise<WorkflowRollup[]> {
    return this.store.queryWorkflowRollups(filter);
  }

  async getRoleMetrics(filter: RollupFilter = {}): Promise<RoleRollup[]> {
    return this.store.queryRoleRollups(filter);
  }

  async getSuccessRate(filter: RollupFilter = {}): Promise<number> {
    const rollups = await this.store.queryWorkflowRollups(filter);
    const total = rollups.reduce((sum, r) => sum + r.runs, 0);
    if (total === 0) return 0;
    const successes = rollups.reduce((sum, r) => sum + r.successCount, 0);
    return successes / total;
  }

  async getTotalSpend(filter: RollupFilter = {}): Promise<number> {
    const rollups = await this.store.queryWorkflowRollups(filter);
    return rollups.reduce((sum, r) => sum + r.totalCostUsd, 0);
  }

  async getAverageDuration(filter: RollupFilter = {}): Promise<number> {
    const rollups = await this.store.queryWorkflowRollups(filter);
    const total = rollups.reduce((sum, r) => sum + r.runs, 0);
    if (total === 0) return 0;
    const totalDuration = rollups.reduce((sum, r) => sum + r.totalDurationMs, 0);
    return totalDuration / total;
  }
}
