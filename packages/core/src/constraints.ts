import type { Constraints, WorkflowState } from "./types.js";

export interface ConstraintCheck {
  breached: boolean;
  reason?: string;
}

export function checkConstraints(
  constraints: Constraints,
  state: WorkflowState,
): ConstraintCheck {
  if (state.iteration >= constraints.maxIterations) {
    return { breached: true, reason: `maxIterations (${constraints.maxIterations}) reached` };
  }

  if (constraints.maxSpendUsd !== undefined && state.spendUsd >= constraints.maxSpendUsd) {
    return { breached: true, reason: `maxSpendUsd ($${constraints.maxSpendUsd}) reached` };
  }

  if (constraints.maxWallClockMs !== undefined) {
    const elapsed = Date.now() - state.startedAt.getTime();
    if (elapsed >= constraints.maxWallClockMs) {
      return { breached: true, reason: `maxWallClockMs (${constraints.maxWallClockMs}ms) reached` };
    }
  }

  return { breached: false };
}

export function validateModel(
  constraints: Constraints,
  model: string | undefined,
): ConstraintCheck {
  if (!model) return { breached: false };
  if (!constraints.allowedModels || constraints.allowedModels.length === 0) {
    return { breached: false };
  }
  if (!constraints.allowedModels.includes(model)) {
    return {
      breached: true,
      reason: `model ${model} is not in allowedModels`,
    };
  }
  return { breached: false };
}
