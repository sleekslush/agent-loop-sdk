import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Orchestrator } from "@agent-loop/core";
import { PiHarness } from "@agent-loop/harness-pi";
import { jiraToMrWorkflow } from "../../examples/jira-to-mr/src/workflow.js";
import type { Trigger, Workflow, OrchestratorEvent } from "@agent-loop/core";

/**
 * Project-local pi extension for dogfooding agent-loop-sdk.
 *
 * Provides:
 * - Slash command: /agentloop
 * - LLM tool: run_agent_loop
 */

export default function (pi: ExtensionAPI) {

  pi.registerCommand("agentloop", {
    description: "Run an agent-loop workflow",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /agentloop <goal> or /agentloop run <workflow-id> [args]", "error");
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
        const { workflow, trigger } = buildPredefinedWorkflow(workflowId, rest);
        if (!workflow) {
          ctx.ui.notify(`Unknown workflow: ${workflowId}`, "error");
          return;
        }
        await runWorkflow(workflow, trigger, ctx.ui.notify);
        return;
      }

      // Default: auto mode from a goal.
      const goal = trimmed;
      await runWorkflow(
        jiraToMrWorkflow,
        {
          id: `pi-auto-${Date.now()}`,
          source: "pi-extension",
          type: "agentloop.auto",
          payload: { goal },
          receivedAt: new Date(),
        },
        ctx.ui.notify,
      );
    },
  });

  pi.registerTool({
    name: "run_agent_loop",
    label: "Run Agent Loop",
    description:
      "Run a multi-step, multi-session agent workflow. Use this when the user asks for something that involves distinct roles or sequential handoffs, such as 'implement and review' or 'review with multiple models'.",
    parameters: Type.Object({
      mode: Type.String({
        description: 'One of "auto", "predefined", or "explicit"',
      }),
      goal: Type.String({ description: "High-level goal of the workflow" }),
      workflow_id: Type.Optional(Type.String({ description: "Required when mode is predefined" })),
      max_iterations: Type.Optional(Type.Number({ description: "Maximum number of turns" })),
      max_spend_usd: Type.Optional(Type.Number({ description: "Maximum spend in USD" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.mode === "predefined") {
        if (!params.workflow_id) {
          return { content: [{ type: "text", text: "workflow_id is required for predefined mode" }], details: {} };
        }
        const { workflow, trigger } = buildPredefinedWorkflow(params.workflow_id, [params.goal]);
        if (!workflow) {
          return { content: [{ type: "text", text: `Unknown workflow: ${params.workflow_id}` }], details: {} };
        }
        await runWorkflow(workflow, trigger, ctx.ui.notify);
        return { content: [{ type: "text", text: "Workflow started." }], details: {} };
      }

      // Auto mode: for now, map everything to the jira-to-mr example workflow
      // with the goal as the ticket key. A real implementation would design
      // the workflow from the goal.
      await runWorkflow(
        jiraToMrWorkflow,
        {
          id: `pi-tool-${Date.now()}`,
          source: "pi-extension",
          type: "agentloop.auto",
          payload: { goal: params.goal, ticketKey: params.goal, branchName: `feature/${params.goal}` },
          receivedAt: new Date(),
        },
        ctx.ui.notify,
      );

      return { content: [{ type: "text", text: "Workflow started in auto mode." }], details: {} };
    },
  });
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
        notify(`[agent-loop] workflow ${event.outcome}`, event.outcome === "success" ? "info" : "error");
      }
    },
  });

  // Run in a microtask so the tool/command returns immediately.
  orchestrator.start(workflow, undefined, trigger).catch((err: unknown) => {
    notify(`[agent-loop] error: ${String(err)}`, "error");
  });
}

function buildPredefinedWorkflow(
  workflowId: string,
  args: string[],
): { workflow: Workflow; trigger: Trigger } | { workflow: undefined; trigger: undefined } {
  if (workflowId === "jira-to-mr") {
    const ticketKey = args[0] ?? "AC-123";
    const branchName = args[1] ?? `feature/${ticketKey.toLowerCase().replace(/-/g, "_")}`;
    return {
      workflow: jiraToMrWorkflow,
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
