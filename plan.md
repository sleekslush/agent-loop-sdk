# Agent Loop Orchestrator SDK — Updated Plan

## 1. Project Identity

This is a **TypeScript SDK** (pnpm workspace) for building goal‑driven agent loops on top of existing agent harnesses such as **pi coding agent**, with future support for harnesses like **OpenCode** or **Claude Code**. It is **not** a standalone application. Future use cases (Jira→MR, MR review, etc.) will be built by importing and configuring this SDK.

## 2. Updated Understanding of the Boundary

| In scope for the SDK | Out of scope (handled by the harness or the consumer) |
|---|---|
| Workflow definition & orchestration loop | Direct tool call execution |
| Session isolation and routing | Authentication to providers |
| Constraint enforcement (iterations, cost, time, models) | Skill/tool registration — harness already has these |
| State machine, checkpoints, observability | UI/TUI |
| Harness adapter interface + pi adapter | Concrete trigger endpoints (consumers wire webhooks/cron) |
| Push/pull trigger types | Actual external system integrations |

The harness (pi) is treated as the execution engine: it owns the model client, tools, skills, extensions, and auth. The SDK creates and drives **harness sessions**, feeding them prompts and reading their outputs. It never calls tools itself.

## 3. Best Modern Practice (2026)

- **SDK-first, not app-first**: expose composable primitives so callers define their own workflows.
- **Harness adapter pattern**: avoid leaking harness-specific types into the orchestrator. A clean adapter interface lets the SDK support pi today and other harnesses later.
- **Declarative workflows**: define sessions, goals, constraints, and transitions in code — type-safe, testable, versionable.
- **State machine + durable checkpoints**: the loop should survive crashes and be inspectable. Store workflow state, not harness session files.
- **Constraint-aware execution**: enforce budgets, iteration caps, wall-clock limits, and model allow-lists at the orchestrator layer.
- **Isolated sessions per concern**: each role (Jira reader, coder, reviewer, judge) runs in its own harness session with its own model, system prompt, and memory.
- **Event-driven observability**: emit structured events for every transition so consumers can log, audit, and build UIs.
- **No prompt-chain spaghetti**: the orchestrator decides *which session acts next* and what *context* to pass; the harness decides *how* to fulfill the prompt.
- **Let the harness be the agent**: the SDK does not reimplement tool parsing, tool execution, or model streaming. It uses the harness's native SDK.

## 4. Recommended Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Consumer App                            │
│  (Jira→MR workflow, MR review workflow, cron, webhook handler)  │
└───────────────────────┬─────────────────────────────────────────┘
                        │ imports
┌───────────────────────▼─────────────────────────────────────────┐
│              Agent Loop Orchestrator SDK                        │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │  Workflow   │  │    Loop      │  │   Constraint Tracker   │  │
│  │  Builder    │  │   Engine     │  │                        │  │
│  └─────────────┘  └──────┬───────┘  └────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────▼────────────────────────────────────┐  │
│  │              Harness Adapter Interface                      │  │
│  │  createSession() · prompt() · observe() · dispose()         │  │
│  └─────────────┬──────────────────────────────┬────────────────┘  │
│                │                              │                   │
│   ┌────────────▼──────────┐      ┌───────────▼────────────┐      │
│   │   Pi SDK Adapter      │      │  Future: OpenCode,     │      │
│   │  (@earendil-works/    │      │        Claude, etc.    │      │
│   │   pi-coding-agent)    │      │                        │      │
│   └───────────────────────┘      └────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Native pi SDK first**: the pi adapter uses `createAgentSession()` and `session.prompt()` from `@earendil-works/pi-coding-agent`.
2. **No tool execution in SDK**: the harness executes whatever tools/skills it has loaded. The SDK only reads final assistant messages or subscribed events.
3. **No auth management in SDK**: the harness resolves API keys, OAuth, and provider config.
4. **Workflow state is separate from harness session state**: harness sessions are ephemeral or reused per step; the SDK owns the durable workflow checkpoint.
5. **Adapters are swappable per session**: one workflow could theoretically mix harnesses per session, though pi-only is the initial target.

## 5. Core SDK Types

### 5.1 Harness Adapter Interface

```ts
interface AgentHarness {
  readonly name: string;

  createSession(config: SessionConfig): Promise<HarnessSession>;
}

interface HarnessSession {
  readonly id: string;
  readonly harness: string;

  prompt(text: string, options?: PromptOptions): Promise<SessionTurnResult>;
  // Optional: stream events for long-running tool chains
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  dispose(): void;
}

interface SessionConfig {
  model?: ModelRef;
  systemPrompt?: string;
  // Harness may honor additional options; SDK does not interpret them.
  harnessOptions?: Record<string, unknown>;
}

interface SessionTurnResult {
  text: string;
  usage?: TokenUsage;
  costUsd?: number;
  durationMs: number;
  isError: boolean;
}
```

### 5.2 Workflow Definition

```ts
interface Workflow {
  id: string;
  goal: string;
  sessions: SessionSpec[];
  transitions: TransitionSpec[];
  constraints: Constraints;
  exitConditions: ExitCondition[];
}

interface SessionSpec {
  id: string;
  role: string;                 // e.g. "jira", "coder", "reviewer", "judge"
  harness: string;              // adapter name, e.g. "pi"
  model?: ModelRef;
  systemPrompt?: string;
  harnessOptions?: Record<string, unknown>;
}

interface Constraints {
  maxIterations: number;
  maxSpendUsd?: number;
  maxWallClockMs?: number;
  allowedModels?: ModelRef[];
}

interface TransitionSpec {
  from: string | "start";
  to: string;
  when?: (state: WorkflowState) => boolean | Promise<boolean>;
  input?: (state: WorkflowState) => string;
}
```

### 5.3 Workflow State & Checkpoint

```ts
interface WorkflowState {
  id: string;
  status: "running" | "waiting" | "completed" | "failed";
  currentSessionId?: string;
  iteration: number;
  spendUsd: number;
  startedAt: Date;
  endedAt?: Date;
  context: Record<string, unknown>;   // shared, structured state
  sessions: Record<string, SessionState>;
  history: StepRecord[];
}

interface SessionState {
  id: string;
  role: string;
  harness: string;
  status: "idle" | "busy" | "error";
  lastOutput?: string;
  usage: TokenUsage;
  costUsd: number;
}
```

## 6. Agent Loop Lifecycle

```
+-----------+     +-------------------+     +------------------------+
|  Trigger  | --> | Load Workflow     | --> | Create Harness Sessions|
+-----------+     +-------------------+     +------------------------+
                                                    |
                    +-------------------------------+
                    v
          +---------------------+
          | Checkpoint: START   |
          +---------------------+
                    |
                    v
          +---------------------+
          | Evaluate exit       |<-------------------------------+
          +---------------------+                                |
                    |                                            |
        +-----------+-----------+                                |
        |                       |                                |
        v                       v                                |
   [goal met]              [continue]                            |
        |                       |                                |
        v                       v                                |
   [done]            +---------------------+                     |
                     | Select next session |                     |
                     +---------------------+                     |
                               |                                 |
                               v                                 |
                     +---------------------+                     |
                     | Build prompt from     |                   |
                     | shared context        |                   |
                     +---------------------+                     |
                               |                                 |
                               v                                 |
                     +---------------------+                     |
                     | Call harness session  |                   |
                     | (native SDK)          |                   |
                     +---------------------+                     |
                               |                                 |
                               v                                 |
                     +---------------------+                     |
                     | Parse output & update |                   |
                     | shared context        |                   |
                     +---------------------+                     |
                               |                                 |
                               v                                 |
                     +---------------------+                     |
                     | Update cost/iteration |                   |
                     +---------------------+                     |
                               |                                 |
                               v                                 |
                     +---------------------+                     |
                     | Checkpoint            |-------------------+
                     +---------------------+
```

### Loop responsibilities

1. **Load workflow** from consumer code.
2. **Create harness sessions** via the selected adapter.
3. **Select next session** using transition rules (explicit graph or evaluator).
4. **Build prompt**: inject relevant shared context; do not expose other sessions' internal outputs unless the workflow says so.
5. **Call harness**: run `session.prompt()` and wait for the turn to finish.
6. **Update context**: write the session's output into shared state under a well-known key.
7. **Enforce constraints**: increment iteration count; accumulate cost; fail fast if limits breached.
8. **Checkpoint** durable state.
9. **Evaluate exit conditions**: goal met, goal rejected, budget exhausted, manual gate.

## 7. Push vs Pull Triggers

The SDK exposes trigger types but does not run servers or cron itself. Consumers provide the trigger.

```ts
interface Trigger {
  id: string;
  source: string;       // "jira", "gitlab", "slack"
  type: string;         // "ticket.assigned", "mr.commented"
  payload: unknown;
  receivedAt: Date;
}
```

- **Pull**: consumer schedules a poll and calls `orchestrator.start(workflow, trigger)`.
- **Push**: consumer's webhook handler calls the same API.

No authentication or external API clients live in the SDK.

## 8. Pi Adapter Details

The pi adapter wraps `@earendil-works/pi-coding-agent`:

```ts
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

class PiHarnessSession implements HarnessSession {
  constructor(private session: AgentSession) {}

  async prompt(text: string): Promise<SessionTurnResult> {
    // subscribe to capture final text and usage
    // await session.prompt(text)
    // return summary
  }

  dispose() {
    this.session.dispose();
  }
}
```

### Notes

- Use `SessionManager.inMemory()` by default so the orchestrator controls lifecycle.
- Use `DefaultResourceLoader` so the harness still discovers skills, extensions, and context files the user already has.
- The adapter can optionally expose `subscribe()` to stream `turn_end` events for progress reporting.
- Model selection passes through to pi; the SDK can validate against `allowedModels`.

## 9. Example Use Cases (SDK Consumer View)

### 9.1 Jira → Implement → Review → MR

```ts
const workflow = defineWorkflow({
  goal: "Implement the assigned Jira ticket and open a merge request",
  sessions: [
    { id: "jira", role: "ticket-reader", harness: "pi", model: "claude-sonnet" },
    { id: "coder", role: "implementer", harness: "pi", model: "claude-opus" },
    { id: "reviewer", role: "reviewer", harness: "pi", model: "claude-sonnet" },
    { id: "submit", role: "publisher", harness: "pi", model: "claude-sonnet" },
  ],
  transitions: [
    { from: "start", to: "jira", input: (ctx) => `Fetch ticket ${ctx.trigger.payload.key}` },
    { from: "jira", to: "coder", input: (ctx) => `Implement this ticket:\n${ctx.sessions.jira.lastOutput}` },
    { from: "coder", to: "reviewer", input: (ctx) => `Review this implementation:\n${ctx.sessions.coder.lastOutput}` },
    { from: "reviewer", to: "coder", when: (ctx) => !ctx.context.approved, input: "Address review feedback" },
    { from: "reviewer", to: "submit", when: (ctx) => ctx.context.approved },
  ],
  constraints: { maxIterations: 20, maxSpendUsd: 5.0 },
  exitConditions: [goalMet(), budgetExhausted()],
});
```

Each session is isolated. The coder never sees the reviewer's internal deliberation directly; only the orchestrator routes feedback.

### 9.2 MR Notification → Multi‑Model Review → Judge → Comments

```ts
const workflow = defineWorkflow({
  goal: "Review the MR with multiple models and post high-quality comments",
  sessions: [
    { id: "fetcher", role: "diff-fetcher", harness: "pi" },
    { id: "reviewerA", role: "security-reviewer", harness: "pi", model: "model-a" },
    { id: "reviewerB", role: "architecture-reviewer", harness: "pi", model: "model-b" },
    { id: "reviewerC", role: "tests-reviewer", harness: "pi", model: "model-c" },
    { id: "judge", role: "review-consolidator", harness: "pi" },
    { id: "poster", role: "comment-poster", harness: "pi" },
  ],
  transitions: [
    { from: "start", to: "fetcher" },
    { from: "fetcher", to: ["reviewerA", "reviewerB", "reviewerC"] }, // parallel
    { from: ["reviewerA", "reviewerB", "reviewerC"], to: "judge" },
    { from: "judge", to: "poster" },
  ],
  constraints: { maxIterations: 12, maxSpendUsd: 3.0 },
});
```

The SDK may support parallel fan-out/fan-in or leave it to the consumer; for v1, sequential transitions are enough.

## 10. Constraint Enforcement

- **Iterations**: increment once per harness `prompt()` completion.
- **Spend**: adapter returns `costUsd` per turn; SDK sums.
- **Wall-clock**: check `Date.now() - startedAt` before each turn.
- **Models**: validate `session.model` against `allowedModels` before creating the session.
- **Actions on breach**: fail the workflow with `status: "failed"`, reason `constraint_breached`, and a checkpoint.

## 11. Observability

Emit typed events:

```ts
type OrchestratorEvent =
  | { type: "workflow.started"; workflowId: string }
  | { type: "session.created"; sessionId: string; harness: string }
  | { type: "turn.started"; sessionId: string; iteration: number }
  | { type: "turn.completed"; sessionId: string; durationMs: number; costUsd: number }
  | { type: "constraint.breached"; constraint: string }
  | { type: "workflow.completed"; workflowId: string; outcome: "success" | "failure" }
  | { type: "checkpoint.written"; checkpointId: string };
```

Consumers can subscribe to build logs, dashboards, or audit trails.

## 12. Repository Layout

```
agent-loop-sdk/
├── packages/
│   ├── core/              # loop engine, state machine, constraints, checkpoints
│   └── harness-pi/        # pi coding agent adapter
├── examples/
│   ├── minimal/           # basic consumer usage
│   └── jira-to-mr/        # Jira → implement → review → GitLab MR workflow
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── .gitignore
└── plan.md
```

## 13. Milestones

1. **M0 — Scaffold**: ✅ pnpm workspace, core types, harness interface, pi adapter, minimal example.
2. **M1 — Tests**: ✅ unit tests for constraints, state transitions, checkpoint I/O, orchestrator routing, and `parseOutput`.
3. **M2 — Use-case example**: ✅ Jira→MR consumer in `examples/jira-to-mr/`.
4. **M3 — Resilience**: retry boundaries, error handling, session recovery.
5. **M4 — Enhanced observability**: optional streaming events, cost dashboards.
6. **M5 — Future adapters**: validate OpenCode/Claude harness adapter interface.

## 14. Technology Decisions

### Confirmed
- Language: TypeScript
- Package manager: pnpm
- Runtime: Node.js (pi SDK requirement)
- First harness: `@earendil-works/pi-coding-agent`
- Checkpoint persistence: JSON files on disk
- Cost tracking: reported by the pi adapter from harness events
- Session execution: sequential in v1
- Transition model: explicit `from`/`to` graph with optional `when` guard and `input` builder
- Distribution: npm package only (no CLI)

### Transition Model Detail

The primary routing mechanism is an explicit graph:

```ts
interface TransitionSpec {
  from: string | "start" | string[];
  to: string;
  when?: (state: WorkflowState) => boolean | Promise<boolean>;
  input?: (state: WorkflowState) => string;
}
```

The loop selects the **first transition** where:
- `from` matches the current session (or `"start"`), and
- `when` is undefined or returns `true`.

If no transition matches, the workflow fails with `no_valid_transition`.

This model is declarative, type-safe, testable, and easy to visualize. Dynamic behavior (e.g., review loops) is handled by `when` guards. Future dynamic routing can be added as an optional `router` override without breaking the graph model.

### Pending Confirmation
None — all key decisions are confirmed. Ready to scaffold.
