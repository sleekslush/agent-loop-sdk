export type ModelRef = string;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface SessionTurnResult {
  text: string;
  usage?: TokenUsage;
  costUsd?: number;
  durationMs: number;
  isError: boolean;
}

export interface PromptOptions {
  // Harness-specific options are passed through opaquely.
  [key: string]: unknown;
}

export interface HarnessSessionRef {
  harness: string;
  sessionId?: string;
  sessionFile?: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessSession {
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

export type SessionExportFormat = "jsonl" | "html" | "markdown";

export interface AgentHarness {
  readonly name: string;
  createSession(config: SessionConfig): Promise<HarnessSession>;

  /**
   * Resume a session from a previously captured reference.
   * Optional: not all harnesses support resumption.
   */
  resumeSession?(ref: HarnessSessionRef, config?: SessionConfig): Promise<HarnessSession>;

  /**
   * Export a session to a viewable format.
   * Optional: not all harnesses support export.
   */
  exportSession?(ref: HarnessSessionRef, format: SessionExportFormat): Promise<string>;
}

export interface SessionConfig {
  model?: ModelRef;
  systemPrompt?: string;
  harnessOptions?: Record<string, unknown>;
}

export interface Trigger {
  id: string;
  source: string;
  type: string;
  payload: unknown;
  receivedAt: Date;
}

export interface SessionSpec {
  id: string;
  role: string;
  harness: string;
  model?: ModelRef;
  systemPrompt?: string;
  harnessOptions?: Record<string, unknown>;
  /**
   * Optional parser that extracts structured context from the session's text output.
   * The returned object is shallow-merged into `WorkflowState.context`.
   */
  parseOutput?: (
    output: string,
    state: WorkflowState,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * When true, the orchestrator asks the same session to summarize its own output
   * after the main turn completes. The summary is stored on the session state and
   * can be referenced by downstream transitions.
   */
  summarizeOutput?: boolean;
  /**
   * Custom prompt used when summarizeOutput is true. If omitted, a default prompt
   * is used.
   */
  summaryPrompt?: string;
}

export interface TransitionSpec {
  from: string | "start" | string[];
  to: string;
  when?: (state: WorkflowState) => boolean | Promise<boolean>;
  input?: string | ((state: WorkflowState) => string | Promise<string>);
}

export interface Constraints {
  maxIterations: number;
  maxSpendUsd?: number;
  maxWallClockMs?: number;
  allowedModels?: ModelRef[];
}

export interface ExitConditions {
  goalMet?: (state: WorkflowState) => boolean | Promise<boolean>;
  goalRejected?: (state: WorkflowState) => boolean | Promise<boolean>;
  onBudgetExhausted?: "fail" | "pause";
}

export interface Workflow {
  id: string;
  goal: string;
  sessions: SessionSpec[];
  transitions: TransitionSpec[];
  constraints: Constraints;
  exitConditions: ExitConditions;
}

export interface SessionState {
  id: string;
  role: string;
  harness: string;
  status: "idle" | "busy" | "error";
  lastOutput?: string;
  lastSummary?: string;
  usage: TokenUsage;
  costUsd: number;
}

export interface StepRecord {
  iteration: number;
  sessionId: string;
  prompt: string;
  output: string;
  costUsd: number;
  durationMs: number;
  timestamp: Date;
}

export interface WorkflowState {
  id: string;
  workflowId: string;
  trigger: Trigger;
  status: "running" | "waiting" | "completed" | "failed";
  currentSessionId?: string;
  iteration: number;
  spendUsd: number;
  startedAt: Date;
  endedAt?: Date;
  context: Record<string, unknown>;
  sessions: Record<string, SessionState>;
  history: StepRecord[];
  outcome?: "success" | "failure" | "paused";
  failureReason?: string;
}

export type HarnessEvent =
  | { type: "text_delta"; delta: string }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "error"; message: string };

export type OrchestratorEvent =
  | {
      type: "workflow.started";
      runId: string;
      workflowId: string;
      stateId: string;
      goal: string;
      triggerSource: string;
      constraints: Constraints;
    }
  | {
      type: "session.created";
      runId: string;
      sessionId: string;
      role: string;
      harness: string;
      model?: string;
      harnessSessionRef?: HarnessSessionRef;
    }
  | { type: "turn.started"; runId: string; sessionId: string; role: string; iteration: number }
  | {
      type: "turn.completed";
      runId: string;
      sessionId: string;
      role: string;
      iteration: number;
      durationMs: number;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: "turn.summarized";
      runId: string;
      sessionId: string;
      role: string;
      iteration: number;
      summary: string;
      durationMs: number;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
    }
  | { type: "constraint.breached"; runId: string; constraint: string; iteration: number }
  | {
      type: "workflow.completed";
      runId: string;
      workflowId: string;
      stateId: string;
      outcome: "success" | "failure" | "paused";
      failureReason?: string;
      iteration: number;
      spendUsd: number;
      durationMs: number;
    }
  | { type: "checkpoint.written"; stateId: string; path: string };
