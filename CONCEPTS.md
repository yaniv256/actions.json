# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Hosted Realtime session

**Single-flight** — the OpenAI Realtime protocol constraint that at most one model response may be generating at any moment; a request to start a second while one is active is rejected. The hosted session manager models this constraint locally so its sends can serialize against it instead of colliding with it.

**Active response** — the one model response currently generating under single-flight. The session is "busy" exactly while an active response exists; it becomes idle when that response finishes (completed or cancelled). Sends that would start a new response wait on, or cancel, the active one rather than racing it.

**Send mode** — the caller's choice for how a new send behaves when a response is already active: *queue* waits for the active response to finish before sending, *interrupt* cancels the active response and sends immediately. A tool result belonging to a response that was cancelled by an interrupt is discarded rather than delivered, because its turn is no longer live.

## Bridge and runtimes

**Bridge** — the process that exposes a stable tool-call surface to agents and routes each call to a connected browser. It owns its own registry of connected runtimes; that registry is independent of the browser extension's internal session state, so a call the bridge can answer from its own knowledge stays live even when an extension-side handler is stuck.

**Runtime** — a single connected browser context (one tab) that the bridge can drive. Runtimes connect and disconnect over the session's lifetime, and their identifiers rotate as tabs are re-claimed or the transport is rebuilt, so a runtime is addressed by identity at call time rather than by a remembered handle.

**Claimed tab** — a browser tab the extension has taken ownership of and will drive on the agent's behalf. Tab-lifecycle operations (listing, activating, closing claimed tabs) read and write the extension's persisted session state; operations that only observe or capture a page do not, which is why the two classes can fail independently.

**Background service worker** — the extension's always-available background context. Under Manifest V3 it is torn down and re-instantiated on its own schedule rather than running continuously, so any state it holds must survive re-instantiation and any readiness it awaits must be able to recover from a restart mid-initialization — code that assumes a single, permanent startup will wedge when the worker is recycled.

## Trusted input

**Trusted input** — keyboard or pointer events dispatched through the browser debugger (CDP) so they carry `isTrusted: true`, letting them reach editors that ignore synthetic (page-script) events. Canvas-rendered editors like Google Docs consume only trusted input; the synthetic path is the portable default but cannot drive them.

**Held-modifier requirement** — Google Docs' keyboard-shortcut layer fires a modifier chord (Ctrl+A, Ctrl+Home, Shift+Arrow, …) only when the modifier is a *genuinely-held key* — a real modifier keyDown pressed before the chord and released after — NOT when a single event merely carries the `modifiers` bitmask (or the DOM `.ctrlKey`/`.shiftKey` flag). A bitmask-only chord reaches Docs but no-ops. Trusted-input dispatch must therefore press each held modifier as its own keyDown around the chord.

**Positional editing** — the human model for editing an existing document: know where the text is from having read it, place the caret there by paragraph index and character offset, and edit in place — never by searching (Find) or clicking pixel coordinates. The alternative Find-based path is banned as fragile and non-human.

**Caret walk** — moving the caret to a target offset by repeating a navigation key (e.g. ArrowRight N times) rather than jumping directly. A canvas editor advances its caret on a throttled loop, so presses fired closer together than its input window are coalesced into one move; a reliable walk must space presses past that window.

**Model read-back** — verifying an edit to a canvas-rendered editor by reading the *document model* (for Docs: a `page.fetch` of the doc, or its `/mobilebasic` export = real DOM HTML) rather than by looking at a screenshot of the canvas. The pixels are a rendering of the model that can lag arbitrarily far behind it — a canvas screenshot can return a *frozen* frame (e.g. when the host display is dormant and the compositor suspends raster), showing a pre-edit state while the model is already correct. So the model is the source of truth; the screenshot is a secondary artifact, and when they disagree the model wins. An automated (non-vision) scorer verifies only by model read-back, never by screenshot.

**Accessibility-gated key-repeat** — a surface-agnostic navigation primitive that presses a key/chord repeatedly and gates each press on the accessibility layer's return value after the previous press, rather than firing an open-loop burst (which coalesces and under-travels). The caller declares a stop mode — fixed count, repeat-until (press until the a11y return matches a stop regex), or repeat-along-a-path (an ordered list of regexes, advancing one press per matched step) — and a per-step gate polarity (advance on match vs advance on mismatch). On a gate failure it halts loud with a structured result (steps done / expected / actual) so the caller re-reads instead of drifting. Reliable Docs word-movement, menu/listbox navigation, tabbing to a field, and stepping a control to a value are all instances of this one primitive.

## Task management

**Telescoping boards** — a task-tracking hierarchy where a single card on one board expands into an entire separate board. The parent board tracks the *existence* of a thing (one card, e.g. "Investigation: X"); a dedicated child board holds its full lifecycle (e.g. an Investigations board with lists Bug -> Investigating -> Root Cause -> Remediation -> Done). Fractal/recursive: any large goal can telescope into its own project board while remaining one card on its parent.

**Context-injection card** — a Trello card treated as a ready-made briefing that lets a returning, memory-less agent resume a task cold. It carries an extensive description (symptom/task/status/next-action), a checklist of sub-tasks, and references to fuller files maintained elsewhere (an investigation .md, the map, the commit) so it stays contained but points to depth. The card is the compressed skill; the files are the full text.

## Investigation & curiosity

**World-model (the map is the model)** — an agent operating a site through actions.json holds expectations about what each action does; those expectations are *encoded in the actions.json map itself*. So an action result that contradicts expectation is the world-model being shown wrong, and repairing the map/primitive/mental-model is the highest-value response — not a nuisance to route around.

**Curiosity (as a workflow)** — the quantified willingness to interrupt the current task and switch to an investigation the moment the world-model is contradicted. Operationalized: contradicted expectation = interrupt; push the current task with a full context-injection card (so it resumes cold); open an investigation to repair the model; verify by ground truth (screenshot / model read), not the projection you authored; follow the surprise because the true cause usually moves. Higher curiosity = more willing to switch to a new investigation on a model-deficiency signal.

**Reveal experiment** — an experiment run to *manufacture* a hypothesis you could not enumerate (inspect the real element, strip a layer, drive the real thing), as opposed to a discriminating experiment that only referees among named hypotheses. The move to make when first-cut hypotheses keep dying: get a different KIND of data, not another variation of the same idea.
