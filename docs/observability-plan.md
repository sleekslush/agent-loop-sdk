# Observability Plan

> Goal: make agent-loop workflows observable through a queryable store that supports dashboards, CLIs, HTTP APIs, programmatic consumers, and later recall/viewing of specific harness sessions.

## Design principle

Observability data should live in a **queryable store** separate from checkpoints. The orchestrator emits events; a collector writes structured records; consumers query those records through a stable API.

The store must be:

- **Queryable** by workflow, session, role, model, time range, and outcome.
- **Aggregatable** for dashboards and summaries.
- **Pluggable** so heavy users can swap in SQLite while light users keep JSONL.
- **Self-contained** by default so the SDK works out of the box.
- **Recall-aware** so specific harness sessions can be reloaded and viewed later via the harness SDK.

---

## Storage adapters

The store is an interface with multiple adapter implementations. Consumers choose the adapter at configuration time.

```ts
type ObservationStoreConfig =
  | { type: "jsonl"; baseDir: string }
  | { type: "sqlite"; filePath: string };

function createObservationStore(config: ObservationStoreConfig): ObservationStore;
```

### JSONL adapter (default)

Append-friendly files in `.checkpoints/observations/`:

```
.checkpoints/
└── observations/
    ├── events/
    │   └── 2024-07-03.jsonl
    ├── runs.jsonl
    ├── sessions.jsonl
    ├── rollups-workflow.jsonl
    └── rollups-role.jsonl
```

- **Pros**: no dependencies, human-readable, works anywhere.
- **Cons**: queries scan files; slower at scale.
- **Best for**: development, local dogfooding, and low-volume deployments.

### SQLite adapter

Single SQLite file with indexed tables:

```ts
{ type: "sqlite", filePath: ".checkpoints/observations.sqlite" }
```

Tables:

- `events` — indexed by `run_id`, `workflow_id`, `type`, `timestamp`
- `runs` — indexed by `workflow_id`, `status`, `started_at`
- `sessions` — indexed by `run_id`, `workflow_id`, `role`
- `rollups_workflow` — indexed by `workflow_id`, `period`
- `rollups_role` — indexed by `workflow_id`, `role`, `period`

- **Pros**: fast queries, aggregations, and filtering.
- **Cons**: adds `better-sqlite3` or similar native dependency.
- **Best for**: production, dashboards, and long retention.

### Future adapters

- Postgres / any SQL store
- Prometheus (for metrics rollups only)
- In-memory (for testing)

---

## Data model

### 1. Raw events

Every orchestrator event is persisted as a typed record.

```ts
interface ObservationEvent {
  id: string;
  runId: string;
  workflowId: string;
  type: string;
  timestamp: Date;
  payload: Record<string, unknown>;
}
```

Event examples:

| Event type | Payload fields |
|---|---|
| `workflow.started` | `goal`, `triggerSource`, `constraints` |
| `session.created` | `sessionId`, `role`, `harness`, `model`, `harnessSessionRef` |
| `turn.started` | `sessionId`, `iteration`, `role` |
| `turn.completed` | `sessionId`, `role`, `iteration`, `durationMs`, `costUsd`, `inputTokens`, `outputTokens` |
| `constraint.breached` | `constraint`, `iteration` |
| `workflow.completed` | `outcome`, `failureReason`, `iteration`, `spendUsd`, `durationMs` |

### 2. Runs

A `Run` is a denormalized summary of one workflow execution.

```ts
interface Run {
  id: string;
  workflowId: string;
  goal: string;
  status: "running" | "completed" | "failed" | "paused";
  outcome?: "success" | "failure" | "paused";
  failureReason?: string;
  startedAt: Date;
  endedAt?: Date;
  durationMs?: number;
  iterationCount: number;
  totalCostUsd: number;
  triggerSource: string;
}
```

### 3. Sessions

A `SessionRecord` captures per-session aggregates and enough metadata to recall the harness session later.

```ts
interface HarnessSessionRef {
  harness: string;
  sessionId?: string;
  sessionFile?: string;
  metadata?: Record<string, unknown>;
}

interface SessionRecord {
  id: string;                 // composite: `${runId}:${sessionId}`
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
}
```

The `harnessSessionRef` is the key to recall. The SDK does not interpret it; the harness adapter does.

### 4. Metrics rollups

Pre-computed rollups for fast queries.

```ts
interface WorkflowRollup {
  workflowId: string;
  period: string;             // e.g. "2024-07"
  runs: number;
  successCount: number;
  failureCount: number;
  pauseCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
  totalIterations: number;
}

interface RoleRollup {
  workflowId: string;
  role: string;
  period: string;
  runs: number;
  turnCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
}
```

---

### 5. Session snapshots

A `SessionSnapshot` is a cached export of a harness session's transcript, used for dashboard viewing without requiring the harness or its original files.

```ts
type SessionExportFormat = "jsonl" | "html" | "markdown";

interface SessionSnapshot {
  runId: string;
  sessionId: string;
  harness: string;
  exportedAt: Date;
  format: SessionExportFormat;
  content: string;
}
```

Snapshots are produced by the harness adapter and stored by the observation store. See the harness integration section below for details.

---

## Harness SDK integration for session recall

Harnesses already persist their own session files (pi's JSONL, OpenCode's equivalent). The SDK should not duplicate that storage. Instead, it captures a lightweight reference and lets the harness resume it.

### SDK changes

Extend the harness adapter interface:

```ts
interface HarnessSessionRef {
  harness: string;
  sessionId?: string;
  sessionFile?: string;
  metadata?: Record<string, unknown>;
}

interface HarnessSession {
  readonly id: string;
  readonly harness: string;
  /**
   * Returns a reference the harness can use to resume this session later.
   * Optional: not all harnesses support resumption.
   */
  getRef?(): HarnessSessionRef;
  prompt(text: string, options?: PromptOptions): Promise<SessionTurnResult>;
  subscribe?(listener: (event: HarnessEvent) => void): () => void;
  dispose(): void;
}

interface AgentHarness {
  readonly name: string;
  createSession(config: SessionConfig): Promise<HarnessSession>;
  /**
   * Resume a session from a previously captured reference.
   * Optional: not all harnesses support resumption.
   */
  resumeSession?(ref: HarnessSessionRef, config?: SessionConfig): Promise<HarnessSession>;
}
```

### Pi adapter implementation

Pi's `AgentSession` already exposes `sessionId` and `sessionFile`. The pi adapter's `getRef()` returns those. `resumeSession()` uses pi's session manager to load the file.

```ts
class PiHarnessSession implements HarnessSession {
  getRef(): HarnessSessionRef {
    return {
      harness: "pi",
      sessionId: this.session.sessionId,
      sessionFile: this.session.sessionFile,
    };
  }
}
```

### Recall API

The observation store exposes session refs:

```ts
interface ObservationStore {
  getSessionRef(runId: string, sessionId: string): Promise<HarnessSessionRef | undefined>;
}
```

A consumer that wants to resume a session:

```ts
const ref = await store.getSessionRef(runId, "coder");
const harness = harnessMap.get(ref.harness);
const session = await harness.resumeSession!(ref);
await session.prompt("Continue from where we left off.");
```

Use cases:

- Resume a paused workflow from its last checkpoint.
- Re-open a specific reviewer session to ask follow-up questions.
- Debug a failed session by reloading it in the harness.

### Session viewing and snapshots

Session recall is not only for resumption. The observability dashboard must also display the full content of a harness session: the conversation, tool calls, and reasoning.

The harness adapter can export a session to a viewable format:

```ts
type SessionExportFormat = "jsonl" | "html" | "markdown";

interface SessionSnapshot {
  runId: string;
  sessionId: string;
  harness: string;
  exportedAt: Date;
  format: SessionExportFormat;
  content: string;
}

interface AgentHarness {
  createSession(config: SessionConfig): Promise<HarnessSession>;
  resumeSession?(ref: HarnessSessionRef, config?: SessionConfig): Promise<HarnessSession>;
  exportSession?(ref: HarnessSessionRef, format: SessionExportFormat): Promise<string>;
}
```

The observation store caches snapshots so dashboards can render them without requiring the harness or its original session files to be present:

```ts
interface ObservationStore {
  // ... other methods
  storeSessionSnapshot(snapshot: SessionSnapshot): Promise<void>;
  getSessionSnapshot(runId: string, sessionId: string): Promise<SessionSnapshot | undefined>;
}
```

Flow:

1. Workflow completes.
2. Collector calls `harness.exportSession(ref, "jsonl")` for each session.
3. Snapshot is stored in the observation store.
4. Dashboard queries `getSessionSnapshot(runId, sessionId)` and renders the transcript.

For pi, the adapter uses `session.exportToJsonl()` or `session.exportToHtml()`.

Dashboard session viewer features:

- Conversation transcript with assistant/user/tool messages.
- Collapsible tool inputs and outputs.
- Cost and token usage per turn.
- Highlight the turn that led to a transition.
- Link from a session view back to its parent run.

---

## Storage interface

```ts
interface ObservationStore {
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
```

---

## Query API

```ts
interface EventFilter {
  runId?: string;
  workflowId?: string;
  type?: string | string[];
  sessionId?: string;
  role?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

interface RunFilter {
  workflowId?: string;
  status?: Run["status"] | Run["status"][];
  outcome?: Run["outcome"] | Run["outcome"][];
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

interface SessionFilter {
  runId?: string;
  workflowId?: string;
  sessionId?: string;
  role?: string;
  from?: Date;
  to?: Date;
}

interface RollupFilter {
  workflowId?: string;
  role?: string;
  period?: string;
  from?: Date;
  to?: Date;
}

class ObservationClient {
  constructor(store: ObservationStore);

  getEvents(filter?: EventFilter): Promise<ObservationEvent[]>;
  getRun(id: string): Promise<Run | undefined>;
  getRuns(filter?: RunFilter): Promise<Run[]>;
  getRunCount(filter?: RunFilter): Promise<number>;
  getSessions(filter?: SessionFilter): Promise<SessionRecord[]>;
  getSessionRef(runId: string, sessionId: string): Promise<HarnessSessionRef | undefined>;
  getSessionSnapshot(runId: string, sessionId: string): Promise<SessionSnapshot | undefined>;
  getWorkflowMetrics(filter?: RollupFilter): Promise<WorkflowRollup[]>;
  getRoleMetrics(filter?: RollupFilter): Promise<RoleRollup[]>;
  getSuccessRate(filter?: RollupFilter): Promise<number>;
  getTotalSpend(filter?: RollupFilter): Promise<number>;
  getAverageDuration(filter?: RollupFilter): Promise<number>;
}
```

---

## Collector

The collector bridges orchestrator events to the store.

```ts
class ObservationCollector {
  constructor(store: ObservationStore);

  onEvent(
    event: OrchestratorEvent,
    context: { runId: string; workflowId: string },
    harnessSessionRef?: HarnessSessionRef,
  ): Promise<void>;

  /** Rebuild runs, sessions, and rollups from events. */
  reindex(): Promise<void>;
}
```

The orchestrator calls the collector as its `onEvent` callback. When a `session.created` event fires, the orchestrator should pass the harness session ref if the session provides one.

---

## CLI design

A future CLI package (`packages/cli`) or root script:

```bash
# List recent runs
agent-loop runs --workflow jira-to-mr --limit 10

# Show a single run
agent-loop run <run-id>

# Per-session cost breakdown
agent-loop sessions --run <run-id>

# Recall a session in the harness
agent-loop resume <run-id> <session-id>

# View a cached session snapshot (transcript)
agent-loop session <run-id> <session-id> --format html

# Aggregates
agent-loop metrics --workflow jira-to-mr --from 2024-07-01 --to 2024-07-31

# Success rate and cost by role
agent-loop success-rate --workflow jira-to-mr
agent-loop cost-by-role --workflow jira-to-mr
```

Output formats: `table` (default), `json`, `csv`.

---

## HTTP API design

Optional server exposing the `ObservationClient`:

```ts
// GET /runs?workflowId=jira-to-mr&status=completed&limit=10
// GET /runs/:id
// GET /runs/:id/sessions
// GET /runs/:id/sessions/:sessionId/ref
// GET /runs/:id/sessions/:sessionId/snapshot
// GET /events?runId=:id&type=turn.completed
// GET /metrics/workflows?workflowId=jira-to-mr&from=...&to=...
// GET /metrics/roles?workflowId=jira-to-mr
// GET /health
```

Dashboards and external tools can query this without SDK access.

---

## Dashboard design

Two options:

1. **Static HTML dashboard**: CLI generates an HTML file from the store.
   ```bash
   agent-loop dashboard --output dashboard.html
   ```

2. **Web dashboard**: React/Vue app backed by the HTTP API.

Suggested widgets:

- Runs over time
- Success / failure / paused ratio
- Cost by workflow and by role
- Average duration by workflow
- Recent runs table
- Top expensive runs
- Sessions available for recall / viewing
- Session transcript viewer

---

## Pi extension integration

The pi extension:

- Creates an `ObservationCollector` per run.
- Passes harness session refs from pi sessions into the collector.
- Shows live cost/iteration widget.
- Posts post-run summaries.
- Adds commands:
  - `/agentloop runs`
  - `/agentloop metrics`
  - `/agentloop view <run-id> <session-id>`
  - `/agentloop resume <run-id> <session-id>` (reloads the pi session)

---

## Implementation phases

1. **M1 — Storage adapters**
   - Define `ObservationStore` interface.
   - Implement JSONL adapter.
   - Implement SQLite adapter.
   - Add `createObservationStore(config)` factory.

2. **M2 — Event enrichment & session refs**
   - Add `getRef()` and `resumeSession()` to harness interface.
   - Implement in pi adapter.
   - Add `harnessSessionRef` to `session.created` events.

3. **M3 — Session snapshots**
   - Add `exportSession()` to harness interface.
   - Implement in pi adapter using `session.exportToJsonl()` / `exportToHtml()`.
   - Add snapshot storage methods to adapters.

4. **M4 — Collector**
   - Build `ObservationCollector`.
   - Capture harness session refs.
   - Export snapshots on workflow completion.
   - Add `reindex()`.

5. **M5 — Query client**
   - Implement `ObservationClient`.
   - Add convenience methods.

6. **M6 — CLI**
   - Add `runs`, `run`, `sessions`, `resume`, `session`, `metrics` commands.

7. **M7 — HTTP API & dashboard**
   - Optional server package.
   - Static HTML dashboard generator with session viewer.

---

## Open questions

1. Should SQLite be a required dependency, or an optional peer dependency?
2. How should rollups be computed — eagerly on every event, or lazily on query?
3. Should session refs be encrypted or normalized if observations are shared?
4. How long should observations be retained by default?
5. Should the HTTP API support write operations, or read-only queries?
