#!/usr/bin/env bash
# Autonomous heartbeat runner (Path B: headless `claude -p` + local scheduler).
# Plan: actions.json.dev/docs/plans/2026-07-08-001-feat-autonomous-heartbeat-headless-plan.md (task #173).
#
# What it does: fires ONE headless heartbeat by RESUMING the pinned Claude session, so the wake
# continues the same logical agent (task context + MEMORY.md) and can drive the actions.json MCP +
# browser to sync the Trello board and keep working.
#
# SAFETY: this script is inert until a scheduler (cron line) calls it. Building it changes nothing.
# Enabling the schedule for a live/overnight run is the consequential step and needs Yaniv's explicit go.
#
# One-time human prerequisites before a live run:
#   - `claude` must be authed (subscription/login) so headless `-p` works without interactive login.
#   - Windows/WSL set to not sleep overnight (.wslconfig) so WSL stays alive between fires.
#
# Usage (manual test fire):   ~/.claude/heartbeat/heartbeat-run.sh
# Scheduling (NOT yet enabled): a crontab line like:
#   */30 * * * * /home/agent-zara/.claude/heartbeat/heartbeat-run.sh >> /home/agent-zara/.claude/heartbeat/heartbeat.log 2>&1

set -uo pipefail

CLAUDE_BIN="${CLAUDE_BIN:-/home/agent-zara/.local/bin/claude}"
PROJECT_DIR="${PROJECT_DIR:-/home/agent-zara}"
SESSION_FILE="${SESSION_FILE:-/home/agent-zara/.claude/heartbeat/session-id.txt}"
LOG_DIR="/home/agent-zara/.claude/heartbeat"
mkdir -p "$LOG_DIR"

STAMP="$(date -Iseconds)"

# The heartbeat prompt fired on each wake. Mirrors the manual heartbeat: sync + enforce the
# list-discipline invariants (agent-task-os rule 12), then continue the In-Progress task.
read -r -d '' HEARTBEAT_PROMPT <<'PROMPT'
HEARTBEAT (autonomous fire): Sync my Trello board to reality and keep walking. (1) Route to the Trello runtime (target_url_contains=trello.com; re-discover via bridge/runtimes). (2) Read the board by MODEL (never screenshot). (3) ENFORCE the list-discipline invariants (agent-task-os rule 12), do not just observe: In Progress = EXACTLY ONE card; Done = only cards with a fully-complete checklist (use trello.card.checklist.read); Blocked = every card states its blocker. (4) Then CONTINUE working the In Progress task — do the next step, do not just report. Trello WRITES via the hosted agent (runtime.agent.start if no session); verify by board model. Never stall — keep walking. This is an unattended autonomous fire: work independently, only surface for irreversible/public/expensive actions.
PROMPT

# Resume the pinned session if we have one; else start fresh and pin the new id.
if [[ -s "$SESSION_FILE" ]]; then
  SID="$(cat "$SESSION_FILE")"
  echo "[$STAMP] resuming session $SID"
  OUT="$("$CLAUDE_BIN" -p "$HEARTBEAT_PROMPT" \
        --resume "$SID" \
        --permission-mode acceptEdits \
        --output-format json \
        2>>"$LOG_DIR/heartbeat.err")"
else
  echo "[$STAMP] no pinned session; starting fresh and pinning"
  OUT="$("$CLAUDE_BIN" -p "$HEARTBEAT_PROMPT" \
        --permission-mode acceptEdits \
        --output-format json \
        2>>"$LOG_DIR/heartbeat.err")"
  NEWID="$(printf '%s' "$OUT" | jq -r '.session_id // empty' 2>/dev/null)"
  [[ -n "$NEWID" ]] && printf '%s' "$NEWID" > "$SESSION_FILE" && echo "[$STAMP] pinned session $NEWID"
fi

# Log a compact result line.
printf '%s' "$OUT" | jq -r '"[\(now|todate)] result: is_error=\(.is_error) turns=\(.num_turns // "?") — \(.result // "" | .[0:200])"' 2>/dev/null \
  || echo "[$STAMP] (could not parse claude -p json output; see heartbeat.err)"
