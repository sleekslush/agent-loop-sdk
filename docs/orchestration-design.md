# Agent Loop Orchestration Design

## Goal

Allow a human to launch, monitor, and understand many independent agent-loop
workflows from anywhere — a pi coding agent session, a webhook, the CLI, or a
harness extension — with full observability, cost attribution, and the ability
to define reusable specialized workflows ahead of time.

## Core idea

`@agent-loop/core` is a **single-loop SDK**: one `Orchestrator` instance runs
one `Workflow` to completion. This design adds a thin **multi-loop
orchestration framework** on top of the existing engine so that many workflow
runs can be launched, tracked, and attributed from any trigger source.

The framework is intentionally:

- **Generic**: not tied to any trigger source, harness, or workflow shape.
- **Observable by design**: every trigger, loop, session, turn, and cost is
  recorded through the existing observability layer.
- **Hierarchical**: orchestration pipelines contain orchestrations, which
  contain loops, which contain sessions, which contain turns.
- **Recursion-friendly**: a loop can request sibling loops or sub-orchestrations.
- **Trigger-agnostic**: pi sessions, webhooks, CLI commands, and harness
  extensions all produce the same `Trigger` shape and start the same machinery.
- **Grounded in the existing SDK**: the higher-level runtime is a composition of
  the current `Orchestrator`, `defineWorkflow`, `compileAiWorkflow`, and
  observability primitives rather than a rewrite.

> **Design status.** The single-loop engine, pi harness adapter, pi extension,
> and observability store are implemented in `@agent-loop/core`. The higher-level
> `OrchestrationRuntime`, `OrchestrationPipeline`, and standalone consumers
> described below are the intended next layer; they reuse the existing types
> and event model unchanged.

## Alignment with project principles

| Principle | How this design honors it |
|---|---|
| **SDK first, app never** | The framework exposes composable primitives (`OrchestrationRuntime`, `LoopAdapter`, `TriggerSource`). It does not run a server, cron runner, webhook receiver, or dashboard in the SDK. CLI commands query data; they do not host services. |
| **Harness adapter pattern** | `packages/core` remains harness-agnostic. Anything pi-specific stays in `packages/harness-pi/` and `packages/pi-extension/`. New harnesses are supported by adding `HarnessSession` adapters, not by changing the runtime. |
| **No tool execution in the SDK** | The runtime never calls Jira, GitLab, Obsidian, or external HTTP APIs. Trigger sources and harness sessions own all tool execution. |
| **No auth management in the SDK** | Auth (OAuth, HMAC, TLS, pi auth) is the host's or harness's responsibility. Trigger sources deliver already-verified triggers to the runtime. |
| **Isolated sessions** | Every loop gets its own harness sessions. Sessions do not share prompts or tool results implicitly. Routing happens through the orchestrator's shared `WorkflowState`. |
| **Constraints at the orchestrator layer** | Iteration caps, spend limits, wall-clock timeouts, and model allow-lists are enforced by the `Orchestrator` engine and by the `OrchestrationPipeline` concurrency/backpressure controls, not by harnesses. |
| **Durable checkpoints** | Workflow state is checkpointed by the single-loop engine after every turn. The runtime additionally persists orchestration metadata, trigger idempotency indices, and queue state in a durable operational store so it can recover after restart. |

## Terminology

| Term | Meaning |
|---|---|
| **`Orchestrator`** | The existing single-loop engine class in `@agent-loop/core`. |
| **`OrchestrationPipeline`** | A configured, dashboardable pipeline for a class of work (e.g., "Jira→MR", "Obsidian note processor"). |
| **`Orchestration`** | One independent execution instance spawned by a pipeline (e.g., "implement AC-123"). |
| **`Loop`** | A single workflow run inside an orchestration, executed by the existing `Orchestrator` engine. |
| **`LoopRuntime`** | The handle returned by a `LoopAdapter` for one running loop. |
| **`LoopAdapter`** | An adapter that knows how to run a particular kind of loop (today the agent-loop `Orchestrator`). |
| **`Session`** | A harness session inside a loop (a role with its own model and system prompt). |
| **`Turn`** | One prompt/response cycle within a session. |
| **`Trigger`** | The normalized payload that causes an orchestration to be created. |
| **`TriggerSource`** | A consumer-provided adapter that produces triggers and pushes them to the runtime. |
| **`TriggerSink`** | The runtime surface a `TriggerSource` calls to enqueue a trigger. |

## Trigger model

The framework is source-agnostic because every source converts its external
event into the same `Trigger` shape. The runtime only understands `Trigger`; it
does not understand pi conversations, webhook bodies, or Jira tickets.

### `Trigger` interface

```ts
export interface TriggerContext {
  /** Human or service that requested the work. */
  requestedBy?: string;
  /** Correlates this trigger with an external trace. */
  correlationId?: string;
  /** Conversation / session id from the source (e.g., pi thread id). */
  conversationId?: string;
  /** Project or working directory the source was operating on. */
  projectPath?: string;
  /** Source-specific extension fields. */
  [key: string]: unknown;
}

export interface Trigger {
  /** Source-assigned identifier. Must be unique within a reasonable window. */
  id: string;
  /** Registered source id, e.g. "pi-extension", "webhook", "cli". */
  source: string;
  /** Domain event type, e.g. "manual", "ticket.assigned", "note.modified". */
  type: string;
  /** Strictly opaque domain payload. The runtime does not inspect it. */
  payload: unknown;
  /** Standardized source metadata envelope. */
  context: TriggerContext;
  /** Lower number = higher priority. Default 0. Only honored when the pipeline enables priority ordering. */
  priority?: number;
  /** ISO-8601 deadline. Behavior is determined by the pipeline's deadlinePolicy: "reorder" moves overdue triggers to the front; "cancel" rejects them. */
  deadline?: string;
  /** If provided, the runtime deduplicates triggers with the same key + scope. */
  idempotencyKey?: string;
  /** Scope in which idempotency is enforced. Default: pipeline id. */
  idempotencyScope?: string;
  /** ISO-8601 timestamp when the source received the external event. */
  receivedAt: string;
}
```

Required fields: `id`, `source`, `type`, `payload`, `receivedAt`. All other
fields are source-provided hints. `payload` is opaque; the pipeline's
`buildLoopConfig` is the only place allowed to interpret it.

### `TriggerSource` and `TriggerSink` interfaces

A trigger source is **push-based**: the source decides when a trigger exists
and calls `sink.enqueueTrigger`. The runtime decides whether to accept it
based on queue depth and rate limits.

```ts
export interface TriggerSink {
  /**
   * Enqueue a trigger. Resolves with the orchestration id once the trigger
   * is persisted. Rejects if backpressure limits are exceeded.
   */
  enqueueTrigger(trigger: Trigger): Promise<string>;
}

export interface TriggerSource {
  readonly id: string;
  start(sink: TriggerSink): Promise<void> | void;
  stop(signal?: AbortSignal): Promise<void> | void;
  health?(): Promise<{ ok: boolean; message?: string }>;
}
```

Error handling: if a source throws, it is responsible for logging and retrying.
The runtime treats `enqueueTrigger` rejections as backpressure signals.

### Source-specific envelopes

Sources may define their own `TriggerContext` extensions, but they must
document the schema. Examples:

- **pi extension**: `context.projectPath`, `context.conversationId`,
  `context.requestedBy`.
- **webhook adapter (consumer-built)**: `context.sourceIp`,
  `context.webhookId`, `context.signatureVerified`.
- **CLI**: `context.requestedBy` (the OS user), `context.shellSessionId`.

The `payload` remains source-specific and opaque to the runtime.

### Auth boundary

The runtime does not verify signatures, tokens, or OAuth. Every trigger source
must authenticate and authorize the external event before constructing a
`Trigger`. The runtime assumes a trigger delivered to `enqueueTrigger` is
already trusted.

## Trigger sources

### 1. Pi coding agent session

The pi extension (`@agent-loop/pi-extension`) registers commands and a tool:

- `/agentloop <goal>` — design and run an orchestration from a goal.
- `/agentloop design <goal>` — design a workflow and run it.
- `/agentloop run <workflow-id> [args]` — run a predefined workflow as an orchestration.
- `run_agent_loop` tool — lets pi decide to spawn an orchestration itself.

The extension packages pi context into `Trigger.context` (not `payload`) and
calls `pipeline.enqueueTrigger(trigger)`. It also uses
`compileAiWorkflow(aiWorkflow, { defaultHarness: "pi" })` to turn an
AI-friendly JSON workflow into an executable `Workflow` object.

The extension is a consumer of the SDK. In the default deployment it embeds
the runtime in-process as a library; if a host wants a remote runtime, the host
provides the transport and passes the runtime reference to the extension.

### 2. Webhook

Webhook handling is a **consumer responsibility**. The SDK does not run an
HTTP server, terminate TLS, or verify HMAC signatures. A host application can
implement a `TriggerSource` that runs its own server, verifies auth, and calls
`sink.enqueueTrigger`.

```ts
function createWebhookSource(options: {
  id: string;
  path: string;
  port: number;
  toTrigger: (req: unknown) => Trigger;
}): TriggerSource {
  return {
    id: options.id,
    start(sink) {
      // host-managed HTTP server, auth, TLS
      this.server = createServer((req, res) => {
        if (req.url !== options.path) return;
        const trigger = options.toTrigger(req);
        sink.enqueueTrigger(trigger)
          .then((orchestrationId) => {
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ orchestrationId }));
          })
          .catch(() => {
            res.writeHead(503);
            res.end();
          });
      }).listen(options.port);
    },
    async stop() {
      this.server?.close();
    },
  };
}
```

The source returns `202 Accepted` with the orchestration id as soon as the
trigger is persisted.

### 3. CLI

The CLI (`@agent-loop/cli`) is a consumer of the SDK. It can trigger
orchestrations and inspect results, but it does not host a server.

```bash
agent-loop orchestrate --pipeline jira-to-mr --trigger '{"ticketKey":"AC-123"}'
agent-loop pipelines list
agent-loop orchestrations list --pipeline jira-to-mr
agent-loop orchestration show <id>
agent-loop orchestration logs --follow <id>
```

The `dashboard` command is intentionally **not** part of the CLI; the dashboard
is a separate application (`@agent-loop/dashboard`) that consumes the
observability store.

### 4. Harness extension

A harness extension can import the runtime or an in-process client:

```ts
import { OrchestrationClient } from "@agent-loop/orchestra";

const client = new OrchestrationClient(runtime);
const orchestrationId = await client
  .pipeline("jira-to-mr")
  .enqueueTrigger({
    id: "manual-1",
    source: "harness-extension",
    type: "manual",
    payload: { ticketKey: "AC-123" },
    context: { requestedBy: "user@example.com" },
    receivedAt: new Date().toISOString(),
  });
```

`OrchestrationClient` is a thin wrapper around `OrchestrationRuntime`. It is
in-process by default; remote access is a host concern outside the SDK.

## Reusable workflows

A workflow is defined once and reused across triggers. Workflows can be:

- **Registered by id** in a pipeline config.
- **Referenced by path** from a consumer app.
- **Designed on the fly** by an AI planner session.

### Defining workflows in code

`defineWorkflow` validates the workflow up front (including model allow-lists)
and returns a `Workflow` object that can be stored, versioned, and reused.

```ts
import { defineWorkflow } from "@agent-loop/core";

export const jiraToMrWorkflow = defineWorkflow({
  id: "jira-to-mr",
  version: "1.0.0",
  goal: "Implement the assigned Jira ticket and open a GitLab merge request",
  sessions: [
    {
      id: "jira",
      role: "ticket-reader",
      harness: "pi",
      model: "claude-sonnet-4-20250514",
      systemPrompt: "You have access to Jira skills...",
      parseOutput: parseJiraMoverOutput,
    },
    {
      id: "coder",
      role: "implementer",
      harness: "pi",
      model: "claude-opus-4-5",
      systemPrompt: "You are a senior TypeScript engineer...",
    },
    {
      id: "reviewer",
      role: "reviewer",
      harness: "pi",
      model: "claude-sonnet-4-20250514",
      systemPrompt: "You are a thorough code reviewer...",
      parseOutput: parseReviewerOutput,
    },
    {
      id: "submitter",
      role: "publisher",
      harness: "pi",
      model: "claude-sonnet-4-20250514",
      systemPrompt: "You have access to Git skills...",
      parseOutput: parseSubmitterOutput,
    },
  ],
  transitions: [
    { from: "start", to: "jira", input: (state) => `Fetch Jira ticket ${ticketKey(state)}...` },
    { from: "jira", to: "coder", input: (state) => `Implement the changes...` },
    { from: "coder", to: "reviewer", input: (state) => `Review this implementation...` },
    { from: "reviewer", to: "coder", when: (state) => state.context.approved !== true, input: (state) => `Address the feedback...` },
    { from: "reviewer", to: "submitter", when: (state) => state.context.approved === true },
    { from: "submitter", to: "jira", input: (state) => `Transition Jira ticket...` },
  ],
  constraints: {
    maxIterations: 20,
    maxSpendUsd: 10.0,
    modelAllowList: [
      "claude-sonnet-4-20250514",
      "claude-opus-4-5",
    ],
  },
  exitConditions: {
    goalMet: (state) => state.currentSessionId === "jira" && state.context.ticketMoved === true,
  },
});
```

### Workflow registry and pipeline config

A pipeline registers reusable workflows and maps incoming triggers to a loop
configuration:

```ts
const runtime = new OrchestrationRuntime({
  workflows: {
    "jira-to-mr": jiraToMrWorkflow,
    "note-processor": noteProcessorWorkflow,
  },
});

runtime.registerPipeline({
  id: "jira-to-mr",
  loopAdapter: workflowLoopAdapter,
  buildLoopConfig: (trigger, orchestrationId) => ({
    workflow: runtime.getWorkflow("jira-to-mr"),
    trigger,
    orchestrationId,
    harnesses: [new PiHarness()],
  }),
  maxConcurrentOrchestrations: 4,
  maxQueueDepth: 100,
  priority: true,
  deadlinePolicy: "reorder",
  perSourceRateLimits: {
    "webhook": { maxPerSecond: 5 },
  },
});
```

`registerPipeline` accepts a typed `LoopAdapter` instance, so the config type
is tied to the adapter at compile time.

### AI-designed workflows

For ad-hoc goals, an AI planner emits an AI-friendly JSON workflow
(`AiWorkflow`). `compileAiWorkflow` compiles it into an executable `Workflow`
with JavaScript expressions for guards and `{{path}}` templates for prompts.

Guard expressions run in a **restricted evaluator** (e.g., QuickJS or an
isolated VM) with:

- a short execution timeout,
- no network, file system, or process access,
- read-only access to the current `WorkflowState` context.

```ts
import { compileAiWorkflow, validateAiWorkflow } from "@agent-loop/core";

const aiWorkflow = extractJson<AiWorkflow>(plannerResponse);
const errors = validateAiWorkflow(aiWorkflow);
if (errors.length > 0) throw new Error(errors.join("; "));

const workflow = compileAiWorkflow(aiWorkflow, { defaultHarness: "pi" });
```

### Versioning

Every `Workflow` carries a `version` field. When an orchestration starts, the
runtime copies the workflow reference used at that moment. In-flight
orchestrations continue using the version they started with; new
orchestrations use the latest registered version.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Human Interfaces                                │
│   Dashboard app  ·  CLI  ·  Pi extension  ·  Host HTTP API                  │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
        ┌─────────────────────────▼─────────────────────────┐
        │              OrchestrationRuntime                 │
        │   (registers pipelines, workflows, sources)       │
        └──────────────┬────────────────────┬───────────────┘
                       │                    │
        ┌──────────────▼─────┐    ┌─────────▼──────────┐
        │ Orchestrator       │    │ Orchestrator       │
        │ Pipeline           │    │ Pipeline           │
        │ "jira-to-mr"       │    │ "obsidian-notes"   │
        └──────────┬─────────┘    └─────────┬──────────┘
                   │                        │
        ┌──────────▼──────────┐  ┌──────────▼──────────┐
        │   TriggerSource     │  │   TriggerSource     │
        │   Jira webhook      │  │   Obsidian watcher  │
        │   (consumer-built)  │  │   (consumer-built)  │
        └─────────────────────┘  └─────────────────────┘

                   │
                   ▼
        ┌─────────────────────┐
        │   Orchestration     │   ← one per trigger
        │   (AC-123 run)      │
        └──────────┬──────────┘
                   │
        ┌──────────▼──────────┐
        │        Loop         │   ← agent-loop Orchestrator engine
        │   (jira-to-mr)      │
        └──────────┬──────────┘
                   │
        ┌──────────▼──────────┐
        │   Harness Session   │   ← pi coding agent
        └─────────────────────┘
```

The loop engine is the current `@agent-loop/core` `Orchestrator`. The runtime
wraps it so that many loops can be launched and observed from any trigger
source.

## Runtime behavior & lifecycle

### Enqueue vs await completion

`OrchestrationPipeline.enqueueTrigger(trigger)` is the primary entry point. It
resolves once the orchestration is persisted and enqueued, **not** when it
completes. Callers that need to wait can use the returned id with
`runtime.getOrchestration(id).awaitCompletion()`.

```ts
const orchestrationId = await pipeline.enqueueTrigger(trigger);
await runtime.getOrchestration(orchestrationId).awaitCompletion();
```

This gives webhooks a synchronous id and long-running callers a clear await
path.

### Concurrency and backpressure

`OrchestrationPipelineConfig` carries explicit limits:

```ts
interface OrchestrationPipelineConfig<TLoopConfig> {
  id: string;
  loopAdapter: LoopAdapter<TLoopConfig>;
  buildLoopConfig(trigger: Trigger, orchestrationId: string): TLoopConfig;
  maxConcurrentOrchestrations?: number;   // default: unlimited
  maxQueueDepth?: number;                 // default: unlimited
  /** Order queued triggers by priority then receivedAt. Default false (FIFO). */
  priority?: boolean;
  /** How to handle deadline on queued triggers. Default "reorder". */
  deadlinePolicy?: "reorder" | "cancel";
  defaultIdempotencyScope?: string;
  perSourceRateLimits?: Record<string, RateLimitConfig>;
  /** Maximum depth of sub-orchestration recursion. Default 5. */
  maxSubOrchestrationDepth?: number;
}
```

If `maxQueueDepth` is reached, `enqueueTrigger` rejects. Sources handle the
rejection as a backpressure signal (e.g., webhook returns `503`).

### Idempotency and deduplication

`Trigger.idempotencyKey` plus `Trigger.idempotencyScope` enable safe retries.

- If an orchestration with the same key + scope already exists (pending or
  completed), `enqueueTrigger` returns the existing orchestration id.
- If no `idempotencyKey` is provided, every trigger creates a new
  orchestration.
- The default scope is the pipeline id. Scope `"global"` deduplicates across
  all pipelines.

The runtime persists the idempotency index alongside orchestration metadata.

### Trigger durability

The runtime guarantees **at-most-once execution per successfully enqueued
trigger** (deduplicated by idempotency key). Sources that need at-least-once
delivery must retry failed enqueue attempts and include the same
`idempotencyKey`; the runtime deduplicates on retry.

If the runtime crashes after `enqueueTrigger` resolves but before the loop
starts, the orchestration record is recovered from the durable orchestration
log on startup and resumed.

### Cancellation

`Orchestration.cancel(reason)` propagates through an abort chain:

```text
Orchestration.cancel()
  └── LoopRuntime.cancel()
       └── Orchestrator.cancel()
            └── HarnessSession.cancel()
```

`LoopContext` exposes an `AbortSignal`. The loop adapter registers an abort
handler and forwards it to the underlying `Orchestrator` / harness session.
Harnesses that support aborting in-flight LLM calls will stop promptly;
otherwise the loop finishes the current turn, checkpoints, and exits as
cancelled. A configurable drain timeout allows the runtime to force-stop a
loop that does not respond.

### Sub-orchestrations and recursion

A running loop can request a sub-orchestration through `LoopContext`:

```ts
interface LoopContext {
  readonly runtime: OrchestrationRuntime;
  readonly orchestration: Orchestration;
  readonly loopId: string;
  readonly trace: TraceContext;
  readonly abortSignal: AbortSignal;
  /** Request a sub-orchestration. Resolves when the child is created. */
  requestSpawn(request: SpawnRequest): Promise<SpawnResult>;
}

interface SpawnRequest {
  pipelineId: string;
  triggerOverrides?: Partial<Trigger>;
  inputContext?: unknown;
}

interface SpawnResult {
  orchestrationId: string;
  /** Resolves when the child orchestration completes. */
  awaitCompletion(): Promise<OrchestrationResult>;
}

interface OrchestrationResult {
  outcome: "success" | "failure" | "cancelled" | "timed_out";
  result?: unknown;
  failureReason?: string;
}
```

The runtime creates a child `Orchestration` with `parentOrchestrationId` set,
synthesizes a trigger for it, and returns a `SpawnResult`. The parent can
await `spawnResult.awaitCompletion()` to receive the child's result.

For sub-orchestrations, the runtime synthesizes a trigger with:

- `id`: a new uuid
- `source`: `"sub-orchestration"`
- `type`: `"spawn"`
- `payload`: `{ inputContext }`
- `context`: `{ parentOrchestrationId, parentLoopId, requestedBy: "runtime" }`
- `receivedAt`: current ISO timestamp

`triggerOverrides` merge on top of these defaults.

State sharing rules:

- The parent passes a **shallow-immutable context snapshot** to the child via
  `inputContext`.
- The child receives the snapshot in its trigger context.
- The child writes results back through an explicit `result` payload attached
  to its completion event.
- There is **no shared mutable state** between parent and child.

Recursion safety:

- Each pipeline config has `maxSubOrchestrationDepth` (default 5).
- The runtime tracks depth and rejects spawn requests that would exceed it.
- Cycle detection is implicit because each sub-orchestration gets a new id and
  cannot directly spawn its own parent (the parent awaits the child result).

## Loop adapter abstraction

### `LoopRuntime` and `LoopContext`

```ts
interface LoopRuntime<TState = unknown> {
  readonly id: string;
  readonly type: string;
  readonly state: TState;
  start(): Promise<void>;
  cancel(reason?: string): void;
  awaitCompletion(): Promise<void>;
  subscribe(): AsyncIterable<LoopEvent>;
}

interface LoopContext {
  readonly runtime: OrchestrationRuntime;
  readonly orchestration: Orchestration;
  readonly loopId: string;
  readonly trace: TraceContext;
  readonly abortSignal: AbortSignal;
  requestSpawn(request: SpawnRequest): Promise<SpawnResult>;
}
```

### `LoopAdapter`

```ts
interface LoopAdapter<TConfig = unknown> {
  readonly type: string;
  create(config: TConfig, context: LoopContext): LoopRuntime;
  dispose?(): Promise<void>;
}
```

The agent-loop adapter delegates to the existing `Orchestrator`:

```ts
const workflowLoopAdapter: LoopAdapter<WorkflowLoopConfig> = {
  type: "agent-loop/workflow",
  create(config, context) {
    return new WorkflowLoopRuntime(config, context);
  },
};
```

`WorkflowLoopRuntime` wraps the `Orchestrator` engine, forwards events to the
runtime, and converts cancellation into the engine's abort signal.

## Observability

### Event hierarchy

Every event carries trace identifiers:

```ts
interface TraceContext {
  pipelineId: string;
  orchestrationId: string;
  parentOrchestrationId?: string;
  loopId?: string;
  parentLoopId?: string;
  sessionId?: string;
  turnId?: string;
  source: string;
}
```

Existing engine events:

- `workflow.started`
- `session.created`
- `turn.started`
- `turn.completed`
- `turn.summarized`
- `constraint.breached`
- `checkpoint.written`
- `workflow.completed`

Orchestration framework events:

- `pipeline.created`
- `orchestration.created`
- `orchestration.loop.started`
- `orchestration.loop.failed`
- `orchestration.loop.cancelled`
- `orchestration.loop.timed_out`
- `orchestration.sub.created`
- `orchestration.sub.completed`
- `orchestration.sub.failed`
- `orchestration.completed`
- `orchestration.failed`
- `orchestration.cancelled`
- `orchestration.timed_out`
- `decision`

Failure/cancellation events include `reason` and optional `error` fields.

### Decision events

Every choice is recorded with rationale and a state snapshot subset:

```ts
interface DecisionEvent {
  type: "decision";
  trace: TraceContext;
  decisionType: "transition" | "exit" | "spawn" | "model_selection" | "retry" | "constraint_action";
  input: {
    availableOptions: unknown[];
    stateSnapshot: unknown;
  };
  output: {
    selectedOption: unknown;
    reason: string;
  };
  /** Cumulative cost of the orchestration/loop at the moment of the decision. */
  costAtDecision?: CostSnapshot;
  timestamp: Date;
}
```

### Cost model and attribution

Token counts come from harness `turn.completed` events. USD cost is computed
by an injectable `CostModel`:

```ts
interface TokenUsage {
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface CostModel {
  compute(usage: TokenUsage): CostSnapshot;
}

interface CostSnapshot {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model: string;
  provider?: string;
}
```

If a harness provides its own cost in the turn event, that value overrides the
model's computation.

`ObservationCollector` no longer depends on harness instances. All required
metadata (`role`, `model`, `harness`, `provider`) is emitted in
`session.created` events.

Cost can be broken down by:

- pipeline
- orchestration
- loop / workflow version
- session / role
- model / provider
- trigger source
- time period

### Storage, privacy, and retention

The runtime uses **two distinct stores**:

1. **Durable operational store** — owned by `packages/orchestra`. It persists
   queue state, idempotency indices, orchestration metadata, and pipeline
   configuration so the runtime can recover after a restart. It is small,
   structured, and must be durable in production (SQLite by default).
2. **Observability store** — interfaces defined in `@agent-loop/core`
   (`ObservationStore`), concrete implementations in `packages/core` today.
   It stores events, runs, sessions, rollups, and snapshots for dashboards,
   CLI queries, and post-hoc analysis. It can use `jsonl`, `sqlite`, or `memory`
   depending on retention and query needs.

The two stores may share a SQLite file for convenience, but they are logically
separate. The operational store is internal to the runtime; the observability
store is a public query surface.

```ts
interface DurableStore {
  /** Persist an orchestration record. */
  putOrchestration(record: OrchestrationRecord): Promise<void>;
  /** Load an orchestration record by id. */
  getOrchestration(id: string): Promise<OrchestrationRecord | undefined>;
  /** List orchestrations, optionally filtered by pipeline or status. */
  queryOrchestrations(filter?: OrchestrationFilter): Promise<OrchestrationRecord[]>;
  /** Persist a queued trigger awaiting start. */
  enqueueTrigger(pipelineId: string, trigger: Trigger, orchestrationId: string): Promise<void>;
  /** Load queued triggers in order. */
  getQueuedTriggers(pipelineId?: string): Promise<QueuedTrigger[]>;
  /** Remove a queued trigger once it has started. */
  ackTrigger(orchestrationId: string): Promise<void>;
  /** Persist or update an idempotency index entry. */
  setIdempotency(scope: string, key: string, orchestrationId: string): Promise<void>;
  /** Look up an existing orchestration by idempotency scope + key. */
  getIdempotency(scope: string, key: string): Promise<string | undefined>;
}
```

The observability store is pluggable:

- `jsonl` — append-friendly files, no dependencies.
- `sqlite` — single SQLite file with indexed tables.
- `memory` — for tests and short-lived usage.

Privacy controls:

```ts
interface ObservationConfig {
  /** How long to keep each event class (seconds). undefined = forever. */
  retention?: {
    turnEvents?: number;
    decisionEvents?: number;
    checkpointEvents?: number;
  };
  /** Sample decision events (0..1). */
  sampling?: { decisionEvents?: number };
  /** Redact sensitive fields before storage. */
  redaction?: (path: string, value: unknown) => unknown;
  /** Include full state snapshots in decision events. */
  includeStateSnapshots?: boolean;
}
```

Decision events may contain secrets, PII, or large prompts. Production hosts
should either disable `includeStateSnapshots` or provide a `redaction`
function.

### Human views

1. **Live view** — what's running now, current loop/session/turn, budget remaining.
2. **Decision log** — every decision with rationale, alternatives, state snapshot subset, and cost.
3. **Cost explorer** — tree and charts by all dimensions.
4. **Replay view** — step through an orchestration's events and watch state evolve.

The dashboard application consumes the observability store's event stream
(preferably Server-Sent Events or a long-lived async iterator) rather than
polling. The store exposes:

```ts
store.subscribe(filter?: EventFilter): AsyncIterable<OrchestrationFrameworkEvent>;
```

## Interfaces summary

### Current SDK interfaces

Implemented today in `@agent-loop/core`:

```ts
class Orchestrator {
  constructor(options: OrchestratorOptions);
  start(workflow: Workflow, state?: WorkflowState, trigger?: Trigger): Promise<WorkflowState>;
  cancel(reason?: string): void;
}

function defineWorkflow(workflow: Workflow): Workflow;
function compileAiWorkflow(aiWorkflow: AiWorkflow, options: CompileOptions): Workflow;
function validateAiWorkflow(aiWorkflow: AiWorkflow): string[];

function createObservationStore(config: ObservationStoreConfig): ObservationStore;
class ObservationCollector { onEvent(event: OrchestratorEvent): Promise<void>; reindex(): Promise<void>; }
class ObservationClient { /* paginated queries and rollups */ }
```

### Proposed orchestration layer interfaces

```ts
interface RuntimeOptions {
  /** Durable operational store for queue state, idempotency, and orchestration metadata. */
  durableStore: DurableStore;
  /** Observability store for events, runs, sessions, rollups, and snapshots. */
  observationStore: ObservationStore;
  /** Cost model used to convert token usage to USD. */
  costModel?: CostModel;
  /** Maximum time to wait for in-flight orchestrations during stop(). Default 30s. */
  drainTimeoutMs?: number;
  /** Global concurrency cap across all pipelines. Default unlimited. */
  globalMaxConcurrentOrchestrations?: number;
  /** Configurable privacy/retention settings for observation data. */
  observationConfig?: ObservationConfig;
}

class OrchestrationRuntime {
  constructor(options?: RuntimeOptions);

  registerWorkflow(id: string, workflow: Workflow): void;
  getWorkflow(id: string): Workflow;

  registerPipeline(config: OrchestrationPipelineConfig): OrchestrationPipeline;
  getPipeline(id: string): OrchestrationPipeline;

  attachTriggerSource(pipelineId: string, source: TriggerSource): void;

  start(): Promise<void>;
  stop(): Promise<void>;

  getOrchestration(id: string): Orchestration;
  subscribe(filter?: EventFilter): AsyncIterable<OrchestrationFrameworkEvent>;
  getDashboardModel(): Promise<DashboardModel>;
}

class OrchestrationPipeline {
  readonly id: string;

  enqueueTrigger(trigger: Trigger): Promise<string>;
  createOrchestration(options?: OrchestrationOptions): Promise<Orchestration>;

  getOrchestrations(filter?: OrchestrationFilter): Promise<OrchestrationSummary[]>;
  getStats(): Promise<OrchestrationPipelineStats>;
}

class Orchestration {
  readonly id: string;
  readonly pipelineId: string;
  readonly parentOrchestrationId?: string;

  /**
   * Start an additional loop in this orchestration using the supplied adapter.
   * Most callers use the pipeline-registered adapter; this method exists for
   * orchestrations that need to mix loop types.
   */
  startLoop<TConfig>(adapter: LoopAdapter<TConfig>, config: TConfig): Promise<LoopRuntime>;
  createSubOrchestration(pipelineId: string, options?: SubOrchestrationOptions): Promise<Orchestration>;

  getState(): OrchestrationState;
  getStats(): Promise<OrchestrationStats>;
  subscribe(): AsyncIterable<OrchestrationFrameworkEvent>;
  getLoops(filter?: LoopFilter): Promise<LoopSummary[]>;
  getSubOrchestrations(filter?: OrchestrationFilter): Promise<OrchestrationSummary[]>;

  awaitCompletion(): Promise<void>;
  cancel(reason?: string): void;
}

class OrchestrationClient {
  constructor(runtime: OrchestrationRuntime);
  pipeline(id: string): OrchestrationPipeline;
}
```

`OrchestrationPipelineStats`, `OrchestrationStats`, `DashboardModel`, `RateLimitConfig`,
`OrchestrationOptions`, `SubOrchestrationOptions`, `OrchestrationFilter`,
`LoopFilter`, `LoopSummary`, and `OrchestrationSummary` are implementation-defined
support types derived from the event and state models above.

## Repository structure

Current and proposed layout (all new packages stay in the existing monorepo
until boundaries stabilize):

```
agent-loop-sdk/
├── packages/
│   ├── core/                    # single-loop engine + observability interfaces
│   │   ├── src/types.ts
│   │   ├── src/engine.ts
│   │   ├── src/ai-workflow.ts
│   │   ├── src/constraints.ts
│   │   ├── src/state.ts
│   │   ├── src/checkpoint.ts
│   │   └── src/observability/
│   ├── harness-pi/              # pi SDK adapter
│   ├── pi-extension/            # pi extension, skill, and setup command
│   ├── orchestra/               # multi-loop runtime + observability store
│   ├── orchestra-adapter-agent-loop/  # adapter wrapping Orchestrator engine
│   ├── cli/                     # CLI consumer (no server)
│   ├── dashboard/               # separate dashboard application (optional)
│   └── integration-tests/
│       └── src/
│           ├── engine.integration.test.ts
│           └── orchestra.integration.test.ts
├── examples/
│   ├── minimal/
│   ├── jira-to-mr/              # consumer example
│   ├── source-webhook/          # example webhook adapter
│   ├── source-jira/             # example Jira trigger source
│   └── source-obsidian/         # example Obsidian trigger source
├── docs/
│   ├── observability.md
│   └── orchestration-design.md
├── plan.md
└── README.md
```

`orchestra` owns the runtime and store. `orchestra-adapter-agent-loop` owns the
bridge from the runtime to the existing `Orchestrator` engine. `core` remains
the single-loop engine.

## Deployment & operations

### Runtime startup and recovery

On startup the runtime:

1. Loads registered workflows and pipelines from host configuration.
2. Attaches trigger sources.
3. Replays the durable orchestration log to resume in-flight orchestrations.
4. Resumes queued triggers whose orchestrations had not yet started.
5. Exposes a health check aggregating pipeline and source health.

### Graceful shutdown

`runtime.stop()`:

1. Stops accepting new triggers (sources stop first).
2. Waits for already-enqueued triggers to start or be checkpointed.
3. Sends cancellation to in-flight orchestrations.
4. Waits for a configurable drain timeout.
5. Writes final checkpoints.

### Monitoring the runtime

The runtime emits its own operational metrics:

- triggers enqueued / rejected / deduplicated per pipeline and source
- orchestrations active / queued / completed / failed / cancelled
- loop adapter creation and disposal counts
- queue depth vs. `maxQueueDepth`
- time from trigger to loop start
- cost rollups

These are stored in the same observability store and surfaced in the dashboard
under a "Runtime health" view.

## Decisions and rationale

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Should trigger sources run continuously as a daemon, or be invoked per trigger by a host app? | Sources are **consumer-provided adapters** that may run continuously or per-trigger. The SDK only defines the `TriggerSource` interface. | Keeps the SDK free of servers and daemon logic. |
| 2 | Should the framework dedupe triggers by id, or create a new orchestration every time? | Dedupe by `idempotencyKey` + `idempotencyScope`. Without a key, every trigger creates a new orchestration. | Webhooks and CLI scripts retry; idempotency is essential. |
| 3 | Should webhooks return the orchestration id synchronously? | Yes. `enqueueTrigger` resolves once persisted and returns the id. Completion is awaited separately. | Required for HTTP-friendly fire-and-forget triggers. |
| 4 | Should multiple trigger sources feed one pipeline? | Yes. A pipeline can attach many sources. Rate limits are per-source. | Useful for combining manual CLI triggers with webhooks. |
| 5 | Should the dashboard update live or on refresh? | Live, via the observability store's event stream (Server-Sent Events / async iterator). | Polling adds latency and load; the event model already supports streaming. |
| 6 | Should decision events store full state snapshots or only relevant subsets? | Store **configurable** subsets. Default to a redacted/limited snapshot; raw snapshots opt-in. | State may contain secrets, PII, or large prompts. |
| 7 | How should sub-orchestrations share `WorkflowState` context with their parent loops? | Parent passes an immutable snapshot; child returns a result payload. No shared mutable state. | Prevents race conditions and makes recursion deterministic. |
| 8 | Should the runtime expose a synchronous "enqueue trigger" API for high-throughput sources? | Yes: `enqueueTrigger(trigger): Promise<string>` returns the id once persisted; completion is awaited separately. | Separates acceptance from execution and supports backpressure. |
| 9 | Where do webhook/Jira/Obsidian adapters live? | As **examples** or separate application repos, not SDK packages. | Honoring "SDK first, app never" and "No tool execution in the SDK." |
| 10 | Where does the dashboard live? | As a separate `@agent-loop/dashboard` application, not part of the CLI or core SDK. | Dashboards are applications, not SDK primitives. |
| 11 | How is cost computed? | By an injectable `CostModel` that maps token usage to USD. Harness-provided cost overrides the model. | Token pricing varies by provider and deployment; the SDK must not hard-code prices. |
| 12 | How are loops cancelled? | Through an `AbortSignal` chain from `Orchestration` → `LoopRuntime` → `Orchestrator` → `HarnessSession`. | Standard, composable, and harness-agnostic. |