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
import { createInitialState, markCompleted, recordSummary, recordTurn } from "./state.js";

export interface OrchestratorOptions {
  harnesses: AgentHarness[];
  checkpointStore?: CheckpointStore;
  onEvent?: (event: OrchestratorEvent) => void | Promise<void>;
}

export class Orchestrator {
  private harnessMap: Map<string, AgentHarness>;
  private checkpointStore: CheckpointStore;
  private onEvent: (event: OrchestratorEvent) => void | Promise<void>;

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

    await this.emit({
      type: "workflow.started",
      runId: currentState.id,
      workflowId: workflow.id,
      stateId: currentState.id,
      goal: workflow.goal,
      triggerSource: currentState.trigger.source,
      constraints: workflow.constraints,
    });

    const sessions = await this.createSessions(workflow.sessions, currentState.id);
    const specMap = new Map(workflow.sessions.map((s) => [s.id, s]));

    try {
      return await this.runLoop(workflow, currentState, sessions, specMap);
    } finally {
      for (const session of Object.values(sessions)) {
        session.dispose();
      }
    }
  }

  private async createSessions(
    specs: SessionSpec[],
    runId: string,
  ): Promise<Record<string, HarnessSession>> {
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
      await this.emit({
        type: "session.created",
        runId,
        sessionId: spec.id,
        role: spec.role,
        harness: spec.harness,
        model: spec.model,
        harnessSessionRef: session.getRef?.(),
      });
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
        await this.emit({
          type: "constraint.breached",
          runId: state.id,
          constraint: constraintCheck.reason!,
          iteration: state.iteration,
        });
        if (constraintCheck.reason?.startsWith("maxSpendUsd") && onBudget === "pause") {
          return this.finish(state, "paused", constraintCheck.reason);
        }
        return await this.finish(state, "failure", constraintCheck.reason);
      }

      const exit = await this.evaluateExit(workflow.exitConditions, state);
      if (exit) {
        return await this.finish(state, exit.outcome, exit.reason);
      }

      const next = await this.selectNextTransition(workflow.transitions, state);
      if (!next) {
        return await this.finish(state, "failure", "no matching transition");
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

    const spec = specMap.get(sessionId);

    await this.emit({
      type: "turn.started",
      runId: state.id,
      sessionId,
      role: spec?.role ?? sessionId,
      iteration: state.iteration + 1,
    });

    const start = Date.now();
    const result = await session.prompt(prompt);
    const durationMs = Date.now() - start;

    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;

    state = recordTurn(state, sessionId, prompt, {
      text: result.text,
      costUsd: result.costUsd,
      durationMs,
      inputTokens,
      outputTokens,
    });

    const parseSpec = specMap.get(sessionId);
    if (parseSpec?.parseOutput) {
      const extracted = await parseSpec.parseOutput(result.text, state);
      state = {
        ...state,
        context: { ...state.context, ...extracted },
      };
    }

    if (spec?.summarizeOutput) {
      const summaryPrompt =
        spec.summaryPrompt ??
        "Summarize your previous response concisely so it can be used as context for the next step in this workflow. End with a single line: VERDICT: APPROVED or VERDICT: REJECTED if applicable.";

      const summaryStart = Date.now();
      const summaryResult = await session.prompt(summaryPrompt);
      const summaryDurationMs = Date.now() - summaryStart;
      const summaryInputTokens = summaryResult.usage?.inputTokens ?? 0;
      const summaryOutputTokens = summaryResult.usage?.outputTokens ?? 0;
      const summaryCostUsd = summaryResult.costUsd ?? 0;

      state = recordSummary(state, sessionId, summaryResult.text, {
        costUsd: summaryCostUsd,
        durationMs: summaryDurationMs,
        inputTokens: summaryInputTokens,
        outputTokens: summaryOutputTokens,
      });

      await this.emit({
        type: "turn.summarized",
        runId: state.id,
        sessionId,
        role: spec?.role ?? sessionId,
        iteration: state.iteration,
        summary: summaryResult.text,
        durationMs: summaryDurationMs,
        costUsd: summaryCostUsd,
        inputTokens: summaryInputTokens,
        outputTokens: summaryOutputTokens,
      });
    }

    await this.emit({
      type: "turn.completed",
      runId: state.id,
      sessionId,
      role: spec?.role ?? sessionId,
      iteration: state.iteration,
      durationMs,
      costUsd: result.costUsd ?? 0,
      inputTokens,
      outputTokens,
    });

    return state;
  }

  private async checkpoint(state: WorkflowState): Promise<WorkflowState> {
    const path = await this.checkpointStore.write(state);
    await this.emit({ type: "checkpoint.written", stateId: state.id, path });
    return state;
  }

  private async finish(
    state: WorkflowState,
    outcome: "success" | "failure" | "paused",
    reason?: string,
  ): Promise<WorkflowState> {
    const finished = markCompleted(state, outcome, reason);
    const durationMs = finished.endedAt
      ? finished.endedAt.getTime() - finished.startedAt.getTime()
      : 0;
    await this.emit({
      type: "workflow.completed",
      runId: finished.id,
      workflowId: state.workflowId,
      stateId: finished.id,
      outcome,
      failureReason: reason,
      iteration: finished.iteration,
      spendUsd: finished.spendUsd,
      durationMs,
    });
    return finished;
  }

  private async emit(event: OrchestratorEvent): Promise<void> {
    try {
      await this.onEvent(event);
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
