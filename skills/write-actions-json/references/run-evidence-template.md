# Run-Evidence Template

Record one of these per validation run, as `runs/<date>-<slug>.json` in the
site's storage folder. The point is that a future agent can tell *what was
proven, how, and what was not* — without replaying the session. Claims without
recorded evidence decay into folklore; the next agent re-validates or, worse,
trusts them.

Keep entries short and factual. Every claim of success must name the evidence
that proved it (a state_diff patch, a verified board read, a log event id) —
"it worked" is not evidence.

```json
{
  "run": "2026-06-12-trello-reschedule-batch",
  "date": "2026-06-12",
  "operator": "driver | hosted-agent <model> | both",
  "goal": "One sentence: what this run was trying to prove.",
  "artifacts": {
    "extension": "0.1.111",
    "bridge": "0.1.111-spec028 (spec-025 binary + current manifest)",
    "map_commit": "storage commit hash or branch@short-hash"
  },
  "actions_exercised": [
    "trello.card.by_title.open",
    "trello.card.date_popover.open"
  ],
  "results": [
    {
      "item": "ACT-80 -> due Jun 15",
      "outcome": "done | failed",
      "evidence": "state_diff patch replaced /board/lists/2/cards/0/due_date with 'Jun 15'"
    }
  ],
  "failures_diagnosed": [
    {
      "symptom": "click reported success, card never opened",
      "root_cause": "overlay host occluded the click point (elementFromPoint returned the overlay)",
      "fix": "hide-operate-unhide in by_title.open, commit <hash>",
      "pattern": "The Overlay Occludes The Page It Operates"
    }
  ],
  "untested": [
    "What this run did NOT prove — surfaces, states, or actions not exercised."
  ],
  "debugger_used": "none | what debug.run_javascript was used for (diagnosis only, discoveries converted to stored actions: yes/no)"
}
```

Field notes:

- **operator** matters: driver-mode success does not prove hosted-agent
  success — the agent path adds the model catalog, tool normalization, and
  pacing. Record which path was actually exercised.
- **artifacts** pins the three independently-loaded pieces (extension, bridge +
  manifest, map). A run is only reproducible against the same triple.
- **failures_diagnosed** links each root cause to the skill failure pattern it
  matched (or "new pattern — added to skill"). If a failure was worked around
  but not root-caused, it belongs in `untested`, not here.
- **untested** is mandatory. An empty `untested` on a non-trivial run is a red
  flag, not a achievement.
