---
title: Hosted Agent Chat UI
nav_order: 2
parent: Hosted Agent
---

# Hosted Agent Chat UI

This document describes the transcript pattern for the Chrome extension hosted
agent.

The UI goal is simple: the agent pane should feel like a small voice control
and a readable conversation, not a stream of protocol events.

For the user-facing hosted agent guide, see [Hosted Agent](hosted-agent.md).

## Current Layout

The trusted `actions.json` menu is a single agent pane titled
**actions.json agent**. There are no tabs. The pane contains:

- the voice launcher;
- mute mic and mute speaker buttons;
- a bounded transcript;
- a text composer for typed input.

All settings (OpenAI key, voice, turn detection, bridge URL, storage, memory)
live in the extension popup, not in the overlay.

The extension popup also exposes direct session controls (Start/Mute/Stop) so
the user can stop a hidden offscreen session even if the overlay is closed.

## Voice Launcher States

The voice launcher is the main control and the primary status surface. Its
label tracks the session:

- **Start voice** — idle, no session;
- **Connecting** — session starting;
- **Listening** — capturing user speech;
- **Thinking** — the model is working;
- **Using tool** — a tool call is executing (transient; successful tool calls
  do not write transcript lines);
- **Speaking** — the agent is talking;
- **Session live** — connected and waiting.

## Mute Buttons

The mute mic and mute speaker buttons are icon buttons. When muted, each shows
a full corner-to-corner diagonal slash across the icon so the muted state is
unambiguous at a glance.

## Reference Pattern

The transcript follows the chat pattern used by RoomJinni in the HeyCode
workspace:

- completed user turns render as user bubbles;
- assistant turns render as assistant bubbles;
- deltas update one live message;
- completion finalizes that same message;
- session status, errors, tool failures, and permission messages render as
  compact status lines between the bubbles;
- successful tool calls render nothing — the launcher's **Using tool** state
  is the only indication.

The key behavior is one mutable transcript row per spoken turn.

## Why Deltas Must Merge

Realtime APIs emit partial transcript deltas. Rendering every delta as a new
bubble creates unreadable output:

```text
Hi
there
!
Hi there!
```

The UI should instead update one live message — one user bubble, one assistant
bubble:

```text
What can you see?
I can inspect the page now.
```

The final transcript event replaces or confirms the same row. It must not append
a duplicate final row.

## User Turns

User audio transcription should behave the same way as agent audio:

1. `conversation.item.input_audio_transcription.delta` updates one live user
   bubble.
2. `conversation.item.input_audio_transcription.completed` finalizes that same
   user bubble.
3. If only a completed event arrives, create one completed user bubble in
   the correct chronological position.

Correct ordering matters. The user turn that caused a response must appear
before the agent response, even if final transcription arrives late.

## Agent Turns

Agent audio transcript events should:

1. create or update one live assistant bubble for the active response;
2. append deltas to the live text;
3. finalize in place on transcript completion;
4. mark interruption when the user cuts off the response.

When a response is interrupted, the session log should preserve enough evidence
to tell what text was planned, what text was delivered, and where the agent
should resume.

## Text Composer

Below the transcript is a composer: a text area ("Type to the agent") with a
send button. Submitting it sends a user message into the live session, so the
user can type instead of speaking. The composer is enabled only while a session
is connected.

## Tool Calls

Tool calls should not block transcript rendering, and successful tool calls do
not appear in the transcript at all. While a tool runs, the voice launcher
shows a transient **Using tool** state.

The transcript carries only two kinds of tool-related status lines:

- a single failure line when a tool call fails:

```text
Tool actions.site failed: action not found.
```

- one line at session start reporting how many bridge tools loaded — a count,
  not a list:

```text
Bridge tools loaded: 12.
```

The session log should include full tool details:

- tool name;
- arguments;
- result;
- error or timeout;
- runtime id and URL when available.

The transcript should remain a conversation. Diagnostics belong in
`runtime.session.log`.

## Scrolling Behavior

The transcript area should be bounded and internally scrollable.

Expected behavior:

- if the user is at the bottom, new messages keep the transcript pinned to the
  bottom;
- if the user scrolls up, new messages do not yank them back down;
- a visible affordance can indicate that new content is available below.

## Verification

Test the transcript with:

1. a short user question and short agent answer;
2. a long agent answer with multiple deltas;
3. user interruption while the agent is speaking;
4. a tool call that takes long enough to show activity;
5. navigation that closes and reinjects the overlay.

Pass criteria:

- no token-by-token transcript spam;
- no duplicate final agent messages;
- user turns appear before the answer they caused;
- a running tool shows the **Using tool** launcher state, a successful tool
  adds no transcript line, and a failed tool adds exactly one failure line;
- reopening the overlay preserves the conversation state.
