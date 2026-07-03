import { randomUUID } from "node:crypto";
import type {
  SessionSpec,
  SessionState,
  StepRecord,
  Trigger,
  Workflow,
  WorkflowState,
} from "./types.js";

export function createInitialState(
  workflow: Workflow,
  trigger: Trigger,
): WorkflowState {
  const id = randomUUID();
  const sessions: Record<string, SessionState> = {};

  for (const spec of workflow.sessions) {
    sessions[spec.id] = createEmptySessionState(spec);
  }

  return {
    id,
    workflowId: workflow.id,
    trigger,
    status: "running",
    iteration: 0,
    spendUsd: 0,
    startedAt: new Date(),
    context: {},
    sessions,
    history: [],
  };
}

export function createEmptySessionState(spec: SessionSpec): SessionState {
  return {
    id: spec.id,
    role: spec.role,
    harness: spec.harness,
    status: "idle",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
    costUsd: 0,
  };
}

export function recordTurn(
  state: WorkflowState,
  sessionId: string,
  prompt: string,
  result: {
    text: string;
    costUsd?: number;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
  },
): WorkflowState {
  const cost = result.costUsd ?? 0;
  const inputTokens = result.inputTokens ?? 0;
  const outputTokens = result.outputTokens ?? 0;
  const session = state.sessions[sessionId];

  const step: StepRecord = {
    iteration: state.iteration + 1,
    sessionId,
    prompt,
    output: result.text,
    costUsd: cost,
    durationMs: result.durationMs,
    timestamp: new Date(),
  };

  return {
    ...state,
    iteration: state.iteration + 1,
    spendUsd: state.spendUsd + cost,
    currentSessionId: sessionId,
    sessions: {
      ...state.sessions,
      [sessionId]: {
        ...session,
        status: "idle",
        lastOutput: result.text,
        costUsd: session.costUsd + cost,
        usage: {
          inputTokens: session.usage.inputTokens + inputTokens,
          outputTokens: session.usage.outputTokens + outputTokens,
        },
      },
    },
    history: [...state.history, step],
  };
}

export function markCompleted(
  state: WorkflowState,
  outcome: "success" | "failure" | "paused",
  reason?: string,
): WorkflowState {
  return {
    ...state,
    status: outcome === "success" ? "completed" : "failed",
    outcome,
    failureReason: reason,
    endedAt: new Date(),
  };
}
