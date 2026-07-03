import { defineWorkflow, Orchestrator, type Trigger, type WorkflowState } from "@agent-loop/core";
import { PiHarness } from "@agent-loop/harness-pi";

interface JiraTriggerPayload {
  ticketKey: string;
  branchName: string;
}

function ticketKey(state: WorkflowState): string {
  return (state.trigger.payload as JiraTriggerPayload).ticketKey;
}

function branchName(state: WorkflowState): string {
  return (state.trigger.payload as JiraTriggerPayload).branchName;
}

/**
 * Example: Jira ticket → implementation → review → GitLab MR
 *
 * This consumer simulates a pull trigger (e.g., a cron job polling Jira).
 * Each role runs in its own isolated pi session with its own model and system
 * prompt. The harness (pi) is expected to have the appropriate skills/tools
 * installed for Jira and GitLab access.
 */

function parseReviewerOutput(output: string): Record<string, unknown> {
  const approved = /\bAPPROVED\b/i.test(output) && !/\bNOT\s+APPROVED\b/i.test(output);
  return { approved };
}

function parseSubmitterOutput(output: string): Record<string, unknown> {
  // Match a markdown link or bare URL to a GitLab MR.
  const mdMatch = output.match(/\[.*?\]\((https:\/\/[^\s)]+)\)/);
  const urlMatch = output.match(/(https:\/\/[^\s]+\/(merge_requests|mr)\/\d+)/i);
  const mrUrl = mdMatch?.[1] ?? urlMatch?.[1];
  return mrUrl ? { mrUrl } : {};
}

function parseJiraMoverOutput(output: string): Record<string, unknown> {
  const ticketMoved = /\bMOVED\b/i.test(output);
  return { ticketMoved };
}

const workflow = defineWorkflow({
  id: "jira-to-mr",
  goal: "Implement the assigned Jira ticket and open a GitLab merge request",
  sessions: [
    {
      id: "jira",
      role: "ticket-reader",
      harness: "pi",
      model: "claude-sonnet-4-20250514",
      systemPrompt:
        "You have access to Jira skills. Read the ticket details, acceptance criteria, and any comments. Output a concise summary. End with 'MOVED' only after you have successfully transitioned the ticket.",
      parseOutput: parseJiraMoverOutput,
    },
    {
      id: "coder",
      role: "implementer",
      harness: "pi",
      model: "claude-opus-4-5",
      systemPrompt:
        "You are a senior TypeScript engineer. Implement the described changes, add or update tests, and run them. Report whether tests passed.",
    },
    {
      id: "reviewer",
      role: "reviewer",
      harness: "pi",
      model: "claude-sonnet-4-20250514",
      systemPrompt:
        "You are a thorough code reviewer. Compare the implementation against the ticket acceptance criteria. If it is ready to merge, respond with 'APPROVED' and a short summary. If not, respond with 'NOT APPROVED' and a numbered list of blocking issues.",
      parseOutput: parseReviewerOutput,
    },
    {
      id: "submitter",
      role: "publisher",
      harness: "pi",
      model: "claude-sonnet-4-20250514",
      systemPrompt:
        "You have access to Git skills. Create a merge request with a clear title and description, then return the MR URL.",
      parseOutput: parseSubmitterOutput,
    },
  ],
  transitions: [
    {
      from: "start",
      to: "jira",
      input: (state) => `Fetch Jira ticket ${ticketKey(state)} and summarize the acceptance criteria.`,
    },
    {
      from: "jira",
      to: "coder",
      input: (state) =>
        `Implement the changes for ticket ${ticketKey(state)} on branch ${branchName(state)}.\n\nTicket summary:\n${state.sessions.jira.lastOutput}`,
    },
    {
      from: "coder",
      to: "reviewer",
      input: (state) =>
        `Review this implementation against the ticket acceptance criteria.\n\nTicket summary:\n${state.sessions.jira.lastOutput}\n\nImplementation notes:\n${state.sessions.coder.lastOutput}`,
    },
    {
      from: "reviewer",
      to: "coder",
      when: (state) => state.context.approved !== true,
      input: (state) =>
        `Address the following review feedback and re-run tests:\n${state.sessions.reviewer.lastOutput}`,
    },
    {
      from: "reviewer",
      to: "submitter",
      when: (state) => state.context.approved === true,
      input: (state) =>
        `Create a GitLab merge request for branch ${branchName(state)}. Include a clear title, description, and link to Jira ticket ${ticketKey(state)}.`,
    },
    {
      from: "submitter",
      to: "jira",
      input: (state) =>
        `Transition Jira ticket ${ticketKey(state)} to 'In Review'. MR URL: ${state.context.mrUrl ?? "unknown"}. Confirm by responding with 'MOVED'.`,
    },
  ],
  constraints: {
    maxIterations: 20,
    maxSpendUsd: 10.0,
  },
  exitConditions: {
    goalMet: (state) =>
      state.currentSessionId === "jira" && state.context.ticketMoved === true,
  },
});

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
  const state = await orchestrator.start(workflow, undefined, makeTrigger(ticketKey, branchName));

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
