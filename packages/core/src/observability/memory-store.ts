import type {
  EventFilter,
  ObservationEvent,
  ObservationStore,
  Run,
  RunFilter,
  RunOutcome,
  RunStatus,
  SessionFilter,
  SessionRecord,
  SessionSnapshot,
  RollupFilter,
  RoleRollup,
  WorkflowRollup,
} from "./types.js";
import type { HarnessSessionRef } from "../types.js";

function matchesValue<T>(value: T, filter: T | T[] | undefined): boolean {
  if (filter === undefined) return true;
  if (Array.isArray(filter)) return filter.includes(value);
  return value === filter;
}

function matchesDateRange(
  date: Date,
  from: Date | undefined,
  to: Date | undefined,
): boolean {
  const time = date.getTime();
  if (from !== undefined && time < from.getTime()) return false;
  if (to !== undefined && time > to.getTime()) return false;
  return true;
}

export function createMemoryObservationStore(): MemoryObservationStore {
  return new MemoryObservationStore();
}

export class MemoryObservationStore implements ObservationStore {
  private events: ObservationEvent[] = [];
  private runs: Map<string, Run> = new Map();
  private sessions: Map<string, SessionRecord> = new Map();
  private snapshots: Map<string, SessionSnapshot> = new Map();
  private workflowRollups: Map<string, WorkflowRollup> = new Map();
  private roleRollups: Map<string, RoleRollup> = new Map();

  async appendEvent(event: ObservationEvent): Promise<void> {
    this.events.push(event);
  }

  async queryEvents(filter: EventFilter = {}): Promise<ObservationEvent[]> {
    const types = filter.type ? (Array.isArray(filter.type) ? filter.type : [filter.type]) : undefined;
    const result = this.events.filter((event) => {
      if (filter.runId && event.runId !== filter.runId) return false;
      if (filter.workflowId && event.workflowId !== filter.workflowId) return false;
      if (types && !types.includes(event.type)) return false;
      if (filter.sessionId) {
        const payloadSessionId = event.payload.sessionId;
        if (payloadSessionId !== filter.sessionId) return false;
      }
      if (filter.role) {
        const payloadRole = event.payload.role;
        if (payloadRole !== filter.role) return false;
      }
      if (!matchesDateRange(event.timestamp, filter.from, filter.to)) return false;
      return true;
    });

    if (filter.limit !== undefined) {
      return result.slice(-filter.limit);
    }
    return result;
  }

  async upsertRun(run: Run): Promise<void> {
    this.runs.set(run.id, run);
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.runs.get(id);
  }

  async queryRuns(filter: RunFilter = {}): Promise<Run[]> {
    let result = Array.from(this.runs.values()).filter((run) => {
      if (filter.workflowId && run.workflowId !== filter.workflowId) return false;
      if (!matchesValue(run.status, filter.status as RunStatus | RunStatus[] | undefined)) return false;
      if (!matchesValue(run.outcome, filter.outcome as RunOutcome | RunOutcome[] | undefined)) return false;
      if (!matchesDateRange(run.startedAt, filter.from, filter.to)) return false;
      return true;
    });

    result.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    const offset = filter.offset ?? 0;
    const limit = filter.limit;
    if (offset > 0 || limit !== undefined) {
      result = result.slice(offset, limit !== undefined ? offset + limit : undefined);
    }

    return result;
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async querySessions(filter: SessionFilter = {}): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values()).filter((session) => {
      if (filter.runId && session.runId !== filter.runId) return false;
      if (filter.workflowId && session.workflowId !== filter.workflowId) return false;
      if (filter.sessionId && session.sessionId !== filter.sessionId) return false;
      if (filter.role && session.role !== filter.role) return false;
      return true;
    });
  }

  async getSessionRef(runId: string, sessionId: string): Promise<HarnessSessionRef | undefined> {
    const session = this.sessions.get(`${runId}:${sessionId}`);
    return session?.harnessSessionRef;
  }

  async storeSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
    this.snapshots.set(`${snapshot.runId}:${snapshot.sessionId}`, snapshot);
  }

  async getSessionSnapshot(runId: string, sessionId: string): Promise<SessionSnapshot | undefined> {
    return this.snapshots.get(`${runId}:${sessionId}`);
  }

  async upsertWorkflowRollup(rollup: WorkflowRollup): Promise<void> {
    this.workflowRollups.set(`${rollup.workflowId}:${rollup.period}`, rollup);
  }

  async upsertRoleRollup(rollup: RoleRollup): Promise<void> {
    this.roleRollups.set(`${rollup.workflowId}:${rollup.role}:${rollup.period}`, rollup);
  }

  async queryWorkflowRollups(filter: RollupFilter = {}): Promise<WorkflowRollup[]> {
    return Array.from(this.workflowRollups.values()).filter((rollup) => {
      if (filter.workflowId && rollup.workflowId !== filter.workflowId) return false;
      if (filter.period && rollup.period !== filter.period) return false;
      if (!matchesDateRange(new Date(rollup.period + "-01T00:00:00Z"), filter.from, filter.to)) return false;
      return true;
    });
  }

  async queryRoleRollups(filter: RollupFilter = {}): Promise<RoleRollup[]> {
    return Array.from(this.roleRollups.values()).filter((rollup) => {
      if (filter.workflowId && rollup.workflowId !== filter.workflowId) return false;
      if (filter.role && rollup.role !== filter.role) return false;
      if (filter.period && rollup.period !== filter.period) return false;
      if (!matchesDateRange(new Date(rollup.period + "-01T00:00:00Z"), filter.from, filter.to)) return false;
      return true;
    });
  }
}
