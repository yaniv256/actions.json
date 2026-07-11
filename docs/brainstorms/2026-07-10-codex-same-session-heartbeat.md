---
artifact_contract: ce-brainstorm/v1
date: 2026-07-10
status: requirements
topic: Codex same-session heartbeat
---

# Codex Same-Session Heartbeat

## Objective

Determine whether Codex can support an autonomous heartbeat that returns the
currently running agent to its task board every few minutes without starting a
different agent, burning tokens while waiting, or relying on non-first-party
automation as the core mechanism.

This brainstorm is deliberately narrower than the earlier Claude-oriented
heartbeat plan in `docs/plans/2026-07-08-001-feat-autonomous-heartbeat-headless-plan.md`.
That plan used a headless resumed CLI process on a schedule. The current question
is stricter: can a running Codex session itself be woken or continued on a timer?

## Source Corpus

The evidence base is the Last30Days research run named on the Trello card:

- `codex-goal-loop-wait-wake-heartbeat-same-session-scheduled-prompts-raw-brainstorm-v2.md`
- `codex-cli-first-party-scheduled-prompts-into-same-running-session-raw-v3.md`

Those files are local Last30Days outputs, not part of this repository. The
Trello card records their workstation paths and the instruction not to confuse
the active private storage repo with the public example submodule.

## Hard Constraints

- Prefer first-party Codex/OpenAI behavior.
- Preserve the same continuous live session, not merely the same serialized
  conversation context.
- Do not design a cron job whose only behavior is to wake a different agent.
- The heartbeat should pull the running agent back to the task board about every
  10 minutes.
- Timers, loops, goals, or future scheduled prompts are acceptable only if they
  do not spin automatic continuations, burn tokens while waiting, or create
  runaway context growth.
- Distinguish session-context resume from true same-session steering.
- Distinguish ChatGPT/Codex scheduled tasks from prompt delivery into the
  currently running Codex CLI/TUI session.

## Evidence Summary

The Last30Days corpus points to several adjacent capabilities, but not to a
confirmed primitive that satisfies all constraints.

- Goal mode is relevant because goals are long-lived and can be paused/resumed,
  and the corpus says follow-up messages can steer long-running work. That is
  evidence for live-session steering, not evidence for time-based wake.
- Issue `openai/codex#28144` asks for wait/wake support for goals without
  spending tokens. The request itself is evidence that durable wait/wake is a
  missing or at least not-yet-productized primitive.
- Issue `openai/codex#28923` reports goal-mode future-time waits spinning
  through many automatic continuations instead of sleeping. That is the exact
  failure mode this heartbeat design must avoid.
- Issue `openai/codex#11415` requested `codex inject` for sending prompts into
  existing running sessions and was closed as not planned. That weakens the case
  for a first-party CLI affordance that can inject scheduled prompts into a live
  TUI session.
- Issue `openai/codex#8317` requested first-party CLI scheduling flags such as
  `--at`, `--in`, and `--every`. That frames CLI-native scheduling as requested
  behavior rather than confirmed current behavior.
- The corpus cites first-party `codex exec resume` / `codex exec resume --last`
  as ways to continue non-interactive exec sessions with context. That is useful
  automation, but it is not necessarily the same continuous live session.
- ChatGPT/Codex scheduled tasks and task-context automations appear relevant to
  scheduled work. The corpus does not prove that they inject into this live CLI
  session.
- Third-party or community tools that resume "same session" across agents are
  useful references, but they fail the first-party requirement.

## Candidate Design Matrix

| Approach | First-party | Same continuous live session | No separate agent | No token-burn wait | Restart recovery | Immediate testability | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| Goal-mode loop that asks Codex to wait until a future time | Yes | Yes, if kept in this session | Yes | No, evidence says it may spin | Poor unless paired with store | Yes | Reject as default; test only to measure current behavior |
| Long-running shell sleep inside current tool call, then return a heartbeat sentinel | Yes-ish, via local shell tool | Same turn/session, not a new agent | Yes | Likely no model-token burn during tool wait | Dies on restart | Yes | Useful experiment, but not a general prompt scheduler |
| Multiple pre-scheduled in-session timers if Codex exposes a timer primitive | Would be yes | Would be yes | Yes | Would be yes if real sleep | Weak unless timers persist | No known exposed primitive | Desired product shape, not current evidence |
| `codex exec resume --last` from cron/system scheduler | Yes CLI, but external scheduler | No: resumes context in a new non-interactive process | No | Yes while idle | Good | Yes outside this live session | Practical fallback, fails strict same-session constraint |
| ChatGPT/Codex scheduled tasks or automations | First-party | Unproven for this CLI session | Likely separate scheduled task | Yes | Good | Not from this CLI alone | Useful adjacent product, not proof for this need |
| External injection into TUI via terminal, tmux, AppleScript, or bridge paste | No | Superficially yes | Maybe | Yes | Brittle | Maybe | Reject as core design; violates first-party and robustness |
| Persistent task store plus SessionStart restoration | First-party only if harness hook is first-party | No after restart; it restores a new session | No | Yes | Strong | Yes | Good mitigation, not a heartbeat |
| MCP/chained-prompt phase runner invoked manually | Depends on tool | Only when invoked | Yes | Yes | Strong for state, no automatic wake | Yes | Good workflow structure, not automatic wake |

## Recommended Product Shape

The clean primitive is:

> `sleep_until` / `wake_at` for active goals: suspend the live session without
> spending tokens, then deliver a continuation prompt into the same running
> session when the timer or external event fires.

The primitive needs explicit semantics:

- A goal can enter a durable sleeping state with a wake time or wake condition.
- Sleeping does not generate model continuations.
- On wake, Codex receives a compact heartbeat prompt and the current goal state.
- The user can inspect, cancel, or reschedule the wake.
- If the process restarts, the wake either restores the same logical goal with a
  clear "resumed after restart" marker or reports that strict same-session wake
  was impossible.
- The UI/logs distinguish live-session wake, logical-session resume, and new
  scheduled task execution.

## Immediate Experiment Plan

1. **Measure current goal-loop waiting behavior.** Start a small goal that waits
   for a short future time, such as two minutes, and record whether Codex sleeps
   cheaply or spins automatic continuations. This directly validates the
   `#28923` risk in the current environment.
2. **Test shell-sleep wake inside this live session.** Run a tool call such as
   `sleep 120; echo HEARTBEAT_READY` and observe whether the harness returns
   control to the same agent turn without token-burning model work. This does
   not solve scheduled prompt injection, but it tests whether a non-token-burning
   wait can exist inside a live session.
3. **Test context-resume fallback separately.** Use `codex exec resume --last`
   only as a labeled fallback experiment. The pass/fail question is not "does it
   work?" but "is the resulting process the same continuous live session?" The
   expected answer is no.
4. **Record product gap.** If goal waits spin and there is no timer primitive,
   open or update a product issue describing `sleep_until` / `wake_at` for goals
   and cite the observed measurements plus `#28144`, `#28923`, `#11415`, and
   `#8317`.
5. **Use Agent Task OS as mitigation.** Until first-party sleep/wake exists,
   keep task state durable on Trello and ensure session restoration reads the
   board, enforces one In Progress card, and keeps walking. This mitigates
   restarts and pauses, but should be labeled as restoration, not heartbeat.

## Recommendation

Do not claim that Codex currently supports the requested heartbeat. The evidence
supports a more precise statement:

Codex appears to have first-party pieces for long-running goals, scheduled work,
and context resume, but the exact requirement - timed wake into this same
continuous live session without token burn and without a separate agent - remains
unproven and likely requires a product primitive.

The best next step is an evidence-gathering experiment pair: measure current
goal-mode waiting, then measure shell-tool sleep behavior in the live session.
If either passes, refine the design around the working primitive. If both fail
or are too narrow, specify `sleep_until` / `wake_at` for active goals as the
missing first-party capability.
