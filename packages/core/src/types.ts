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

export interface HarnessSession {
  readonly id: string;
  readonly harness: string;

  prompt(text: string, options?: PromptOptions): Promise<SessionTurnResult>;
  subscribe?(listener: (event: HarnessEvent) => void): () => void;
  dispose(): void;
}

export interface AgentHarness {
  readonly name: string;
  createSession(config: SessionConfig): Promise<HarnessSession>;
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
  | { type: "workflow.started"; workflowId: string; stateId: string }
  | { type: "session.created"; sessionId: string; harness: string }
  | { type: "turn.started"; sessionId: string; iteration: number }
  | { type: "turn.completed"; sessionId: string; iteration: number; durationMs: number; costUsd: number }
  | { type: "constraint.breached"; constraint: string }
  | { type: "workflow.completed"; workflowId: string; stateId: string; outcome: "success" | "failure" | "paused" }
  | { type: "checkpoint.written"; stateId: string; path: string };
