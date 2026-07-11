---
title: "Nudge an agent through its own first-party channels — never inject into its session"
date: 2026-07-09
problem_type: architecture_pattern
track: knowledge
category: architecture-patterns
module: chained-prompts
component: chained-prompts-mcp
tags: [agent-orchestration, chained-prompts, heartbeat, self-wake, tmux, tos, first-party-delivery, anti-idle]
applies_when: "Designing any mechanism that delivers a prompt to an agent or keeps it on task — phase delivery, a wake/heartbeat, a reminder. The choice is between the agent's own first-party channels (tool results it reads, a scheduler it arms) and an external process writing into its session (terminal paste, message injection)."
---

# Nudge an agent through its own first-party channels — never inject into its session

## Context

The `chained-prompts` MCP serves a multi-phase methodology one phase at a time so
an agent can't skip ahead. Two related needs arose: (1) how does each phase's
prompt reach the agent, and (2) how do you stop the agent from going *idle*
mid-chain (drifting off, or stopping to ask the user a blocking question) so it
actually runs to the final phase?

The original server answered both with **tmux injection**: a `send_to_tmux()`
helper ran `sudo -u <user> tmux load-buffer / paste-buffer / send-keys` to type
the next prompt directly into the agent's terminal, and a `chain-watcher.sh`
polled a file and pasted into tmux. This is the tempting answer because it *feels*
like "the system driving the agent forward."

The same shape had already been reached — and rejected — twice more in the wider
project: an autonomous **heartbeat** design first proposed headless `claude -p`
and external daemons injecting a message into the session, and the voice layer
could inject too. Each looked like a different idea; all three were the same
mistake wearing different clothes.

## Guidance

**Any mechanism that delivers a prompt to an agent, or nudges it to stay on task,
must go through the agent's own first-party channels — never through an external
process writing into the agent's session.**

Concretely, two first-party channels:

1. **Delivery = tool return.** The phase prompt comes back as the *result* of the
   tool the agent called (`chain_start` / `chain_complete` return `prompt` /
   `next_prompt`). The agent reads its own tool result and flows into the next
   phase. The server never types anything anywhere.

2. **Wake = self-armed scheduler.** To keep the agent from going idle mid-chain,
   the server does **not** reach in to wake it. Instead the tool result tells the
   agent to arm *its own* first-party wake (the harness's `ScheduleWakeup` /
   `CronCreate`), and a `chain_reminder(chain_id)` tool returns the current phase,
   its prompt, and a standing "do not go idle" message for that self-armed wake to
   fire. The server supplies **data**; the agent fires the wake.

```python
# BEFORE — external injection (removed)
def send_to_tmux(text):
    subprocess.run(["sudo", "-u", TMUX_USER, "tmux", "load-buffer", tmpfile])
    subprocess.run(["sudo", "-u", TMUX_USER, "tmux", "paste-buffer", "-t", target])
    subprocess.run(["sudo", "-u", TMUX_USER, "tmux", "send-keys", "-t", target, "Enter"])

# AFTER — first-party: return the prompt + tell the agent to arm its own wake
def chain_start(chain_id):
    ...
    return {
        "prompt": prompt,                       # agent reads this
        "arm_wake": "Arm a ~5-min ScheduleWakeup; each fire call chain_reminder(...)",
        "reminder": ANTI_IDLE_MESSAGE,
    }

def chain_reminder(chain_id):                   # the self-armed wake calls this
    return {"current_phase": ..., "phase_prompt": ..., "reminder": ANTI_IDLE_MESSAGE}
```

## Why This Matters

- **External injection is a Terms-of-Service ban risk.** A daemon typing into an
  agent's session reads as external automation of the agent — the same reason
  headless `-p` spawning and message-injection were ruled out for the heartbeat.
  First-party delivery sidesteps this entirely: the agent is only ever reading its
  own tool results and arming its own timer.
- **It removes a whole phantom problem: the "second driver."** An injected wake
  usually implies a *second* session/process driving the agent, which then
  "contends" with the primary one over the same resources (tabs, files). That
  contention is manufactured by the injection assumption. When the wake is the
  agent waking *itself*, there is exactly one driver and the contention vanishes.
- **It's portable.** Tool-return delivery works in any MCP client with no tmux,
  no `sudo`, no knowledge of the agent's terminal. The injection path was coupled
  to one specific host layout (a named tmux window owned by a specific user).
- **The distinction that carries it: alive-idle vs dormant.** A first-party
  self-wake only fires into a *persistent, alive-idle* session (one with a live
  event loop between turns). It cannot resurrect a fully *dormant* between-turns
  agent — but neither can injection do that safely. Keep the session alive and let
  it wake itself.

## When to Apply

Reach for this whenever you're about to build something that "drives," "reminds,"
"wakes," or "feeds prompts to" an agent. Ask: *does the mechanism write into the
agent's session from outside, or does the agent pull/receive through its own
tools and scheduler?* If it's the former (terminal paste, message injection, an
external daemon posting into the session), stop — redesign it as (a) data the
agent reads from a tool result, plus (b) a wake the agent arms itself. The tell
that you're on the wrong path: the design implies a second process acting *on* the
agent rather than the agent acting on itself.

Does **not** apply to genuinely external event sources the agent legitimately
subscribes to via its own tools (a Monitor the agent armed, a webhook it
registered) — those are first-party by construction because the agent set them up
and receives them through its own channels.

## Examples

**Three incidents, one principle:**

| Mechanism | External-injection form (rejected) | First-party form (chosen) |
|---|---|---|
| Chain phase delivery | `tmux paste-buffer` types the next phase | tool returns `next_prompt`; agent reads it |
| Anti-idle wake | a daemon injects "get back to the chain" | agent arms `ScheduleWakeup` → `chain_reminder` |
| Autonomous heartbeat | headless `claude -p` / injected beat | `/loop` self-wake of the one alive-idle session |

The `chained-prompts` rewrite (2026-07-09) removed `send_to_tmux`,
`_find_tmux_target`, the `TMUX_*` config, the `deliver="tmux"` path, and
`chain-watcher.sh` outright, and added `chain_reminder` + the `arm_wake`/`reminder`
keys — cutting `server.py` from 1471 to 645 lines while making the anti-idle
protection *stronger* than the injection version it replaced.

## Related

- [Trello as an agent task-management operating system](../best-practices/trello-agent-task-management-operating-system.md) — the "always be walking" heartbeat loop this self-wake mechanism serves; that doc covers the task-management discipline, this covers the delivery/wake mechanism.
