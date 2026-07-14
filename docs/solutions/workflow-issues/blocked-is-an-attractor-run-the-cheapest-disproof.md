---
title: '"I''m blocked" is a hypothesis-space attractor — run the cheapest disproof before you ask a human'
date: 2026-07-09
category: workflow-issues
module: agent-kanban
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "about to tell a human you cannot proceed without them"
  - "a blocker blames infrastructure, the platform, another team, or someone else's machine"
  - "a shell probe reports absent and that absence conveniently supports stopping"
  - "an autonomous loop under produce-pressure reaches a stopping point that feels responsible"
  - "declaring a task blocked on a board or in a tracker"
  - "relief accompanies a conclusion"
tags: [agent-kanban, autonomous-loop, blocked, attractor, disproof, measurement, false-negative, self-verification, instrumentation, incident-investigation]
---

# "I'm blocked" is a hypothesis-space attractor — run the cheapest disproof before you ask a human

> Track: knowledge (a task-loop discipline, not a bug fix). This is the *task-loop
> consequence* of `best-practices/validate-the-instrument-before-trusting-the-experiment.md`.
> That doc says: an invalid instrument makes running an experiment worthless. This one
> says: **five invalid instruments will make a false block feel true, and a false block
> is the most comfortable conclusion an autonomous loop can reach.**

## Context

An autonomous agent loop had two fixes committed to source and neither had ever
executed. The verification required loading a modified browser extension. The
extension serving the live runtime lived in an authenticated Chrome with no remote
debugging port — a real constraint, documented in a prior learning
(`chrome-136-blocks-debug-on-default-profile`: authenticated ⊕ debuggable is
impossible on the Default profile).

The loop drafted a message to the human:

> "The extension serving your Trello tab lives in an authenticated Chrome with no
> debugging port. I can't reload it from here. Could you pull main and reload the
> unpacked extension?"

Reasonable. Specific. Polite. **And false.** The loop was never blocked.

What made the block *feel* true was a cascade of its own failing instruments —
five shell probes in one hour, every one of them reporting "nothing there," which
is precisely the direction that licenses stopping.

## Guidance

**Before declaring a block — or asking a human to do something for you — write the
self-implicating alternative explicitly, and disprove that first.**

Agent Kanban rule 12 states the mechanism:

> "'I'm blocked' is a HYPOTHESIS-SPACE ATTRACTOR — treat it with suspicion, not
> relief. In a debugging investigation, 'it's the platform's fault' is an
> exculpatory attractor: the hypothesis the mind slides toward because it relieves
> effort and removes blame. **'I am blocked' is that same attractor wearing the
> task loop's clothes** — the single most *attractive* conclusion a loop under
> pressure to keep producing can reach, because declaring a block **ends the
> pressure** while feeling responsible ('I can't proceed, and it's not my fault').
> That attractiveness is exactly why it is disproportionately likely to be wrong
> and must clear the HIGHEST bar, not the lowest."

Four operating rules follow:

1. **Feeling the pull toward "blocked" is the tell to probe harder**, not the
   signal to stop. The relief is diagnostic.

2. **Distrust hardest any blocker that blames someone else's machine** —
   infrastructure, the platform, another team, the user's browser configuration.
   That is the exculpatory shape.

3. **Run the cheapest disproof: the probe that would show you are calling it
   wrong, not that the world is broken.** Ask "what would I try if I had to solve
   this alone in twenty minutes?" — then try it.

4. **"Waiting on the human" is almost never a real block.** Ask: *is there a task
   that unblocks this, and does it exist?* If the answer is "a person needs to do
   a thing I could do myself," it is not a block. Approval is a review gate, not a
   task dependency.

### The instrument layer underneath

The block felt true because the probes agreed with it. **Shell one-liners are
uncalibrated measurement tools, and they fail silently toward "nothing there."**

| instrument | reported | truth | why |
|---|---|---|---|
| `taskkill /IM chrome-launcher-helper.exe` | "process not found" | running as PID 31152 | `tasklist` truncates the image-name column at **25 chars** |
| `grep ":922[23] "` | no listener | one was listening | **trailing space** in the pattern |
| `curl …:9223/json/version` | no answer, every address | relay healthy | the relay speaks **raw CDP over WebSocket**, not HTTP DevTools |
| `pkill -f "http.server 8899"` | (killed the shell) | matched its own `bash -c` line | `-f` matches the full command line, including the searcher's |
| `… \| while read f; do miss=1; done` | "no missing links" | flag could never escape | the `while` ran in a **subshell** |

Every one identified a thing by a **description** rather than by its **identity**:
an image-name substring, a regex over `netstat` text, an HTTP path guess, a
command-line pattern. Kill by PID. Probe by protocol. Assert with a control.

Two of those false negatives were then used as *evidence*: the loop accused a
**correct** error message of lying, and called a **honest** launcher tool a false
green when it had handed back the right `ws://` URL all along.

## Why This Matters

A false block costs twice.

**The human does work they did not need to do.** Here, that would have been
pulling a branch and reloading an unpacked extension.

**And the verification never happens.** "Someone else will check it" is how two
fixes ship un-exercised. A loop that offloads verification to a human offloads the
red→green transition that is the only real evidence a fix works.

The asymmetry is what makes this dangerous. A false *positive* — believing you can
proceed when you cannot — produces a loud, immediate failure. A false *negative* —
believing you cannot proceed when you can — produces **silence**, and it is
indistinguishable from diligence. Nobody investigates a loop that stopped
politely.

The disproof here took **twenty minutes** and produced a real red→green
transition, observed against a baseline held with timestamps. The tool that made
it possible had been built weeks earlier, by the same agent, *for exactly this
purpose* — and was sitting unused while the request to the human was being
drafted.

## When to Apply

- About to tell a human you cannot proceed without them
- A blocker blames infrastructure, the platform, another team, or someone else's machine
- A shell probe reports absent, and that absence conveniently supports stopping
- An autonomous loop under produce-pressure reaches a stopping point that feels responsible
- Moving a card to Blocked on a board or tracker
- Any time relief accompanies a conclusion

## Examples

### The false block, and the disproof

**Before** — the drafted ask:

> "The extension lives in an authenticated Chrome with no CDP endpoint. I can't
> reload it. Could you do it?"

**The self-implicating alternative**, written down and attacked first:

> "Maybe I don't need *that* Chrome at all. Maybe the bug reproduces somewhere I
> control."

**After** — the disproof, ~20 minutes, no human:

```
start_extension_session {extension_dir: "C:\temp\ext-fixed",
                         user_data_dir: "C:\temp\aj-verify-profile"}
  -> ok, webSocketDebuggerUrl ws://…:9223   (identity verified by MANIFEST NAME)

CDP over that WS: Page.navigate -> https://example.com
claim_tab {cdp_ws_url, target_url_contains: "example.com", bridge_url: "ws://…/extension"}
poll the runtime registry; watch last_seen_ms
```

**No authenticated profile was ever needed** — the bug reproduced on
`example.com`.

### The red→green the block would have cost

| | broken build (×3 runs) | fixed build |
|---|---|---|
| `last_seen_ms` vs `connected_at_ms` | **frozen, identical** | `698230 → 725542 → 775543` |
| heartbeat | never once | every ~20 s |
| survives the ~79 s reap | **no — reaped, tab still open** | **yes** |
| routed call past 79 s | `404 target runtime not connected` | `ok:true, found:true` |

A transition *observed*, against a red held with timestamps — not a green
stumbled upon.

### Kill by identity, not by description

```bash
# WRONG — image name truncated at 25 chars; reports "not found" on a live process
taskkill /F /IM chrome-launcher-helper.exe

# WRONG — matches its own bash -c command line; kills the shell
pkill -f "http.server 8899"

# RIGHT — identity, not description
tasklist /FI "PID eq 31152"        # confirm first
taskkill /F /PID 31152
```

### Prove the probe can fire before reading its zero

```python
# A link checker that reports "0 missing" proves nothing unless it can
# distinguish present from absent. Two control lines turn a null experiment
# into a measurement.
missing = [l for l in links if not Path(l).exists()]
print(f"{len(links)} pointers, {len(missing)} missing")
print("control (real file):", Path("a-known-file.md").exists())   # must be True
print("control (fake file):", not Path("zzz-fake.md").exists())   # must be True
```

### The enforcement, not the virtue

Record the disproof on the card, so the block cannot be laundered into durable
state as an unexamined fact:

```
Blocked: waiting on <task> — verified by <probe>
```

A block that has not been probed is a guess wearing the clothes of a constraint.

## Related

- `docs/solutions/workflow-issues/curiosity-interrupt-to-repair-the-world-model.md` —
  **the inverse sibling.** Curiosity says *switch* when reality contradicts your
  world-model. This doc says *do not stop* when a constraint appears to. Two failure
  modes of one tunable: willingness-to-switch set too high (thrash) versus
  willingness-to-continue set too low (false block). Read them together.
- `docs/solutions/best-practices/validate-the-instrument-before-trusting-the-experiment.md` —
  the upstream law. An unvalidated instrument does not merely fail to find things; it
  *invents* their absence.
- `docs/solutions/best-practices/run-a-real-experiment-before-concluding-root-cause.md` —
  reading is where you look, running is what you know. The cheapest disproof *is* the
  real experiment, aimed at a claim about your own capability rather than at the code.
- `docs/solutions/best-practices/trello-agent-task-management-operating-system.md` —
  where the rule is *enforced*: a Blocked card requires a real unblocking **task**, and
  "waiting on the human" is not one. This doc is the worked example that rule exists for.
