# Hosted Agent Chat UI

This document describes the transcript pattern for the Chrome extension hosted
agent.

The UI goal is simple: the Agent tab should feel like a small voice control and
a readable conversation, not a stream of protocol events.

For the user-facing hosted agent guide, see [Hosted Agent](hosted-agent.md).

## Current Layout

The trusted `actions.json` menu has top-level tabs:

- **Agent**: voice control, mute/stop controls, and transcript.
- **Settings**: OpenAI key, bridge URL, voice, VAD, memory, storage, and
  diagnostic controls.

The extension popup also exposes direct voice controls so the user can stop a
hidden offscreen session even if the overlay is closed.

## Reference Pattern

The transcript follows the chat pattern used by RoomJinni in the HeyCode
workspace:

- completed user turns render as `User:`;
- assistant turns render as `Agent:`;
- deltas update one live message;
- completion finalizes that same message;
- status, tool execution, errors, and permission messages stay outside the
  transcript or are rendered as compact event rows.

The key behavior is one mutable transcript row per spoken turn.

## Why Deltas Must Merge

Realtime APIs emit partial transcript deltas. Rendering every delta as a new
line creates unreadable output:

```text
Agent: Hi
Agent: there
Agent: !
Agent: Hi there!
```

The UI should instead update one live message:

```text
User: What can you see?
Agent: I can inspect the page now.
```

The final transcript event replaces or confirms the same row. It must not append
a duplicate final row.

## User Turns

User audio transcription should behave the same way as agent audio:

1. `conversation.item.input_audio_transcription.delta` updates one live `User:`
   message.
2. `conversation.item.input_audio_transcription.completed` finalizes that same
   `User:` message.
3. If only a completed event arrives, create one completed `User:` message in
   the correct chronological position.

Correct ordering matters. The user turn that caused a response must appear
before the agent response, even if final transcription arrives late.

## Agent Turns

Agent audio transcript events should:

1. create or update one live `Agent:` message for the active response;
2. append deltas to the live text;
3. finalize in place on transcript completion;
4. mark interruption when the user cuts off the response.

When a response is interrupted, the session log should preserve enough evidence
to tell what text was planned, what text was delivered, and where the agent
should resume.

## Tool Calls

Tool calls should not block transcript rendering.

The UI should show compact tool activity, for example:

```text
Using actions.site: navigation.open_products
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
- tool activity is visible but not mixed into the spoken transcript;
- reopening the overlay preserves the conversation state.
