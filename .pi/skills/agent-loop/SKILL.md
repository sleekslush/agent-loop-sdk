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

The user can also trigger a workflow explicitly with `/agentloop <goal>`.
