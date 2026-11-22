# Continuation binding: the decision surface

**Status: awaiting a ruling.** This file states the three open questions, the
arguments on each side, and what each choice costs — so the ruling is a
selection rather than a rediscovery. It is not itself normative.

A `continuation_id` is a browser-carried token that lets a reconstructed host
find a receipt after a Streamlit V1 rerun destroys the previous instance. It is
an **untrusted lookup key**: the trusted side binds it to authenticated
identity on every admission. Losing it loses replay convenience; it must never
broaden authority.

Everything below concerns *how* that binding is checked.

## Q1 — an unknown token on admission

Instance B receives a token it has no row for: a genuinely older session, a
different installation, or a fabricated value.

| option | behaviour | cost |
|---|---|---|
| **(a) reject before lookup** | refuse any token not issued by this installation | needs issuance state, which is another durable thing to keep; a legitimate token surviving a store migration is rejected |
| **(b) look up, reject on mismatch** | find the row, compare principal, refuse if different | discloses existence by timing regardless of what the response says, so the disclosure (a) prevents is only partly prevented |
| **(c) unknown token starts a new scope** | no row, no continuity, proceed as a fresh caller | simplest and cannot leak existence, but an attacker learns nothing AND a legitimate reconnect silently loses replay, re-executing a mutation the user already made |

**The tension:** (c) is the most private and the most dangerous — "no row" and
"a row you may not see" become indistinguishable, and the mutation re-runs. (a)
is safest for mutations and costs an issuance ledger. (b) is what the current
implementation does by accident rather than by decision.

## Q2 — does `authority_mode` join the binding?

A token issued while the host ran owner-rights, presented after the deployment
moved to caller-rights.

- **Join it:** the receipt was produced under different privileges, so replaying
  it answers a question asked under authority the caller no longer has. Safer,
  and it makes an authority change invalidate outstanding continuations — which
  may be correct, since what would execute has changed.
- **Do not join it:** the receipt records what happened, not what may happen
  now, and re-executing a settled mutation because the deployment's rights model
  changed is the duplicate-write this protocol exists to prevent.

Both are defensible and they fail in opposite directions: joining risks a
duplicate write, omitting risks answering under stale authority.

## Q3 — does a rotated `runtime_id` break continuity?

It is in the store key today.

- **Keep it:** isolates concurrent runtimes within one viewer session.
- **Remove it:** a warehouse rerun plausibly rotates it, which would make every
  reconstruction a cache miss — **quietly defeating the whole mechanism while
  every test still passes**, because a test that constructs both instances with
  the same id never sees it.

This is the one I would flag as most likely to be wrong-by-default: the failure
is silent, and the reconstruction test I wrote would not catch it. A vector
where instance B has a *different* `runtime_id` is worth adding regardless of
the ruling, because it turns the question into an executable one.
