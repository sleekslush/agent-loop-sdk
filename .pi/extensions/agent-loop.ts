import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compileAiWorkflow, validateAiWorkflow } from "../../packages/core/src/ai-workflow.js";
import { Orchestrator } from "../../packages/core/src/engine.js";
import { PiHarness } from "../../packages/harness-pi/src/index.js";
import type { AiWorkflow } from "../../packages/core/src/ai-workflow.js";
import type {
  OrchestratorEvent,
  Trigger,
  Workflow,
} from "../../packages/core/src/types.js";

/**
 * Project-local pi extension for dogfooding agent-loop-sdk.
 *
 * Provides:
 * - Slash command: /agentloop
 * - LLM tool: run_agent_loop
 */

const PLANNER_SYSTEM_PROMPT = `You are a workflow designer for the Agent Loop Orchestrator SDK.

Given a user goal, output a single valid JSON object matching the schema below. Do not include markdown code fences or explanation.

Schema:
{
  "id": "kebab-case-identifier",
  "goal": "one-sentence description",
  "sessions": [
    {
      "id": "reader",
      "role": "ticket-reader",
      "model": "claude-sonnet-4-20250514",
      "systemPrompt": "...",
      "parseOutput": {
        "approved": { "type": "boolean", "pattern": "APPROVED" }
      }
    }
  ],
  "transitions": [
    { "from": "start", "to": "reader", "input": "Read ticket {{trigger.payload.ticketKey}}" },
    { "from": "reader", "to": "writer", "when": "true", "input": "Implement: {{sessions.reader.lastOutput}}" }
  ],
  "constraints": { "maxIterations": 20, "maxSpendUsd": 10 },
  "exitConditions": { "goalMet": "state.currentSessionId === 'writer'" }
}

Rules:
- sessions need unique id and a role.
- transitions start from "start".
- input uses {{path}} resolved against state (e.g. {{sessions.reader.lastOutput}}, {{context.approved}}, {{trigger.payload.ticketKey}}).
- when and exitConditions are JavaScript boolean expressions evaluated against state.
- parseOutput type is one of boolean|string|number; pattern is a regex string; group picks a capture group (default 0).
- keep maxIterations under 30.`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("agentloop", {
    description: "Run an agent-loop workflow",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /agentloop <goal> | /agentloop run <workflow-id> [args] | /agentloop design <goal>",
          "error",
        );
        return;
      }

      const parts = trimmed.split(/\s+/);
      const subcommand = parts[0];

      if (subcommand === "run") {
        const workflowId = parts[1];
        const rest = parts.slice(2);
        if (!workflowId) {
          ctx.ui.notify("Usage: /agentloop run <workflow-id>", "error");
          return;
        }
        const { workflow, trigger } = await buildPredefinedWorkflow(workflowId, rest);
        if (!workflow) {
          ctx.ui.notify(`Unknown workflow: ${workflowId}`, "error");
          return;
        }
        await runWorkflow(workflow, trigger, ctx.ui.notify);
        return;
      }

      if (subcommand === "design") {
        const goal = parts.slice(1).join(" ").trim();
        if (!goal) {
          ctx.ui.notify("Usage: /agentloop design <goal>", "error");
          return;
        }
        ctx.ui.notify(`[agent-loop] designing workflow for: ${goal}`, "info");
        const workflow = await designWorkflow(goal, ctx.ui.notify);
        await runWorkflow(workflow, makeAutoTrigger(goal), ctx.ui.notify);
        return;
      }

      // Default: auto mode from a goal.
      const goal = trimmed;
      ctx.ui.notify(`[agent-loop] designing workflow for: ${goal}`, "info");
      const workflow = await designWorkflow(goal, ctx.ui.notify);
      await runWorkflow(workflow, makeAutoTrigger(goal), ctx.ui.notify);
    },
  });

  pi.registerTool({
    name: "run_agent_loop",
    label: "Run Agent Loop",
    description:
      "Run a multi-step, multi-session agent workflow. Use this when the user asks for something that involves distinct roles or sequential handoffs, such as 'implement and review' or 'review with multiple models'.",
    parameters: Type.Object({
      mode: Type.String({
        description: 'One of "auto" or "predefined"',
      }),
      goal: Type.String({ description: "High-level goal of the workflow" }),
      workflow_id: Type.Optional(Type.String({ description: "Required when mode is predefined" })),
      max_iterations: Type.Optional(Type.Number({ description: "Maximum number of turns" })),
      max_spend_usd: Type.Optional(Type.Number({ description: "Maximum spend in USD" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.mode === "predefined") {
        if (!params.workflow_id) {
          return {
            content: [{ type: "text", text: "workflow_id is required for predefined mode" }],
            details: {},
          };
        }
        const { workflow, trigger } = await buildPredefinedWorkflow(
          params.workflow_id,
          [params.goal],
        );
        if (!workflow) {
          return {
            content: [{ type: "text", text: `Unknown workflow: ${params.workflow_id}` }],
            details: {},
          };
        }
        await runWorkflow(workflow, trigger, ctx.ui.notify);
        return { content: [{ type: "text", text: "Workflow started." }], details: {} };
      }

      // Auto mode: design a workflow from the goal and run it.
      const workflow = await designWorkflow(params.goal, ctx.ui.notify);
      const trigger = makeAutoTrigger(params.goal);
      if (params.max_iterations !== undefined || params.max_spend_usd !== undefined) {
        workflow.constraints = {
          ...workflow.constraints,
          ...(params.max_iterations !== undefined && { maxIterations: params.max_iterations }),
          ...(params.max_spend_usd !== undefined && { maxSpendUsd: params.max_spend_usd }),
        };
      }
      await runWorkflow(workflow, trigger, ctx.ui.notify);
      return { content: [{ type: "text", text: "Workflow started in auto mode." }], details: {} };
    },
  });
}

async function designWorkflow(
  goal: string,
  notify: (message: string, type?: "info" | "error" | "warning") => void,
): Promise<Workflow> {
  const harness = new PiHarness();
  const session = await harness.createSession({
    model: "claude-sonnet-4-20250514",
    systemPrompt: PLANNER_SYSTEM_PROMPT,
  });

  try {
    const result = await session.prompt(`Design a workflow for this goal:\n\n${goal}`);
    const aiWorkflow = extractJson<AiWorkflow>(result.text);
    const errors = validateAiWorkflow(aiWorkflow);
    if (errors.length > 0) {
      throw new Error(`AI workflow validation failed: ${errors.join("; ")}`);
    }
    notify(`[agent-loop] designed workflow "${aiWorkflow.id}" with ${aiWorkflow.sessions.length} sessions`, "info");
    return compileAiWorkflow(aiWorkflow, { defaultHarness: "pi" });
  } catch (err) {
    notify(`[agent-loop] design failed: ${String(err)}`, "error");
    throw err;
  } finally {
    session.dispose();
  }
}

function extractJson<T>(text: string): T {
  // Try to find JSON inside markdown fences, otherwise use the whole string.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonText = fenced ? fenced[1] : text;
  return JSON.parse(jsonText) as T;
}

function makeAutoTrigger(goal: string): Trigger {
  return {
    id: `pi-auto-${Date.now()}`,
    source: "pi-extension",
    type: "agentloop.auto",
    payload: { goal },
    receivedAt: new Date(),
  };
}

async function runWorkflow(
  workflow: Workflow,
  trigger: Trigger,
  notify: (message: string, type?: "info" | "error" | "warning") => void,
): Promise<void> {
  const orchestrator = new Orchestrator({
    harnesses: [new PiHarness()],
    onEvent: (event: OrchestratorEvent) => {
      if (event.type === "turn.completed") {
        notify(`[agent-loop] ${event.sessionId}: turn ${event.iteration} complete`, "info");
      } else if (event.type === "workflow.completed") {
        notify(
          `[agent-loop] workflow ${event.outcome}`,
          event.outcome === "success" ? "info" : "error",
        );
      }
    },
  });

  orchestrator.start(workflow, undefined, trigger).catch((err: unknown) => {
    notify(`[agent-loop] error: ${String(err)}`, "error");
  });
}

async function buildPredefinedWorkflow(
  workflowId: string,
  args: string[],
): Promise<
  { workflow: Workflow; trigger: Trigger } | { workflow: undefined; trigger: undefined }
> {
  if (workflowId === "jira-to-mr") {
    const ticketKey = args[0] ?? "AC-123";
    const branchName = args[1] ?? `feature/${ticketKey.toLowerCase().replace(/-/g, "_")}`;
    const workflow = await loadJiraToMrWorkflow();
    return {
      workflow,
      trigger: {
        id: `jira-${ticketKey}`,
        source: "pi-extension",
        type: "agentloop.run",
        payload: { ticketKey, branchName },
        receivedAt: new Date(),
      },
    };
  }

  return { workflow: undefined, trigger: undefined };
}

async function loadJiraToMrWorkflow(): Promise<Workflow> {
  const modulePath = "../../examples/jira-to-mr/src/workflow.js";
  const module = (await import(modulePath)) as { jiraToMrWorkflow: Workflow };
  return module.jiraToMrWorkflow;
}
