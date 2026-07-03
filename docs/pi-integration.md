# Pi Integration Plan

> Goal: let a user kick off an agent-loop workflow from inside an interactive pi session, either explicitly via a slash command or implicitly through natural language, and let pi itself decide when to create and run a workflow on-demand.

## Two ways to start

| Path | User input | Who decides it's a workflow? |
|---|---|---|
| **Explicit** | `/agentloop implement AC-123` | User (via command) |
| **Natural language** | `Review this MR with two models and post comments` | Pi (via skill guidance + tool choice) |

Both paths converge on the same execution pipeline.

## Integration mechanism: pi extension + skill

- **Extension** (TypeScript): registers the `/agentloop` command and a single `run_agent_loop` tool. It imports the SDK, builds workflows, runs them, and reports back.
- **Skill** (`SKILL.md`): teaches pi what `run_agent_loop` is for and when to call it from a natural-language prompt.

A skill alone is not enough because it cannot actively execute code; the extension provides the runtime.

### Distribution

The extension is published as a pi package, `@agent-loop/pi-extension`. Install
it directly with pi:

```bash
pi install npm:@agent-loop/pi-extension
```

For local development from this repo:

```bash
pi install ./packages/pi-extension
```

Or from another project on the same machine:

```bash
pi install /path/to/agent-loop-sdk/packages/pi-extension
```

If you prefer project-local `.pi/` files (for example, to customize the
extension), install the package with your Node package manager and run the setup
command:

```bash
pnpm add -D @agent-loop/pi-extension
pnpm exec agent-loop-pi-extension setup
```

This copies the extension, skill, and prompt into a local `.pi/` folder. `.pi/`
is user-specific and should not be committed to git.

## Unified entry point: `run_agent_loop`

Instead of separate tools for design vs. execution, expose one tool with modes. Pi calls this tool in agent-initiated mode; the extension can also call it internally when handling `/agentloop`.

```ts
interface RunAgentLoopInput {
  mode: "auto" | "predefined" | "explicit";

  // All modes
  goal: string;
  constraints?: {
    max_iterations?: number;
    max_spend_usd?: number;
    max_wall_clock_ms?: number;
  };
  context?: Record<string, unknown>;

  // mode: predefined
  workflow_id?: string;

  // mode: explicit
  sessions?: Array<{
    id: string;
    role: string;
    model?: string;
    system_prompt?: string;
  }>;
}
```

### Modes

- **`auto`**: extension (or a planner session) designs the workflow from the goal. Used for natural-language requests and for `/agentloop` without a known workflow ID.
- **`predefined`**: run a known workflow such as `jira-to-mr` or `mr-review`.
- **`explicit`**: pi provides the full session list; the extension just validates and runs it.

## Decision flow

```
User prompt
    │
    ▼
Is it "/agentloop ..."?
    │
    ├── Yes ──▶ extension handles command directly
    │            (mode = auto or predefined, depending on args)
    │
    └── No ───▶ pi reads SKILL.md
                 │
                 ▼
        Does the skill say this is a workflow task?
                 │
                 ├── Yes ──▶ pi calls run_agent_loop({ mode: "auto", goal, ... })
                 │
                 └── No ───▶ pi handles normally with built-in tools
```

## What the extension provides

### 1. Slash command `/agentloop`

```
/agentloop implement AC-123: add email verification
/agentloop design review this MR with a security and architecture reviewer
```

`/agentloop run <workflow_id>` is also supported if you register predefined
workflows through the extension's `predefinedWorkflows` option (see
`packages/pi-extension/README.md`).

The extension parses the subcommand:

- `run <workflow_id> [args...]` → `mode: "predefined"` (requires configuration)
- `design <goal>` → `mode: "auto"`, but stop after showing the planned workflow and ask for approval
- default `<goal>` → `mode: "auto"`

The command then invokes the same `run_agent_loop` pipeline the tool would use.

### 2. Tool `run_agent_loop`

Pi calls this when the skill instructs it to. Example natural-language triggers:

- "Review this MR with two models and post the good comments"
- "Implement this Jira ticket and open a merge request"
- "Fetch the latest bug tickets, fix the easiest one, and open a PR"

The tool call is async: it returns immediately with a run ID, and progress streams back into the conversation.

### 3. Skill `SKILL.md`

The skill tells pi:

- When a task benefits from multi-session orchestration (multiple reviewers, implement + review + publish, etc.).
- That it should call `run_agent_loop` with `mode: "auto"` and a clear `goal`.
- That simple, single-turn tasks should still use pi's built-in tools.
- That destructive or costly workflows should be confirmed with the user first.

Example skill excerpt:

```markdown
# Agent Loop

Use the `run_agent_loop` tool when the user asks for something that is
naturally multi-step and benefits from isolated roles:

- "Review this MR with multiple models"
- "Implement this ticket and open a PR"
- "Fix the failing tests and commit the changes"

Signals that suggest a workflow: "and then", "with multiple models",
"implement, review, and", "fetch and fix".

Signals that mean DO NOT use a workflow: "just", "quickly",
"give me a quick", "inline", "simple".

For workflow requests, call `run_agent_loop` with mode "auto" and a concise goal.
For simple questions or one-file edits, use pi's built-in tools instead.
If you are unsure, ask the user for confirmation first.
```

## On-demand workflow creation

### Strategy A: extension designs the workflow

The extension maps the goal and optional session hints to a `Workflow` object directly.

Pros: deterministic, fast, no extra model call.
Cons: limited flexibility; pi cannot refine the design conversationally.

Use this for `/agentloop run ...` and for well-understood natural-language patterns.

### Strategy B: planner session designs the workflow

The extension spawns a short-lived pi session via the SDK with a planner system prompt:

> "You are a workflow designer. Given a goal, output a valid JSON object matching the AgentLoop Workflow schema. Include sessions, transitions, constraints, and exit conditions."

The planner returns JSON, the extension validates it, then runs it.

Pros: pi can design arbitrarily complex workflows from vague goals.
Cons: extra cost and latency; requires robust JSON extraction/validation.

**Recommendation:** implement Strategy A first. Add Strategy B for `/agentloop design` and for natural-language prompts the extension doesn't recognize.

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

## Choosing between loop and direct response

Not every prompt should become a workflow. The design provides three levers to disambiguate.

### 1. Slash command is the explicit loop trigger

`/agentloop <goal>` is the unambiguous opt-in. When the user types it, the extension runs a workflow without asking pi to decide.

```text
/agentloop implement AC-123 and open a PR
```

### 2. Natural language is decided by the skill

For plain prompts, the `SKILL.md` teaches pi when `run_agent_loop` is appropriate. The skill should look for orchestration signals and suppression signals.

**Words that suggest a loop:**

| Signal | Example |
|---|---|
| `and then` | `"Review this MR and then post comments."` |
| `with multiple models` | `"Review with a security and architecture model."` |
| `implement, review, and` | `"Implement, review, and merge the changes."` |
| `fetch and fix` | `"Fetch the next ticket and fix it."` |

**Words that suppress a loop:**

| Signal | Example |
|---|---|
| `just` | `"Just review this MR inline."` |
| `quickly` | `"Quickly tell me if this looks okay."` |
| `give me a quick` | `"Give me a quick summary of this PR."` |
| `inline` | `"Review this code inline."` |
| `simple` | `"Simple question: does this handle nulls?"` |

### 3. Confirmation gate for ambiguous prompts

When pi is unsure, it should ask rather than guess:

```text
Pi: This sounds like a multi-step workflow (review + comment posting).
     Run it with run_agent_loop?
User: yes
```

This is the safest default for agent-initiated workflows.

### 4. User preference setting

Add a pi setting so users can tune the default behavior:

```json
{
  "agent-loop": {
    "naturalLanguageMode": "auto" | "ask" | "off"
  }
}
```

- `auto`: pi may call `run_agent_loop` when the skill says it's appropriate.
- `ask`: pi always confirms before calling `run_agent_loop`.
- `off`: only `/agentloop` triggers a workflow; natural language never does.

**Recommendation:** default to `ask`. `/agentloop` bypasses the setting entirely.

## Context sharing

The interactive pi session has valuable context: open files, conversation history, cwd, loaded skills. The extension captures a snapshot and passes it as the workflow trigger payload.

```ts
interface PiTriggerPayload {
  source: "pi-extension";
  goal: string;
  mode: "auto" | "predefined" | "explicit";
  cwd: string;
  referencedFiles: string[];
  recentConversationSummary?: string;
  originalPrompt: string;
}
```

Important: SDK workflow sessions are **isolated** from the interactive pi session. They do not automatically see the interactive session's memory. If a session needs that context, the extension must inject it into the session's system prompt or first prompt.

## Progress reporting

Options for showing progress in the interactive pi session:

1. **Tool result** (v1): wait until the workflow finishes, then return a summary. Simple but no live feedback.
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

## Pi package structure

The extension is packaged as `@agent-loop/pi-extension`:

```
packages/pi-extension/
├── src/
│   ├── extension.ts           # main extension entry point
│   ├── skill/
│   │   └── SKILL.md           # when pi should call run_agent_loop
│   └── prompts/
│       └── design-workflow.md # planner prompt template
├── scripts/
│   └── setup.js               # copies files into .pi/
├── package.json
└── tsconfig.json
```

`package.json` declares the pi package manifest and a bin command:

```json
{
  "name": "@agent-loop/pi-extension",
  "keywords": ["pi-package"],
  "bin": {
    "agent-loop-pi-extension": "./scripts/setup.js"
  },
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./src/skill"],
    "prompts": ["./src/prompts"]
  }
}
```

The setup command copies `src/extension.ts` to `.pi/extensions/agent-loop.ts`,
`src/skill/SKILL.md` to `.pi/skills/agent-loop/SKILL.md`, and
`src/prompts/design-workflow.md` to `.pi/prompts/design-workflow.md`.

## Migration path

1. Implement `run_agent_loop` tool and `/agentloop` command in `packages/pi-extension/src/extension.ts`.
2. Install the extension with pi for dogfooding:
   ```bash
   pi install ./packages/pi-extension
   ```
3. Dogfood with the existing `examples/jira-to-mr` workflow by registering it through the extension's `predefinedWorkflows` option.
4. Add `mode: "auto"` workflow design for natural-language prompts.
5. Publish `@agent-loop/pi-extension` to npm so users can `pi install npm:@agent-loop/pi-extension`.

## Open questions

1. Should `/agentloop` without a subcommand always use `auto`, or should it ask pi to decide?
2. Should the user preference setting live in `~/.pi/agent/settings.json` or in a separate config file?
3. Should workflow checkpoints be visible to the user through pi's `/tree` or session browser?
4. How should the extension handle a workflow that outlives the interactive pi session?
