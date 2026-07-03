import type { HarnessSessionRef, SessionExportFormat } from "../types.js";

export type ObservationStoreConfig =
  | { type: "jsonl"; baseDir: string }
  | { type: "sqlite"; filePath: string }
  | { type: "memory" };

export interface ObservationEvent {
  id: string;
  runId: string;
  workflowId: string;
  type: string;
  timestamp: Date;
  payload: Record<string, unknown>;
}

export type RunStatus = "running" | "completed" | "failed" | "paused";
export type RunOutcome = "success" | "failure" | "paused";

export interface Run {
  id: string;
  workflowId: string;
  goal: string;
  status: RunStatus;
  outcome?: RunOutcome;
  failureReason?: string;
  startedAt: Date;
  endedAt?: Date;
  durationMs?: number;
  iterationCount: number;
  totalCostUsd: number;
  triggerSource: string;
}

export interface SessionRecord {
  id: string;
  runId: string;
  workflowId: string;
  sessionId: string;
  role: string;
  harness: string;
  model?: string;
  turnCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  harnessSessionRef?: HarnessSessionRef;
  lastSummary?: string;
}

export interface SessionSnapshot {
  runId: string;
  sessionId: string;
  harness: string;
  exportedAt: Date;
  format: SessionExportFormat;
  content: string;
}

export interface WorkflowRollup {
  workflowId: string;
  period: string;
  runs: number;
  successCount: number;
  failureCount: number;
  pauseCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
  totalIterations: number;
}

export interface RoleRollup {
  workflowId: string;
  role: string;
  period: string;
  runs: number;
  turnCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
}

export interface EventFilter {
  runId?: string;
  workflowId?: string;
  type?: string | string[];
  sessionId?: string;
  role?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface RunFilter {
  workflowId?: string;
  status?: RunStatus | RunStatus[];
  outcome?: RunOutcome | RunOutcome[];
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface SessionFilter {
  runId?: string;
  workflowId?: string;
  sessionId?: string;
  role?: string;
  from?: Date;
  to?: Date;
}

export interface RollupFilter {
  workflowId?: string;
  role?: string;
  period?: string;
  from?: Date;
  to?: Date;
}

export interface ObservationStore {
  // Events
  appendEvent(event: ObservationEvent): Promise<void>;
  queryEvents(filter: EventFilter): Promise<ObservationEvent[]>;

  // Runs
  upsertRun(run: Run): Promise<void>;
  getRun(id: string): Promise<Run | undefined>;
  queryRuns(filter: RunFilter): Promise<Run[]>;

  // Sessions
  upsertSession(session: SessionRecord): Promise<void>;
  querySessions(filter: SessionFilter): Promise<SessionRecord[]>;
  getSessionRef(runId: string, sessionId: string): Promise<HarnessSessionRef | undefined>;

  // Session snapshots for dashboard viewing
  storeSessionSnapshot(snapshot: SessionSnapshot): Promise<void>;
  getSessionSnapshot(runId: string, sessionId: string): Promise<SessionSnapshot | undefined>;

  // Rollups
  upsertWorkflowRollup(rollup: WorkflowRollup): Promise<void>;
  upsertRoleRollup(rollup: RoleRollup): Promise<void>;
  queryWorkflowRollups(filter: RollupFilter): Promise<WorkflowRollup[]>;
  queryRoleRollups(filter: RollupFilter): Promise<RoleRollup[]>;
}
