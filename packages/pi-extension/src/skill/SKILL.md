---
description: Use the run_agent_loop tool for multi-step, multi-role agent workflows.
---

# Agent Loop

Use the `run_agent_loop` tool when the user asks for something that is naturally multi-step and benefits from isolated roles or sequential handoffs.

Good examples:

- "Review this MR with multiple models"
- "Implement this ticket and open a PR"
- "Fix the failing tests and commit the changes"
- "Fetch the next Jira ticket, implement it, and open an MR"

Signals that suggest a workflow:

- `and then`
- `with multiple models`
- `implement, review, and`
- `fetch and fix`

Signals that mean DO NOT use a workflow:

- `just`
- `quickly`
- `give me a quick`
- `inline`
- `simple`

For workflow requests, call `run_agent_loop` with mode `"auto"` and a concise goal.
For simple questions or one-file edits, use pi's built-in tools instead.
If you are unsure, ask the user for confirmation first.

The user can also trigger a workflow explicitly with `/agentloop <goal>` or `/agentloop run <workflow-id>`.

## Workflow design notes (for the extension)

When the extension designs a workflow automatically, it produces an AI-friendly JSON workflow with:

- `sessions`: isolated roles, each with an optional `model`, `systemPrompt`, and `parseOutput` rules.
- `transitions`: a graph from `"start"` through sessions, using `{{path}}` templates for inputs and JavaScript expressions for guards.
- `constraints`: `maxIterations` and `maxSpendUsd`.
- `exitConditions`: JavaScript boolean expressions such as `state.currentSessionId === 'submitter'`.

Example transition input template:

```text
Review this implementation:\n{{sessions.coder.lastOutput}}
```

Example guard expression:

```text
state.context.approved === true
```
