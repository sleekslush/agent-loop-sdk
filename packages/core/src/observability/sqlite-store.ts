import type {
  EventFilter,
  ObservationEvent,
  ObservationStore,
  Run,
  RunFilter,
  SessionFilter,
  SessionRecord,
  SessionSnapshot,
  RollupFilter,
  RoleRollup,
  WorkflowRollup,
} from "./types.js";
import type { HarnessSessionRef } from "../types.js";

function optionalIn(filter: string | string[] | undefined): string | undefined {
  if (filter === undefined) return undefined;
  if (Array.isArray(filter)) return filter.map((v) => `'${v}'`).join(",");
  return `'${filter}'`;
}

function whereClause(conditions: string[]): string {
  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

export interface SqliteObservationStoreOptions {
  filePath: string;
}

export class SqliteObservationStore implements ObservationStore {
  private filePath: string;
  private db: SqliteDb | undefined;

  constructor(options: SqliteObservationStoreOptions) {
    this.filePath = options.filePath;
  }

  private async getDb(): Promise<SqliteDb> {
    if (this.db) return this.db;
    let DatabaseCtor: new (path: string) => unknown;
    try {
      const mod = await import("better-sqlite3");
      DatabaseCtor = (mod as { default: new (path: string) => unknown }).default;
    } catch {
      throw new Error(
        `SQLite observation store requires "better-sqlite3" to be installed. ` +
          `Install it with: pnpm add better-sqlite3`,
      );
    }
    const db = new DatabaseCtor(this.filePath) as SqliteDb;
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
      CREATE INDEX IF NOT EXISTS idx_events_workflow_id ON events(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        failure_reason TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        iteration_count INTEGER NOT NULL,
        total_cost_usd REAL NOT NULL,
        trigger_source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_workflow_id ON runs(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        harness TEXT NOT NULL,
        model TEXT,
        turn_count INTEGER NOT NULL,
        total_cost_usd REAL NOT NULL,
        total_duration_ms INTEGER NOT NULL,
        total_input_tokens INTEGER NOT NULL,
        total_output_tokens INTEGER NOT NULL,
        harness_session_ref TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_run_id ON sessions(run_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_workflow_id ON sessions(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_role ON sessions(role);

      CREATE TABLE IF NOT EXISTS snapshots (
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        exported_at INTEGER NOT NULL,
        format TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (run_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS rollups_workflow (
        workflow_id TEXT NOT NULL,
        period TEXT NOT NULL,
        runs INTEGER NOT NULL,
        success_count INTEGER NOT NULL,
        failure_count INTEGER NOT NULL,
        pause_count INTEGER NOT NULL,
        total_cost_usd REAL NOT NULL,
        total_duration_ms INTEGER NOT NULL,
        total_iterations INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, period)
      );
      CREATE INDEX IF NOT EXISTS idx_rollups_workflow_period ON rollups_workflow(period);

      CREATE TABLE IF NOT EXISTS rollups_role (
        workflow_id TEXT NOT NULL,
        role TEXT NOT NULL,
        period TEXT NOT NULL,
        runs INTEGER NOT NULL,
        turn_count INTEGER NOT NULL,
        total_cost_usd REAL NOT NULL,
        total_duration_ms INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, role, period)
      );
      CREATE INDEX IF NOT EXISTS idx_rollups_role_period ON rollups_role(period);
    `);
    this.db = db;
    return db;
  }

  async appendEvent(event: ObservationEvent): Promise<void> {
    const db = await this.getDb();
    const stmt = db.prepare(
      `INSERT INTO events (id, run_id, workflow_id, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      event.id,
      event.runId,
      event.workflowId,
      event.type,
      event.timestamp.getTime(),
      JSON.stringify(event.payload),
    );
  }

  async queryEvents(filter: EventFilter = {}): Promise<ObservationEvent[]> {
    const db = await this.getDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.runId) {
      conditions.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.workflowId) {
      conditions.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    if (filter.type) {
      const values = optionalIn(filter.type);
      if (values) {
        conditions.push(`type IN (${values})`);
      }
    }
    if (filter.from) {
      conditions.push("timestamp >= ?");
      params.push(filter.from.getTime());
    }
    if (filter.to) {
      conditions.push("timestamp <= ?");
      params.push(filter.to.getTime());
    }

    let sql = `SELECT * FROM events ${whereClause(conditions)} ORDER BY timestamp ASC`;
    if (filter.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(filter.limit);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    return rows
      .filter((row) => {
        if (filter.sessionId) {
          const payload = JSON.parse(row.payload as string) as Record<string, unknown>;
          if (payload.sessionId !== filter.sessionId) return false;
        }
        if (filter.role) {
          const payload = JSON.parse(row.payload as string) as Record<string, unknown>;
          if (payload.role !== filter.role) return false;
        }
        return true;
      })
      .map((row) => ({
        id: row.id as string,
        runId: row.run_id as string,
        workflowId: row.workflow_id as string,
        type: row.type as string,
        timestamp: new Date(row.timestamp as number),
        payload: JSON.parse(row.payload as string) as Record<string, unknown>,
      }));
  }

  async upsertRun(run: Run): Promise<void> {
    const db = await this.getDb();
    const stmt = db.prepare(
      `INSERT INTO runs (id, workflow_id, goal, status, outcome, failure_reason, started_at, ended_at, duration_ms, iteration_count, total_cost_usd, trigger_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workflow_id = excluded.workflow_id,
         goal = excluded.goal,
         status = excluded.status,
         outcome = excluded.outcome,
         failure_reason = excluded.failure_reason,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         duration_ms = excluded.duration_ms,
         iteration_count = excluded.iteration_count,
         total_cost_usd = excluded.total_cost_usd,
         trigger_source = excluded.trigger_source`,
    );
    stmt.run(
      run.id,
      run.workflowId,
      run.goal,
      run.status,
      run.outcome ?? null,
      run.failureReason ?? null,
      run.startedAt.getTime(),
      run.endedAt?.getTime() ?? null,
      run.durationMs ?? null,
      run.iterationCount,
      run.totalCostUsd,
      run.triggerSource,
    );
  }

  async getRun(id: string): Promise<Run | undefined> {
    const db = await this.getDb();
    const stmt = db.prepare("SELECT * FROM runs WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  private rowToRun(row: Record<string, unknown>): Run {
    return {
      id: row.id as string,
      workflowId: row.workflow_id as string,
      goal: row.goal as string,
      status: row.status as Run["status"],
      outcome: (row.outcome as Run["outcome"] | null | undefined) ?? undefined,
      failureReason: (row.failure_reason as string | null | undefined) ?? undefined,
      startedAt: new Date(row.started_at as number),
      endedAt: row.ended_at ? new Date(row.ended_at as number) : undefined,
      durationMs: (row.duration_ms as number | null | undefined) ?? undefined,
      iterationCount: row.iteration_count as number,
      totalCostUsd: row.total_cost_usd as number,
      triggerSource: row.trigger_source as string,
    };
  }

  async queryRuns(filter: RunFilter = {}): Promise<Run[]> {
    const db = await this.getDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.workflowId) {
      conditions.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    if (filter.status) {
      const values = optionalIn(filter.status);
      if (values) conditions.push(`status IN (${values})`);
    }
    if (filter.outcome) {
      const values = optionalIn(filter.outcome);
      if (values) conditions.push(`outcome IN (${values})`);
    }
    if (filter.from) {
      conditions.push("started_at >= ?");
      params.push(filter.from.getTime());
    }
    if (filter.to) {
      conditions.push("started_at <= ?");
      params.push(filter.to.getTime());
    }

    let sql = `SELECT * FROM runs ${whereClause(conditions)} ORDER BY started_at DESC`;
    if (filter.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(filter.limit);
    }
    if (filter.offset !== undefined) {
      sql += ` OFFSET ?`;
      params.push(filter.offset);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToRun(row));
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    const db = await this.getDb();
    const stmt = db.prepare(
      `INSERT INTO sessions (id, run_id, workflow_id, session_id, role, harness, model, turn_count, total_cost_usd, total_duration_ms, total_input_tokens, total_output_tokens, harness_session_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         run_id = excluded.run_id,
         workflow_id = excluded.workflow_id,
         session_id = excluded.session_id,
         role = excluded.role,
         harness = excluded.harness,
         model = excluded.model,
         turn_count = excluded.turn_count,
         total_cost_usd = excluded.total_cost_usd,
         total_duration_ms = excluded.total_duration_ms,
         total_input_tokens = excluded.total_input_tokens,
         total_output_tokens = excluded.total_output_tokens,
         harness_session_ref = excluded.harness_session_ref`,
    );
    stmt.run(
      session.id,
      session.runId,
      session.workflowId,
      session.sessionId,
      session.role,
      session.harness,
      session.model ?? null,
      session.turnCount,
      session.totalCostUsd,
      session.totalDurationMs,
      session.totalInputTokens,
      session.totalOutputTokens,
      session.harnessSessionRef ? JSON.stringify(session.harnessSessionRef) : null,
    );
  }

  async querySessions(filter: SessionFilter = {}): Promise<SessionRecord[]> {
    const db = await this.getDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.runId) {
      conditions.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.workflowId) {
      conditions.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    if (filter.sessionId) {
      conditions.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.role) {
      conditions.push("role = ?");
      params.push(filter.role);
    }

    const sql = `SELECT * FROM sessions ${whereClause(conditions)}`;
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToSessionRecord(row));
  }

  async getSessionRef(runId: string, sessionId: string): Promise<HarnessSessionRef | undefined> {
    const sessions = await this.querySessions({ runId, sessionId });
    return sessions[0]?.harnessSessionRef;
  }

  async storeSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
    const db = await this.getDb();
    const stmt = db.prepare(
      `INSERT INTO snapshots (run_id, session_id, harness, exported_at, format, content)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, session_id) DO UPDATE SET
         harness = excluded.harness,
         exported_at = excluded.exported_at,
         format = excluded.format,
         content = excluded.content`,
    );
    stmt.run(
      snapshot.runId,
      snapshot.sessionId,
      snapshot.harness,
      snapshot.exportedAt.getTime(),
      snapshot.format,
      snapshot.content,
    );
  }

  async getSessionSnapshot(runId: string, sessionId: string): Promise<SessionSnapshot | undefined> {
    const db = await this.getDb();
    const stmt = db.prepare("SELECT * FROM snapshots WHERE run_id = ? AND session_id = ?");
    const row = stmt.get(runId, sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id as string,
      sessionId: row.session_id as string,
      harness: row.harness as string,
      exportedAt: new Date(row.exported_at as number),
      format: row.format as SessionSnapshot["format"],
      content: row.content as string,
    };
  }

  async upsertWorkflowRollup(rollup: WorkflowRollup): Promise<void> {
    const db = await this.getDb();
    const stmt = db.prepare(
      `INSERT INTO rollups_workflow (workflow_id, period, runs, success_count, failure_count, pause_count, total_cost_usd, total_duration_ms, total_iterations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, period) DO UPDATE SET
         runs = excluded.runs,
         success_count = excluded.success_count,
         failure_count = excluded.failure_count,
         pause_count = excluded.pause_count,
         total_cost_usd = excluded.total_cost_usd,
         total_duration_ms = excluded.total_duration_ms,
         total_iterations = excluded.total_iterations`,
    );
    stmt.run(
      rollup.workflowId,
      rollup.period,
      rollup.runs,
      rollup.successCount,
      rollup.failureCount,
      rollup.pauseCount,
      rollup.totalCostUsd,
      rollup.totalDurationMs,
      rollup.totalIterations,
    );
  }

  async upsertRoleRollup(rollup: RoleRollup): Promise<void> {
    const db = await this.getDb();
    const stmt = db.prepare(
      `INSERT INTO rollups_role (workflow_id, role, period, runs, turn_count, total_cost_usd, total_duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, role, period) DO UPDATE SET
         runs = excluded.runs,
         turn_count = excluded.turn_count,
         total_cost_usd = excluded.total_cost_usd,
         total_duration_ms = excluded.total_duration_ms`,
    );
    stmt.run(
      rollup.workflowId,
      rollup.role,
      rollup.period,
      rollup.runs,
      rollup.turnCount,
      rollup.totalCostUsd,
      rollup.totalDurationMs,
    );
  }

  async queryWorkflowRollups(filter: RollupFilter = {}): Promise<WorkflowRollup[]> {
    const db = await this.getDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.workflowId) {
      conditions.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    if (filter.period) {
      conditions.push("period = ?");
      params.push(filter.period);
    }

    const sql = `SELECT * FROM rollups_workflow ${whereClause(conditions)}`;
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      workflowId: row.workflow_id as string,
      period: row.period as string,
      runs: row.runs as number,
      successCount: row.success_count as number,
      failureCount: row.failure_count as number,
      pauseCount: row.pause_count as number,
      totalCostUsd: row.total_cost_usd as number,
      totalDurationMs: row.total_duration_ms as number,
      totalIterations: row.total_iterations as number,
    }));
  }

  async queryRoleRollups(filter: RollupFilter = {}): Promise<RoleRollup[]> {
    const db = await this.getDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.workflowId) {
      conditions.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    if (filter.role) {
      conditions.push("role = ?");
      params.push(filter.role);
    }
    if (filter.period) {
      conditions.push("period = ?");
      params.push(filter.period);
    }

    const sql = `SELECT * FROM rollups_role ${whereClause(conditions)}`;
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      workflowId: row.workflow_id as string,
      role: row.role as string,
      period: row.period as string,
      runs: row.runs as number,
      turnCount: row.turn_count as number,
      totalCostUsd: row.total_cost_usd as number,
      totalDurationMs: row.total_duration_ms as number,
    }));
  }

  private rowToSessionRecord(row: Record<string, unknown>): SessionRecord {
    const refText = row.harness_session_ref as string | null | undefined;
    return {
      id: row.id as string,
      runId: row.run_id as string,
      workflowId: row.workflow_id as string,
      sessionId: row.session_id as string,
      role: row.role as string,
      harness: row.harness as string,
      model: (row.model as string | null | undefined) ?? undefined,
      turnCount: row.turn_count as number,
      totalCostUsd: row.total_cost_usd as number,
      totalDurationMs: row.total_duration_ms as number,
      totalInputTokens: row.total_input_tokens as number,
      totalOutputTokens: row.total_output_tokens as number,
      harnessSessionRef: refText ? (JSON.parse(refText) as HarnessSessionRef) : undefined,
    };
  }
}

// Minimal interface for the better-sqlite3 Database methods we use, avoiding a
// hard compile-time dependency on the package or its type declarations.
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface SqliteStatement {
  run(...params: unknown[]): void;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
