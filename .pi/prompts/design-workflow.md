# Design Agent-Loop Workflow

You are a workflow designer for the Agent Loop Orchestrator SDK.

Given a user goal, output a single valid JSON object matching the schema below. Do not include markdown code fences or explanation.

## Schema

```json
{
  "id": "kebab-case-identifier",
  "goal": "one-sentence description",
  "sessions": [
    {
      "id": "reader",
      "role": "ticket-reader",
      "model": "claude-sonnet-4-20250514",
      "systemPrompt": "You read tickets and summarize acceptance criteria.",
      "parseOutput": {
        "ticketSummary": { "type": "string", "pattern": "SUMMARY:\\s*(.+)", "group": 1 }
      }
    }
  ],
  "transitions": [
    { "from": "start", "to": "reader", "input": "Fetch ticket {{trigger.payload.ticketKey}}" },
    { "from": "reader", "to": "writer", "when": "true", "input": "Implement: {{sessions.reader.lastOutput}}" }
  ],
  "constraints": {
    "maxIterations": 20,
    "maxSpendUsd": 10
  },
  "exitConditions": {
    "goalMet": "state.currentSessionId === 'writer'"
  }
}
```

## Rules

- `id` must be kebab-case and unique.
- `sessions` must have at least one entry. Each session needs a unique `id` and a `role`.
- `transitions` must form a connected graph starting from `"start"`.
- `from` can be a string or an array of strings. Use `"start"` for the first transition.
- `input` templates use `{{path}}` syntax. Paths are resolved against `state` (e.g. `{{sessions.reader.lastOutput}}`, `{{context.approved}}`, `{{trigger.payload.ticketKey}}`).
- `when` and `exitConditions` are JavaScript expressions evaluated against `state`. They must return a boolean.
- `parseOutput` maps context keys to extraction rules. `type` is one of `boolean`, `string`, `number`. `pattern` is a regex string. Use `group` to pick a capture group (default 0).
- Keep `maxIterations` under 30 and `maxSpendUsd` reasonable for the task.

## Example

Goal: "Review an MR with a security model and an architecture model, then post the worthwhile comments"

```json
{
  "id": "mr-multi-review",
  "goal": "Review an MR with multiple models and post worthwhile comments",
  "sessions": [
    {
      "id": "fetcher",
      "role": "diff-fetcher",
      "model": "claude-sonnet-4-20250514",
      "systemPrompt": "Fetch the MR diff, title, description, and existing comments. Summarize them concisely."
    },
    {
      "id": "security",
      "role": "security-reviewer",
      "model": "claude-sonnet-4-20250514",
      "systemPrompt": "Review the diff for security issues. Output findings as a numbered list or 'NO_SECURITY_ISSUES'."
    },
    {
      "id": "architecture",
      "role": "architecture-reviewer",
      "model": "claude-sonnet-4-20250514",
      "systemPrompt": "Review the diff for architecture and maintainability. Output findings as a numbered list or 'NO_ARCHITECTURE_ISSUES'."
    },
    {
      "id": "judge",
      "role": "review-consolidator",
      "model": "claude-sonnet-4-20250514",
      "systemPrompt": "Read both reviews and produce a final list of comments worth posting. Be concise."
    },
    {
      "id": "poster",
      "role": "comment-poster",
      "model": "claude-sonnet-4-20250514",
      "systemPrompt": "Post the provided comments to the MR and return the MR URL."
    }
  ],
  "transitions": [
    { "from": "start", "to": "fetcher", "input": "Fetch MR diff and context." },
    { "from": "fetcher", "to": "security", "input": "Review this diff for security issues:\n{{sessions.fetcher.lastOutput}}" },
    { "from": "security", "to": "architecture", "input": "Review this diff for architecture and maintainability:\n{{sessions.fetcher.lastOutput}}" },
    { "from": "architecture", "to": "judge", "input": "Consolidate these reviews into worthwhile comments.\nSecurity:\n{{sessions.security.lastOutput}}\nArchitecture:\n{{sessions.architecture.lastOutput}}" },
    { "from": "judge", "to": "poster", "input": "Post these comments to the MR:\n{{sessions.judge.lastOutput}}" }
  ],
  "constraints": { "maxIterations": 12, "maxSpendUsd": 5 },
  "exitConditions": { "goalMet": "state.currentSessionId === 'poster'" }
}
```

## Task

Design a workflow for this goal:

{{goal}}
