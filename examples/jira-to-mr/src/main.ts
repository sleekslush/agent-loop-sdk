import { Orchestrator } from "@agent-loop/core";
import { PiHarness } from "@agent-loop/harness-pi";
import { jiraToMrWorkflow } from "./workflow.js";
import type { Trigger } from "@agent-loop/core";

function makeTrigger(ticketKey: string, branchName: string): Trigger {
  return {
    id: `jira-${ticketKey}`,
    source: "jira",
    type: "ticket.assigned",
    payload: { ticketKey, branchName },
    receivedAt: new Date(),
  };
}

async function main(): Promise<void> {
  const ticketKey = process.env.JIRA_TICKET ?? "AC-123";
  const branchName = process.env.BRANCH_NAME ?? `feature/${ticketKey.toLowerCase().replace(/-/g, "_")}`;

  const orchestrator = new Orchestrator({
    harnesses: [new PiHarness()],
    onEvent: (event) => {
      console.log(`[${event.type}]`, "sessionId" in event ? event.sessionId : "-");
    },
  });

  console.log(`Starting Jira→MR workflow for ${ticketKey} → branch ${branchName}`);
  const state = await orchestrator.start(jiraToMrWorkflow, undefined, makeTrigger(ticketKey, branchName));

  console.log("\nWorkflow finished:", state.outcome);
  if (state.failureReason) {
    console.log("Failure reason:", state.failureReason);
  }
  console.log("Iterations:", state.iteration);
  console.log("Spend USD:", state.spendUsd);
  console.log("MR URL:", state.context.mrUrl);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
