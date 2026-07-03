# Pi Integration Plan

> Goal: let a user kick off an agent-loop workflow from inside an interactive pi session, and let pi itself create that workflow on-demand.

## Integration mechanism: a pi extension

The right layer is a **pi extension** (TypeScript) that registers commands and tools. A skill alone only adds instructions; an extension can actively import the SDK, build workflows, run them, and report back.

Distribution options:

1. **Local extension** during development: load with `pi -e ./path/to/extension.ts`.
2. **Project-local extension**: place in `.pi/extensions/agent-loop.ts` so it auto-loads for this repo.
3. **Pi package** for reuse: publish `npm:@agent-loop/pi-agent-loop` and install with `pi install`.

Recommended: start with option 2 for dogfooding, then publish as option 3.

## What the extension provides

### 1. Slash command for the user

```
/agentloop implement a Jira ticket reader that polls every 5 minutes
```

`/agentloop <goal>`:
- Captures the user's high-level goal.
- Optionally asks clarifying questions through pi's editor.
- Hands off to a workflow designer (either pi itself via a tool, or a dedicated SDK session).

### 2. Tool for the agent

`design_and_run_agent_loop` — a tool pi can call when it decides a multi-step, multi-session workflow is appropriate.

Parameters:
- `goal`: string
- `sessions`: array of `{ id, role, model?, system_prompt? }`
- `constraints`: `{ max_iterations?, max_spend_usd?, max_wall_clock_ms? }`
- `trigger_payload`: any context pi wants to pass in

The tool returns:
- A confirmation of the workflow design.
- A run ID.
- Asynchronous progress events.

### 3. Predefined workflow runner

`run_workflow` — run a known workflow by ID (e.g., `jira-to-mr`, `mr-review`). Useful for pull/push triggers initiated from pi.

## On-demand workflow creation

Two strategies:

### Strategy A: extension designs the workflow itself

The extension receives structured parameters from pi and maps them directly to `defineWorkflow()`.

Pros: deterministic, fast, no extra model call.
Cons: limited flexibility; pi cannot refine the design conversationally.

### Strategy B: extension asks a planner session to design the workflow

The extension spawns a short-lived pi session via the SDK with a strong model and a system prompt like:

> "You are a workflow designer. Given a goal, output a valid JSON object matching the AgentLoop Workflow schema. Include sessions, transitions, constraints, and exit conditions."

The planner session returns JSON, the extension validates it, then runs it.

Pros: pi can design arbitrarily complex workflows from vague goals.
Cons: extra cost and latency; requires robust JSON extraction/validation.

**Recommendation:** implement Strategy A first, add Strategy B as an optional `/agentloop design` command.

## Execution model

### In-process execution

The extension calls `new Orchestrator({ harnesses: [new PiHarness()] }).start(workflow)` directly inside pi's Node process.

Pros: simple, fast, shares the same pi auth and resource discovery.
Cons: blocks pi while the workflow runs; long workflows freeze the TUI.

### Subprocess execution

The extension spawns a worker process (e.g., `node ./node_modules/@agent-loop/pi-agent-loop/dist/runner.js`) and communicates via JSON-RPC or stdin/stdout.

Pros: non-blocking; crashes in the workflow don't crash pi; easier to cancel.
Cons: more plumbing; need to stream progress back into pi.

**Recommendation:** start in-process for prototyping, move to subprocess before publishing the pi package.

## Context sharing

The interactive pi session has valuable context: open files, conversation history, cwd, loaded skills. The extension should capture a snapshot and pass it as the workflow trigger payload.

Possible trigger shape:

```ts
interface PiTriggerPayload {
  source: "pi-extension";
  goal: string;
  cwd: string;
  referencedFiles: string[];
  recentConversationSummary?: string;
  originalPrompt: string;
}
```

Important: workflow sessions created by the SDK are **isolated** from the interactive pi session. They do not automatically see the interactive session's memory. If a session needs that context, the extension must inject it into the session's system prompt or first prompt.

## Progress reporting

Options for showing progress in the interactive pi session:

1. **Tool result**: wait until the workflow finishes, then return a summary. Simple but no live feedback.
2. **Extension events**: emit progress via `pi.events` and render a custom UI overlay or status line.
3. **Streamed messages**: call `pi.sendMessage()` periodically to append turn-completed events to the conversation.

**Recommendation:** begin with option 1 for simplicity, then add option 3 so the user sees turn-by-turn progress.

## Human-in-the-loop

Some workflows may need approval gates (e.g., before creating an MR or spending beyond a threshold). The extension can:

- Pause the workflow by setting `onBudgetExhausted: "pause"` or adding an `approval_required` exit condition.
- Prompt the user via pi's editor or a custom UI component.
- Resume by reloading the checkpoint and continuing.

## Security boundaries

- The extension runs with pi's privileges. Do not add new auth handling.
- The extension should not silently run destructive workflows. Require explicit user approval for the first run of any on-demand workflow.
- Workflows execute with the same file system access as pi itself; this is acceptable because the user already trusts pi.

## Suggested pi package structure

```
pi-agent-loop/
├── extension.ts           # main extension entry point
├── skill/
│   └── SKILL.md           # when to use /agentloop vs built-in tools
├── prompts/
│   └── design-workflow.md # planner prompt template
└── package.json
```

`package.json` pi manifest:

```json
{
  "name": "@agent-loop/pi-agent-loop",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extension.ts"],
    "skills": ["./skill"],
    "prompts": ["./prompts"]
  }
}
```

## Migration path

1. Add a local extension at `.pi/extensions/agent-loop.ts` in this repo.
2. Implement `/agentloop` command and `run_workflow` tool.
3. Dogfood with the existing `examples/jira-to-mr` workflow.
4. Add `design_and_run_agent_loop` for on-demand creation.
5. Extract into `packages/pi-agent-loop/` and publish as a pi package.

## Open questions

1. Should the extension auto-load in every pi session, or only when the user types `/agentloop`?
2. Should workflow checkpoints be visible to the user through pi's `/tree` or session browser?
3. How should the extension handle a workflow that outlives the interactive pi session?
