#!/usr/bin/env bash
# Enable / disable the autonomous heartbeat cron line — SAFE, reversible, idempotent.
# Plan: actions.json.dev/docs/plans/2026-07-08-001-feat-autonomous-heartbeat-headless-plan.md (#173).
#
# This ONLY edits the user crontab (adds/removes ONE line that calls heartbeat-run.sh). It preserves
# every other crontab entry (e.g. the gpu-queue @reboot line). Enabling is the consequential step —
# do it only on Yaniv's go. Disabling is always safe.
#
#   heartbeat-cron.sh enable [interval_min]   # add the line (default 30 min); needs Yaniv's go
#   heartbeat-cron.sh disable                 # remove the line (always safe)
#   heartbeat-cron.sh status                  # show whether the line is present
#
set -uo pipefail

RUNNER="/home/agent-zara/.claude/heartbeat/heartbeat-run.sh"
LOG="/home/agent-zara/.claude/heartbeat/heartbeat.log"
MARKER="# ZARA-HEARTBEAT"   # tag so we can find/remove exactly our line

cmd="${1:-status}"
interval="${2:-30}"

current_crontab() { crontab -l 2>/dev/null; }

case "$cmd" in
  enable)
    if ! [[ "$interval" =~ ^[0-9]+$ ]] || (( interval < 1 || interval > 59 )); then
      echo "interval must be 1-59 minutes"; exit 2
    fi
    line="*/$interval * * * * $RUNNER >> $LOG 2>&1 $MARKER"
    # Strip any prior heartbeat line, then append the new one — preserves all other entries.
    { current_crontab | grep -vF "$MARKER"; echo "$line"; } | crontab -
    echo "ENABLED heartbeat every $interval min:"
    echo "  $line"
    ;;
  disable)
    { current_crontab | grep -vF "$MARKER"; } | crontab -
    echo "DISABLED heartbeat (removed the $MARKER line; all other crontab entries preserved)."
    ;;
  status)
    if current_crontab | grep -qF "$MARKER"; then
      echo "heartbeat cron: PRESENT ->"; current_crontab | grep -F "$MARKER"
    else
      echo "heartbeat cron: NOT installed"
    fi
    ;;
  *)
    echo "usage: heartbeat-cron.sh {enable [interval_min]|disable|status}"; exit 2
    ;;
esac
