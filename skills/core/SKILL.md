---
name: write-actions-json
description: Create and maintain actions.json files for websites. Use when an agent is exploring a website, automating a browser workflow, turning DOM operations into reusable actions, documenting how a website works for agents, or preparing a website action map for MCP/runtime use.
---

# Write actions.json

Use this skill to turn website exploration into durable agent-operable memory.

## Goal

Create or update an `actions.json` file that describes the important operations available on a website.

The file should let future agents operate the site through declared actions instead of rediscovering the DOM every time.

## Workflow

1. Identify the website or page under exploration.
2. Use the available browser automation tools to perform the user's real task.
3. Notice the durable operations, not just the immediate clicks.
4. For each operation, record:
   - action name
   - human-readable purpose
   - input schema
   - output/result shape
   - DOM selectors or handler names
   - source files or page locations when known
   - readiness or precondition notes
   - failure modes
5. Write or update `actions.json`.
6. Validate that each declared action corresponds to observable page behavior.
7. Prefer small, stable action names over one-off click descriptions.

## Principles

- Treat `actions.json` as operating memory, not after-the-fact documentation.
- Prefer real browser evidence over guessing from HTML alone.
- Keep the file readable; a human should be able to compare it to the page.
- Do not invent actions that cannot be traced to visible behavior, handlers, or DOM events.
- When the page is dynamic, document the runtime precondition instead of pretending the static HTML proves everything.

## Output

When finished, report:

- where `actions.json` was written
- what actions were added or changed
- what browser evidence supports them
- what remains uncertain
