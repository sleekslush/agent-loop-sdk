import type {
  AgentHarness,
  HarnessSession,
  OrchestratorEvent,
  SessionConfig,
  SessionSpec,
  TransitionSpec,
  Trigger,
  Workflow,
  WorkflowState,
} from "./types.js";
import { checkConstraints, validateModel } from "./constraints.js";
import type { CheckpointStore } from "./checkpoint.js";
import { createFileCheckpointStore } from "./checkpoint.js";
import { createInitialState, markCompleted, recordTurn } from "./state.js";

export interface OrchestratorOptions {
  harnesses: AgentHarness[];
  checkpointStore?: CheckpointStore;
  onEvent?: (event: OrchestratorEvent) => void;
}

export class Orchestrator {
  private harnessMap: Map<string, AgentHarness>;
  private checkpointStore: CheckpointStore;
  private onEvent: (event: OrchestratorEvent) => void;

  constructor(options: OrchestratorOptions) {
    this.harnessMap = new Map(options.harnesses.map((h) => [h.name, h]));
    this.checkpointStore = options.checkpointStore ?? createFileCheckpointStore({ baseDir: ".checkpoints" });
    this.onEvent = options.onEvent ?? (() => {});
  }

  async start(workflow: Workflow, state?: WorkflowState, trigger?: Trigger): Promise<WorkflowState> {
    if (state && state.status !== "running") {
      return state;
    }

    const currentState = state ?? createInitialState(workflow, trigger ?? {
      id: "manual",
      source: "orchestrator",
      type: "manual.start",
      payload: {},
      receivedAt: new Date(),
    });

    this.emit({ type: "workflow.started", workflowId: workflow.id, stateId: currentState.id });

    const sessions = await this.createSessions(workflow.sessions);
    const specMap = new Map(workflow.sessions.map((s) => [s.id, s]));

    try {
      return await this.runLoop(workflow, currentState, sessions, specMap);
    } finally {
      for (const session of Object.values(sessions)) {
        session.dispose();
      }
    }
  }

  private async createSessions(specs: SessionSpec[]): Promise<Record<string, HarnessSession>> {
    const result: Record<string, HarnessSession> = {};
    for (const spec of specs) {
      const harness = this.harnessMap.get(spec.harness);
      if (!harness) {
        throw new Error(`Unknown harness: ${spec.harness}`);
      }
      const config: SessionConfig = {
        model: spec.model,
        systemPrompt: spec.systemPrompt,
        harnessOptions: spec.harnessOptions,
      };
      const session = await harness.createSession(config);
      result[spec.id] = session;
      this.emit({ type: "session.created", sessionId: spec.id, harness: spec.harness });
    }
    return result;
  }

  private async runLoop(
    workflow: Workflow,
    initialState: WorkflowState,
    sessions: Record<string, HarnessSession>,
    specMap: Map<string, SessionSpec>,
  ): Promise<WorkflowState> {
    let state = initialState;

    while (state.status === "running") {
      const constraintCheck = checkConstraints(workflow.constraints, state);
      if (constraintCheck.breached) {
        const onBudget = workflow.exitConditions.onBudgetExhausted ?? "fail";
        this.emit({ type: "constraint.breached", constraint: constraintCheck.reason! });
        if (constraintCheck.reason?.startsWith("maxSpendUsd") && onBudget === "pause") {
          return markCompleted(state, "paused", constraintCheck.reason);
        }
        return this.finish(state, "failure", constraintCheck.reason);
      }

      const exit = await this.evaluateExit(workflow.exitConditions, state);
      if (exit) {
        return this.finish(state, exit.outcome, exit.reason);
      }

      const next = await this.selectNextTransition(workflow.transitions, state);
      if (!next) {
        return this.finish(state, "failure", "no matching transition");
      }

      state = await this.executeTurn(state, sessions, next, specMap);
      state = await this.checkpoint(state);
    }

    return state;
  }

  private async selectNextTransition(
    transitions: TransitionSpec[],
    state: WorkflowState,
  ): Promise<TransitionSpec | undefined> {
    const source = state.currentSessionId ?? "start";
    for (const transition of transitions) {
      const fromMatches =
        transition.from === source ||
        (Array.isArray(transition.from) && transition.from.includes(source));
      if (!fromMatches) continue;

      if (transition.when) {
        const passes = await transition.when(state);
        if (!passes) continue;
      }
      return transition;
    }
    return undefined;
  }

  private async evaluateExit(
    exitConditions: Workflow["exitConditions"],
    state: WorkflowState,
  ): Promise<{ outcome: "success" | "failure"; reason?: string } | undefined> {
    if (exitConditions.goalMet && (await exitConditions.goalMet(state))) {
      return { outcome: "success", reason: "goal met" };
    }
    if (exitConditions.goalRejected && (await exitConditions.goalRejected(state))) {
      return { outcome: "failure", reason: "goal rejected" };
    }
    return undefined;
  }

  private async executeTurn(
    state: WorkflowState,
    sessions: Record<string, HarnessSession>,
    transition: TransitionSpec,
    specMap: Map<string, SessionSpec>,
  ): Promise<WorkflowState> {
    const sessionId = transition.to;
    const session = sessions[sessionId];
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const prompt =
      typeof transition.input === "function"
        ? await transition.input(state)
        : (transition.input ?? "Continue the workflow.");

    this.emit({ type: "turn.started", sessionId, iteration: state.iteration + 1 });

    const start = Date.now();
    const result = await session.prompt(prompt);
    const durationMs = Date.now() - start;

    state = recordTurn(state, sessionId, prompt, {
      text: result.text,
      costUsd: result.costUsd,
      durationMs,
    });

    const spec = specMap.get(sessionId);
    if (spec?.parseOutput) {
      const extracted = await spec.parseOutput(result.text, state);
      state = {
        ...state,
        context: { ...state.context, ...extracted },
      };
    }

    this.emit({
      type: "turn.completed",
      sessionId,
      iteration: state.iteration,
      durationMs,
      costUsd: result.costUsd ?? 0,
    });

    return state;
  }

  private async checkpoint(state: WorkflowState): Promise<WorkflowState> {
    const path = await this.checkpointStore.write(state);
    this.emit({ type: "checkpoint.written", stateId: state.id, path });
    return state;
  }

  private finish(
    state: WorkflowState,
    outcome: "success" | "failure" | "paused",
    reason?: string,
  ): WorkflowState {
    const finished = markCompleted(state, outcome, reason);
    this.emit({
      type: "workflow.completed",
      workflowId: state.workflowId,
      stateId: finished.id,
      outcome,
    });
    return finished;
  }

  private emit(event: OrchestratorEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // event handlers must not break the loop
    }
  }
}

export function defineWorkflow(workflow: Workflow): Workflow {
  // Validate model allow-list up front.
  for (const session of workflow.sessions) {
    const check = validateModel(workflow.constraints, session.model);
    if (check.breached) {
      throw new Error(`Session ${session.id}: ${check.reason}`);
    }
  }
  return workflow;
}
