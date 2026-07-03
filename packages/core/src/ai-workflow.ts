import type { Constraints, SessionSpec, TransitionSpec, Workflow, WorkflowState } from "./types.js";

export interface AiParseOutputRule {
  /** How to interpret the regex match. */
  type: "boolean" | "string" | "number";
  /** Regex pattern as a string. */
  pattern: string;
  /** Which capture group to return for string/number extraction. Defaults to 0 (full match). */
  group?: number;
}

export interface AiSessionSpec {
  id: string;
  role: string;
  /** Defaults to "pi". */
  harness?: string;
  model?: string;
  systemPrompt?: string;
  /**
   * Map of context keys to extraction rules.
   * The rule is applied to the session's text output after each turn.
   */
  parseOutput?: Record<string, AiParseOutputRule>;
}

export interface AiTransitionSpec {
  from: string | "start" | string[];
  to: string;
  /** JavaScript expression evaluated against `state`. */
  when?: string;
  /**
   * Template string supporting `{{path.to.value}}` placeholders.
   * Paths are resolved against `state` (e.g. `{{sessions.reader.lastOutput}}`).
   */
  input?: string;
}

export interface AiExitConditions {
  /** JavaScript expression evaluated against `state`. */
  goalMet?: string;
  /** JavaScript expression evaluated against `state`. */
  goalRejected?: string;
}

export interface AiWorkflow {
  id: string;
  goal: string;
  sessions: AiSessionSpec[];
  transitions: AiTransitionSpec[];
  constraints: Constraints;
  exitConditions: AiExitConditions;
}

export interface CompileOptions {
  /**
   * Optional fallback harness for sessions that omit it.
   * @default "pi"
   */
  defaultHarness?: string;
}

/**
 * Validate an AI workflow definition and return a list of human-readable errors.
 */
export function validateAiWorkflow(aiWorkflow: AiWorkflow): string[] {
  const errors: string[] = [];

  if (!aiWorkflow.id) errors.push("Workflow id is required");
  if (!aiWorkflow.goal) errors.push("Workflow goal is required");

  if (!Array.isArray(aiWorkflow.sessions) || aiWorkflow.sessions.length === 0) {
    errors.push("At least one session is required");
  } else {
    const sessionIds = new Set<string>();
    for (const session of aiWorkflow.sessions) {
      if (!session.id) {
        errors.push("Every session must have an id");
        continue;
      }
      if (sessionIds.has(session.id)) {
        errors.push(`Duplicate session id: ${session.id}`);
      }
      sessionIds.add(session.id);
    }

    for (const transition of aiWorkflow.transitions ?? []) {
      const froms = Array.isArray(transition.from) ? transition.from : [transition.from];
      for (const from of froms) {
        if (from !== "start" && !sessionIds.has(from)) {
          errors.push(`Transition references unknown session "${from}"`);
        }
      }
      if (!transition.to) {
        errors.push("Every transition must have a to");
      } else if (!sessionIds.has(transition.to)) {
        errors.push(`Transition references unknown session "${transition.to}"`);
      }
    }
  }

  return errors;
}

/**
 * Compile an AI workflow definition into an executable Workflow.
 */
export function compileAiWorkflow(aiWorkflow: AiWorkflow, options: CompileOptions = {}): Workflow {
  const errors = validateAiWorkflow(aiWorkflow);
  if (errors.length > 0) {
    throw new Error(`Invalid AI workflow: ${errors.join("; ")}`);
  }

  const defaultHarness = options.defaultHarness ?? "pi";

  return {
    id: aiWorkflow.id,
    goal: aiWorkflow.goal,
    sessions: aiWorkflow.sessions.map((session) => compileSession(session, defaultHarness)),
    transitions: aiWorkflow.transitions.map((transition) => compileTransition(transition)),
    constraints: aiWorkflow.constraints,
    exitConditions: compileExitConditions(aiWorkflow.exitConditions),
  };
}

function compileSession(session: AiSessionSpec, defaultHarness: string): SessionSpec {
  return {
    id: session.id,
    role: session.role,
    harness: session.harness ?? defaultHarness,
    model: session.model,
    systemPrompt: session.systemPrompt,
    parseOutput: session.parseOutput ? (output) => extractFromOutput(output, session.parseOutput!) : undefined,
  };
}

function extractFromOutput(
  output: string,
  rules: Record<string, AiParseOutputRule>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    try {
      const regex = new RegExp(rule.pattern, "i");
      const match = output.match(regex);
      if (!match) continue;

      const groupIndex = rule.group ?? 0;
      const value = match[groupIndex];
      if (value === undefined) continue;

      switch (rule.type) {
        case "boolean":
          result[key] = true;
          break;
        case "number":
          result[key] = Number.parseFloat(value);
          break;
        case "string":
        default:
          result[key] = value;
          break;
      }
    } catch {
      // Ignore malformed rules rather than crashing the workflow.
    }
  }
  return result;
}

function compileTransition(transition: AiTransitionSpec): TransitionSpec {
  return {
    from: transition.from,
    to: transition.to,
    when: transition.when ? compileExpression(transition.when) : undefined,
    input: transition.input ? compileTemplate(transition.input) : undefined,
  };
}

function compileExitConditions(exit: AiExitConditions): Workflow["exitConditions"] {
  return {
    goalMet: exit.goalMet ? compileExpression(exit.goalMet) : undefined,
    goalRejected: exit.goalRejected ? compileExpression(exit.goalRejected) : undefined,
  };
}

function compileExpression(expression: string): (state: WorkflowState) => boolean {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("state", `"use strict"; return (${expression});`) as (
    state: WorkflowState,
  ) => boolean;
  return (state) => {
    try {
      return fn(state);
    } catch {
      return false;
    }
  };
}

function compileTemplate(template: string): (state: WorkflowState) => string {
  const parts: Array<{ type: "text"; value: string } | { type: "expr"; path: string }> = [];
  const regex = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(template)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: template.slice(lastIndex, match.index) });
    }
    let path = match[1].trim();
    // Allow both `sessions.reader.lastOutput` and `state.sessions.reader.lastOutput`.
    if (!path.startsWith("state.")) {
      path = `state.${path}`;
    }
    parts.push({ type: "expr", path });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < template.length) {
    parts.push({ type: "text", value: template.slice(lastIndex) });
  }

  return (state) => {
    return parts
      .map((part) => {
        if (part.type === "text") return part.value;
        const value = resolvePath(state, part.path.slice(6)); // remove "state."
        return value === undefined ? "" : String(value);
      })
      .join("");
  };
}

function resolvePath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || current === undefined) return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}
