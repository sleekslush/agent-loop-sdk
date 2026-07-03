import { mkdir, readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

function toIsoString(date: Date | undefined): string | undefined {
  return date?.toISOString();
}

function fromIsoString(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function readJsonlFile<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf-8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeJsonlFile<T>(path: string, records: T[]): Promise<void> {
  await ensureDir(dirname(path));
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  await writeFile(path, lines, "utf-8");
}

async function appendJsonlLine(path: string, record: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, JSON.stringify(record) + "\n", "utf-8");
}

async function upsertInJsonlFile<T extends { id: string }>(path: string, record: T): Promise<void> {
  const records = await readJsonlFile<T>(path);
  const index = records.findIndex((r) => r.id === record.id);
  if (index >= 0) {
    records[index] = record;
  } else {
    records.push(record);
  }
  await writeJsonlFile(path, records);
}

export interface JsonlObservationStoreOptions {
  baseDir: string;
}

export class JsonlObservationStore implements ObservationStore {
  private baseDir: string;
  private eventsDir: string;
  private runsFile: string;
  private sessionsFile: string;
  private workflowRollupsFile: string;
  private roleRollupsFile: string;

  constructor(options: JsonlObservationStoreOptions) {
    this.baseDir = options.baseDir;
    this.eventsDir = join(this.baseDir, "events");
    this.runsFile = join(this.baseDir, "runs.jsonl");
    this.sessionsFile = join(this.baseDir, "sessions.jsonl");
    this.workflowRollupsFile = join(this.baseDir, "rollups-workflow.jsonl");
    this.roleRollupsFile = join(this.baseDir, "rollups-role.jsonl");
  }

  async appendEvent(event: ObservationEvent): Promise<void> {
    const file = join(this.eventsDir, `${dateKey(event.timestamp)}.jsonl`);
    const serialized = {
      ...event,
      timestamp: toIsoString(event.timestamp),
    };
    await appendJsonlLine(file, serialized);
  }

  async queryEvents(filter: EventFilter = {}): Promise<ObservationEvent[]> {
    const types = filter.type ? (Array.isArray(filter.type) ? filter.type : [filter.type]) : undefined;
    let files: string[];
    try {
      files = (await readdir(this.eventsDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }

    const events: ObservationEvent[] = [];
    for (const file of files) {
      const lines = await readJsonlFile<Record<string, unknown>>(join(this.eventsDir, file));
      for (const line of lines) {
        const timestamp = fromIsoString(line.timestamp as string);
        if (!timestamp) continue;
        if (filter.from && timestamp.getTime() < filter.from.getTime()) continue;
        if (filter.to && timestamp.getTime() > filter.to.getTime()) continue;
        if (filter.runId && line.runId !== filter.runId) continue;
        if (filter.workflowId && line.workflowId !== filter.workflowId) continue;
        if (types && !types.includes(line.type as string)) continue;
        if (filter.sessionId && line.payload && (line.payload as Record<string, unknown>).sessionId !== filter.sessionId) {
          continue;
        }
        if (filter.role && line.payload && (line.payload as Record<string, unknown>).role !== filter.role) {
          continue;
        }
        events.push({
          id: line.id as string,
          runId: line.runId as string,
          workflowId: line.workflowId as string,
          type: line.type as string,
          timestamp,
          payload: (line.payload as Record<string, unknown>) ?? {},
        });
      }
    }

    events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (filter.limit !== undefined) {
      return events.slice(-filter.limit);
    }
    return events;
  }

  async upsertRun(run: Run): Promise<void> {
    const serialized: Record<string, unknown> = {
      ...run,
      startedAt: toIsoString(run.startedAt),
      endedAt: toIsoString(run.endedAt),
    };
    await upsertInJsonlFile(this.runsFile, serialized as { id: string });
  }

  async getRun(id: string): Promise<Run | undefined> {
    const runs = await this.readRuns();
    return runs.find((r) => r.id === id);
  }

  async queryRuns(filter: RunFilter = {}): Promise<Run[]> {
    let runs = await this.readRuns();
    runs = runs.filter((run) => {
      if (filter.workflowId && run.workflowId !== filter.workflowId) return false;
      if (!matchesValue(run.status, filter.status)) return false;
      if (!matchesValue(run.outcome, filter.outcome)) return false;
      if (!matchesDateRange(run.startedAt, filter.from, filter.to)) return false;
      return true;
    });

    runs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    const offset = filter.offset ?? 0;
    const limit = filter.limit;
    if (offset > 0 || limit !== undefined) {
      runs = runs.slice(offset, limit !== undefined ? offset + limit : undefined);
    }
    return runs;
  }

  private async readRuns(): Promise<Run[]> {
    const lines = await readJsonlFile<Record<string, unknown>>(this.runsFile);
    return lines.map((line) => ({
      id: line.id as string,
      workflowId: line.workflowId as string,
      goal: line.goal as string,
      status: line.status as Run["status"],
      outcome: line.outcome as Run["outcome"] | undefined,
      failureReason: line.failureReason as string | undefined,
      startedAt: new Date(line.startedAt as string),
      endedAt: line.endedAt ? new Date(line.endedAt as string) : undefined,
      durationMs: line.durationMs as number | undefined,
      iterationCount: line.iterationCount as number,
      totalCostUsd: line.totalCostUsd as number,
      triggerSource: line.triggerSource as string,
    }));
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    const serialized: Record<string, unknown> = {
      ...session,
    };
    await upsertInJsonlFile(this.sessionsFile, serialized as { id: string });
  }

  async querySessions(filter: SessionFilter = {}): Promise<SessionRecord[]> {
    const sessions = await this.readSessions();
    return sessions.filter((session) => {
      if (filter.runId && session.runId !== filter.runId) return false;
      if (filter.workflowId && session.workflowId !== filter.workflowId) return false;
      if (filter.sessionId && session.sessionId !== filter.sessionId) return false;
      if (filter.role && session.role !== filter.role) return false;
      return true;
    });
  }

  private async readSessions(): Promise<SessionRecord[]> {
    const lines = await readJsonlFile<SessionRecord>(this.sessionsFile);
    return lines;
  }

  async getSessionRef(runId: string, sessionId: string): Promise<HarnessSessionRef | undefined> {
    const sessions = await this.readSessions();
    const session = sessions.find((s) => s.runId === runId && s.sessionId === sessionId);
    return session?.harnessSessionRef;
  }

  async storeSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
    const file = join(this.baseDir, "snapshots", `${snapshot.runId}:${snapshot.sessionId}.jsonl`);
    const serialized = {
      ...snapshot,
      exportedAt: toIsoString(snapshot.exportedAt),
    };
    await ensureDir(dirname(file));
    await writeJsonlFile(file, [serialized]);
  }

  async getSessionSnapshot(runId: string, sessionId: string): Promise<SessionSnapshot | undefined> {
    const file = join(this.baseDir, "snapshots", `${runId}:${sessionId}.jsonl`);
    try {
      const lines = await readJsonlFile<Record<string, unknown>>(file);
      const line = lines[0];
      if (!line) return undefined;
      return {
        runId: line.runId as string,
        sessionId: line.sessionId as string,
        harness: line.harness as string,
        exportedAt: new Date(line.exportedAt as string),
        format: line.format as SessionSnapshot["format"],
        content: line.content as string,
      };
    } catch {
      return undefined;
    }
  }

  async upsertWorkflowRollup(rollup: WorkflowRollup): Promise<void> {
    const records = await readJsonlFile<WorkflowRollup>(this.workflowRollupsFile);
    const key = `${rollup.workflowId}:${rollup.period}`;
    const index = records.findIndex((r) => `${r.workflowId}:${r.period}` === key);
    if (index >= 0) {
      records[index] = rollup;
    } else {
      records.push(rollup);
    }
    await writeJsonlFile(this.workflowRollupsFile, records);
  }

  async upsertRoleRollup(rollup: RoleRollup): Promise<void> {
    const records = await readJsonlFile<RoleRollup>(this.roleRollupsFile);
    const key = `${rollup.workflowId}:${rollup.role}:${rollup.period}`;
    const index = records.findIndex((r) => `${r.workflowId}:${r.role}:${r.period}` === key);
    if (index >= 0) {
      records[index] = rollup;
    } else {
      records.push(rollup);
    }
    await writeJsonlFile(this.roleRollupsFile, records);
  }

  async queryWorkflowRollups(filter: RollupFilter = {}): Promise<WorkflowRollup[]> {
    const rollups = await this.readWorkflowRollups();
    return rollups.filter((rollup) => {
      if (filter.workflowId && rollup.workflowId !== filter.workflowId) return false;
      if (filter.period && rollup.period !== filter.period) return false;
      if (!matchesDateRange(new Date(rollup.period + "-01T00:00:00Z"), filter.from, filter.to)) return false;
      return true;
    });
  }

  async queryRoleRollups(filter: RollupFilter = {}): Promise<RoleRollup[]> {
    const rollups = await this.readRoleRollups();
    return rollups.filter((rollup) => {
      if (filter.workflowId && rollup.workflowId !== filter.workflowId) return false;
      if (filter.role && rollup.role !== filter.role) return false;
      if (filter.period && rollup.period !== filter.period) return false;
      if (!matchesDateRange(new Date(rollup.period + "-01T00:00:00Z"), filter.from, filter.to)) return false;
      return true;
    });
  }

  private async readWorkflowRollups(): Promise<WorkflowRollup[]> {
    return await readJsonlFile<WorkflowRollup>(this.workflowRollupsFile);
  }

  private async readRoleRollups(): Promise<RoleRollup[]> {
    return await readJsonlFile<RoleRollup>(this.roleRollupsFile);
  }
}
