# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Hosted Realtime session

**Single-flight** — the OpenAI Realtime protocol constraint that at most one model response may be generating at any moment; a request to start a second while one is active is rejected. The hosted session manager models this constraint locally so its sends can serialize against it instead of colliding with it.

**Active response** — the one model response currently generating under single-flight. The session is "busy" exactly while an active response exists; it becomes idle when that response finishes (completed or cancelled). Sends that would start a new response wait on, or cancel, the active one rather than racing it.

**Send mode** — the caller's choice for how a new send behaves when a response is already active: *queue* waits for the active response to finish before sending, *interrupt* cancels the active response and sends immediately. A tool result belonging to a response that was cancelled by an interrupt is discarded rather than delivered, because its turn is no longer live.

## Empowered website agents

**Empowered website agent** — a page-hosted agent that may ask the browser extension to operate other tabs only through capabilities declared by an immutable bundle and explicitly approved by the user; discovering the agent or opening its private channel grants no action authority by itself.

**Delegated approval** — the durable user decision that binds one empowered website agent to its source origin and the exact reviewed bytes of its immutable capability bundle. Revocation makes the approval unusable for new or existing delegated activations.

**Approval authority outcome** — the result of resolving a Delegated approval, distinguishing verified live authority, authoritative absence or revocation, temporary unavailability, and integrity failure.

Only verified live authority permits delegated use. Destructive cleanup requires authoritative absence or a valid revocation; unavailable or integrity-failing authority suspends use while preserving recoverable ownership.

**Durable authority commit** — a delegated-authority state transition whose normal completion requires an acknowledged, uncancelled durable record and a marker-free compatibility mirror. During replacement recovery, a surviving marker vetoes an exact late acknowledgement and restores its embedded rollback state, while a distinct, genuinely later committed ledger candidate may supersede that older recovery marker.

Prepared and applied records retain rollback or cleanup intent across worker replacement. The ledger advances beyond every prepared revision, final mirror confirmation is never timer-abandoned, and immutable bundles use transaction-scoped physical keys. A failed transition therefore remains non-authorizing, while a genuinely later successful transition is distinguished by its own identity and physical resource ownership.

**Website agent group** — one isolated activation of a delegated approval, with its own home lease and exclusively owned working tabs, kept separate from the extension-hosted agent's ordinary tab group.

**Home lease** — the browser-authenticated binding between a website agent group and the top-level page document that hosts it, identified by tab, document, origin, and a fresh private-channel nonce. A navigation or page hide ends the old channel; a BFCache restoration may retain the document binding only by establishing a new channel.

## Bridge and runtimes

**Bridge** — the process that exposes a stable tool-call surface to agents and routes each call to a connected browser. It owns its own registry of connected runtimes; that registry is independent of the browser extension's internal session state, so a call the bridge can answer from its own knowledge stays live even when an extension-side handler is stuck.

**Runtime** — a single connected browser context (one tab) that the bridge can drive. Runtimes connect and disconnect over the session's lifetime, and their identifiers rotate as tabs are re-claimed or the transport is rebuilt, so a runtime is addressed by identity at call time rather than by a remembered handle.

**Runtime liveness invariant** — the rule that the bridge presents a runtime as actionable (listable, routable, dispatchable) only when it is *ground-truth alive*, never when a mere proxy (an open socket, a non-empty registry, a once-written timestamp) suggests it. It is enforced in depth, not by one signal: a recurring heartbeat plus a staleness TTL ages out dead runtimes, a tab-close event reaps one immediately, and a liveness probe at dispatch is the hard guarantee that a call can never reach a runtime whose tab no longer exists.

The invariant has two directions and they fail differently — see *Asymmetric reliability*. Advertising a *dead* runtime as connected is the **lying-liveness** failure, and it is the one the enforcement above is built against. Dropping a *live* runtime is the converse, and it is the quieter one: a freshly claimed tab that registers but never connects to the transport carrying its heartbeat is aged out by the very TTL that protects the first direction, while its tab stays open. Registration and connection are therefore distinct states, and a registry entry is not evidence of either; only an advancing heartbeat is.

**Registration versus connection** — registration places a runtime in the bridge's registry; connection plugs the browser context into the transport that carries its heartbeat and its primitive dispatch. Only the second keeps a runtime alive, so a claim path that registers and then swallows a failed connect produces a runtime that is briefly dispatchable, never heartbeating, and reaped as stale while its tab is still open. The distinction must be surfaced as two separate facts, never collapsed into one word.

**Claimed tab** — a browser tab the extension has taken ownership of and will drive on the agent's behalf. Tab-lifecycle operations (listing, activating, closing claimed tabs) read and write the extension's persisted session state; operations that only observe or capture a page do not, which is why the two classes can fail independently.

Ownership is authoritative only when the durable owner and the exact ownership revision match. Ordinary session metadata and the visual Chrome tab group are secondary projections: they may describe an owner, but they never grant authority, and compensation may alter them only while their revision still matches the failed durable claim.

**Owner-qualified runtime address** — the pair of a bridge runtime identity and a browser-local tab identity copied from one global inventory row. The runtime identifies which connected browser owns the tab number; the tab number alone is not globally unique.

The address is generation-sensitive: full-document navigation preserves the tab container but replaces its document runtime, so a successful replacement operation must return a newly attested runtime identity. An operation that targets the already selected runtime without an explicit local tab identity does not need the pair.

**Background service worker** — the extension's privileged, event-driven background context. Under Manifest V3 it can suspend between events rather than remaining a durable controller throughout a multi-turn automation.

Its appearance can attest that an extension loaded and reveal that extension's identity, but it is not a durable multi-turn automation controller: an evaluation can disappear if the worker suspends between protocol turns.

**Extension-owned page** — a persistent document served from an extension's own origin, able to call that extension's privileged browser APIs without depending on the background service worker remaining awake. Multi-turn automation can discover extension identity from the worker, then use an extension-owned page as its stable controller.

**Primitive** — a named, generic unit of browser capability that an agent may invoke directly or that a site map's workflow steps may compose. Exposure is surface-specific: portable workflow and hosted-agent exposure derives from the primitive dictionary, while direct bridge-tool exposure derives from the bridge tool declaration and routing layer. Declaration, documentation, implementation, exposure, and live reachability are separate properties; only evidence at each boundary establishes that property.

Primitives divide by the context they run in, and the division is load-bearing. A *portable* primitive executes in the page's content script and is therefore reachable from a workflow step. A *privileged* one executes in the background over the browser debugger, and is reachable only by a direct agent call — a workflow step that names it fails at parse time. That context split does not collapse the boundary distinction above: only invoking a primitive establishes live reachability.

**State projection** — a named read, optionally constrained to a route scope, that turns a website's current rendered state into a logical object an agent or workflow can verify. When a projection declares route scope, applicability is evaluated on the page where the read runs, so a route-changing action must choose one available on its destination route.

**Proof package** — an immutable evidence bundle produced by validating an operational site map, distinct from the live map even when it contains a byte-identical `actions.json`. A proof package records what was tested; its files must never be discovered as executable actions, projections, or relative companion declarations.

**Catalog revision coherence** — the invariant that actions, workflows, state projections, and companion resources derived from one storage catalog describe the same revision. A bridge violates coherence when it caches action declarations but live-reads workflow bodies or projections: after a storage update it can advertise an action it cannot execute, or execute state from an action it does not advertise. Refresh all parts at one operation boundary or read them from one immutable revision snapshot.

**Extension package contract** — the enforced agreement between the extension's intentional archive inventory and every file its production runtime can load.

**Route-or-refuse** — the dispatch contract for tab-targeted background tool calls: a call routed to a specific runtime executes against exactly that runtime's tab or errors; it never silently falls back to the extension-active tab. The routing layer resolves the target once (`routedTabId`) and every handler must consume that resolution or refuse — re-deriving the target from ambient active-tab state is the defect class this contract exists to prevent.

A package clears this contract only when declared pages, production-injected scripts, generated browser bundles, and transitively reachable modules are present in the archive and the extracted artifact executes its affected behavior in a real browser. Exact inventory, runtime-graph completeness, and extracted-artifact behavior are separate evidence boundaries.

**Release ancestry gate** — proof that every feature claimed for a release belongs to the exact target commit's tree before packaging begins.

It classifies absence at the correct boundary: source missing from the target is release sequencing or scope; source present but archive missing is a package-contract failure; archive present but behavior broken is a runtime failure. Commit timestamps and unmerged branches are not inclusion evidence — Git topology and the immutable release target are.

**Terminal action outcome** — the first `action_call_output` or `action_error` carrying one action call's exact identity after asynchronous dispatch.

The two message types are a closed result union, not independent optional streams. A collector must wait for either by call ID and preserve an error's code and message; waiting for success alone turns a real failure into apparent silence. A visible mutation does not satisfy this contract because result serialization, persistence, or response delivery may still fail after the UI changes.

**Single-authority projection** — a State projection contract in which each logical row is emitted once and derived views (unchecked items, failures, subsets) are computed by consumers from that row collection. Duplicating an unbounded source collection into convenience arrays spends the workflow expression budget on redundant facts and can make otherwise valid large objects unreadable.

**Lossy projection** — a State projection that extracts records and then emits only a derived scalar about them, most often `$count(...)`, discarding the content itself. The agent learns *how many* and never *which*, so a correct navigation still ends in asking the user to describe the page. Raising `max_bytes` or preferring `state_read` over `state_summary` does not recover it: the records are destroyed inside the projection expression, below the layer where the symptom appears. Detected by the `lossy_projection` audit rule, which keys on the extract-to-emit relationship rather than on the presence of `$count` — a projection emitting rows *and* a count is correct.

**Unadvertised capability** — a tool or State projection that is authored, live, and correct, yet named nowhere the agent reads: not the map `prompt`, not `notes`, not any tool description. From inside a session the agent's situation is indistinguishable from the capability not existing, so it improvises instead — the signature symptom being an embedded agent asking the visitor to describe the page it is standing on. A map instruction like "RE-READ the destination page" with no tool named is the canonical shape. Detected by the `unadvertised_projection` audit rule. See [[Lossy projection]] for the sibling defect where the capability *is* known but destroys its own data.

**Fabricating lookup** — a tool that *computes* an identifier it cannot know (concatenating caller-supplied parts into a URL, id, or path) instead of *looking it up* in authoritative data the map already carries, and reports success either way. Measured on `helpx.adobe.com`: 63% of a 751-article corpus sits under a subtopic segment the model has no way to guess, so the resolver 404'd more often than it succeeded while the correct URL sat unused in `article-index.json` beside it. The fix is always a lookup that reports absence honestly, never a better guess.

**Projection fidelity** — a State projection's obligation to report the relationship between what it extracted and what it emitted, so a bounded or partial read is distinguishable from a complete one. A bare list of five is indistinguishable from a complete list of five, and that ambiguity is what converts a partial read into a confident wrong answer. Covers the whole lossy family: count-only emission, viewport-scoped reads, virtualization, and truncation.

**Workflow postcondition** — a logical assertion evaluated after a workflow succeeds, using a State projection and the workflow's original input to decide whether the intended effect actually occurred. Dispatch success alone cannot satisfy it; if the projection is unavailable or the assertion fails, the action reports failure even when earlier interaction steps already changed the page.

**Verification locality** — the rule that a large State projection used only to compute a postcondition or diff remains in the content realm that produced it. Only the bounded verification result, metadata, or patch crosses into the background worker and bridge; internal compute capacity is not an expansion of the public response contract.

**Projection budget domain** — one independently enforced size boundary for state-projection work: *public response* bounds caller-visible full state, *internal compute* bounds page-local verification or diff inputs, *internal transfer* bounds data that may cross extension realms, and *diff response* bounds returned patches. A public `max_bytes` argument may lower its domain's ceiling but never raise it.

**Indeterminate mutation outcome** — the status of a workflow whose potentially state-changing step completed before a later retry exhaustion, required-settle timeout, or verification/confirmation failure, leaving the mutation's commit state unknown when no higher-priority overlay or explicit postcondition classification applies.

It is recoverable but not retryable by default: an independent State projection must prove that the mutation did not commit before the workflow may be repeated. A read-only readiness failure before any mutation remains a different, safely retryable state.

**Visible (as a predicate)** — in this codebase *visible* means an element currently intersects the viewport, never that it exists. An element scrolled out of view is present in the DOM and addressable, yet reports as not visible; so any read that filters on visibility answers "what is rendered", not "what is there".

The distinction governs which read to reach for. Enumerating a scrollable collection through a visibility filter under-reports by whatever is scrolled away, and that under-report is indistinguishable from genuine absence — the failure is silent, and it is the quiet direction of *Asymmetric reliability*. To count or read a collection, use a read that does not filter on visibility and that reports each match's visibility separately, so "what is rendered" and "what exists" stay separable. To *click* an element, visibility is required rather than incidental: a locator that resolves a single element scrolls its match into view first, curing the invisibility, where a bare enumeration merely reports it as absent. Reading must not require rendering; clicking must — but rendering an element does not yet make it clickable, because a rendered element can still be painted over. Visibility is necessary and not sufficient for a click; the sufficient property is *Hittable*.

**Hittable** — the property that a synthetic click delivered at a given point actually reaches the element one intended, rather than something painted above it. A resolver answers *where an element is*; hittability answers *whether a click there arrives*, and the two diverge whenever a sticky header, a floating toolbar, a banner, or an injected overlay covers the point.

The coordinate a resolver hands back is the midpoint of a bounding rectangle, computed geometrically and never tested against the paint order — so an element can be fully within the viewport, correctly resolved, and still unclickable at its own centre. The failure is silent in the worst way: the click is delivered, the pointer primitive reports success, and the occluder absorbs it, so every step in a workflow returns cleanly while nothing changes. Occlusion is therefore established only by hit-testing the point, never inferred from the resolution succeeding. Two consequences follow. A very small target is a warning rather than a convenience — the smaller the element, the less margin its centre has against an occluder, so prefer a rendered, appreciably-sized control bound by identity over a hidden one bound by geometry. And an occluder the agent itself injects can be hidden before operating and restored after, but an occluder belonging to the site cannot; only re-positioning the target or choosing a different one clears it. Because the only instrument that observes the difference is a postcondition that can fail, an action which mutates through a click is trustworthy exactly to the degree its verification step is armed to fail loudly.

## Trusted input

**Trusted input** — keyboard or pointer events dispatched through the browser debugger (CDP) so they carry `isTrusted: true`, letting them reach editors that ignore synthetic (page-script) events. Canvas-rendered editors like Google Docs consume only trusted input; the synthetic path is the portable default but cannot drive them.

**Held-modifier requirement** — Google Docs' keyboard-shortcut layer fires a modifier chord (Ctrl+A, Ctrl+Home, Shift+Arrow, …) only when the modifier is a *genuinely-held key* — a real modifier keyDown pressed before the chord and released after — NOT when a single event merely carries the `modifiers` bitmask (or the DOM `.ctrlKey`/`.shiftKey` flag). A bitmask-only chord reaches Docs but no-ops. Trusted-input dispatch must therefore press each held modifier as its own keyDown around the chord.

**Positional editing** — the human model for editing an existing document: know where the text is from having read it, place the caret there by paragraph index and character offset, and edit in place — never by searching (Find) or clicking pixel coordinates. The alternative Find-based path is banned as fragile and non-human.

**Caret walk** — moving the caret to a target offset by repeating a navigation key (e.g. ArrowRight N times) rather than jumping directly. A canvas editor advances its caret on a throttled loop, so presses fired closer together than its input window are coalesced into one move; a reliable walk must space presses past that window.

**Model read-back** — verifying an edit to a canvas-rendered editor by reading the *document model* (for Docs: a `page.fetch` of the doc, or its `/mobilebasic` export = real DOM HTML) rather than by looking at a screenshot of the canvas. The pixels are a rendering of the model that can lag arbitrarily far behind it — a canvas screenshot can return a *frozen* frame (e.g. when the host display is dormant and the compositor suspends raster), showing a pre-edit state while the model is already correct. So the model is the source of truth; the screenshot is a secondary artifact, and when they disagree the model wins. An automated (non-vision) scorer verifies only by model read-back, never by screenshot.

**Accessibility-gated key-repeat** — a surface-agnostic navigation primitive that presses a key/chord repeatedly and gates each press on the accessibility layer's return value after the previous press, rather than firing an open-loop burst (which coalesces and under-travels). The caller declares a stop mode — fixed count, repeat-until (press until the a11y return matches a stop regex), or repeat-along-a-path (an ordered list of regexes, advancing one press per matched step) — and a per-step gate polarity (advance on match vs advance on mismatch). On a gate failure it halts loud with a structured result (steps done / expected / actual) so the caller re-reads instead of drifting. Reliable Docs word-movement, menu/listbox navigation, tabbing to a field, and stepping a control to a value are all instances of this one primitive.

Because its gate reads the accessibility layer, it is a *privileged* primitive in the sense of *Primitive* above: an agent may invoke it directly, but a workflow step that names it cannot run. A site map that composes it as a step is dead on arrival, and fails when the workflow is parsed rather than when the step would have executed.

## Task management

**Telescoping boards** — a task-tracking hierarchy where a single card on one board expands into an entire separate board. The parent board tracks the *existence* of a thing (one card, e.g. "Investigation: X"); a dedicated child board holds its full lifecycle (e.g. an Investigations board with lists Bug -> Investigating -> Root Cause -> Remediation -> Done). Fractal/recursive: any large goal can telescope into its own project board while remaining one card on its parent.

**Context-injection card** — a Trello card treated as a ready-made briefing that lets a returning, memory-less agent resume a task cold. It carries an extensive description (symptom/task/status/next-action), a checklist of sub-tasks, and references to fuller files maintained elsewhere (an investigation .md, the map, the commit) so it stays contained but points to depth. The card is the compressed skill; the files are the full text.

**Closure evidence** — direct current-state proof that every deliverable a task or investigation declared is complete, including committed implementation, required tests, distribution or deployment, and affected-boundary live verification. A checklist, status word, source-only fix, accepted limitation, or follow-up task may describe progress but cannot replace the evidence required for a Done transition.

**Run-owned process tree** — the complete hierarchy of operating-system processes started for one live or evaluation run and exclusively owned by that run's supervisor.

The run is not complete until that hierarchy has been reaped. A wrapper exit, signal sent to one PID, or successful worker result is insufficient when a child, grandchild, browser, listener, or helper can survive; the supervisor must establish the ownership boundary before acquisition and verify descendant absence before returning.

## Investigation & curiosity

**World-model (the map is the model)** — an agent operating a site through actions.json holds expectations about what each action does; those expectations are *encoded in the actions.json map itself*. So an action result that contradicts expectation is the world-model being shown wrong, and repairing the map/primitive/mental-model is the highest-value response — not a nuisance to route around.

**Curiosity (as a workflow)** — the quantified willingness to interrupt the current task and switch to an investigation the moment the world-model is contradicted. Operationalized: contradicted expectation = interrupt; push the current task with a full context-injection card (so it resumes cold); open an investigation to repair the model; verify with independent, calibrated evidence (fresh target-bound pixels for appearance; application model/export for semantic state), not the projection you authored; follow the surprise because the true cause usually moves. Higher curiosity = more willing to switch to a new investigation on a model-deficiency signal.

**Reveal experiment** — an experiment run to *manufacture* a hypothesis you could not enumerate (inspect the real element, strip a layer, drive the real thing), as opposed to a discriminating experiment that only referees among named hypotheses. The move to make when first-cut hypotheses keep dying: get a different KIND of data, not another variation of the same idea.

**Null experiment** — an experiment whose probe could not have produced a different result, so it discriminates nothing however cleanly it runs. Two forms: the probe observes a state in which the phenomenon *cannot* manifest, or the probe executes in a context the code under test does not inhabit. It is the failure mode a Reveal experiment answers, and it is invisible from inside: predictions were committed, the observation was honest, and the answer was still uninformative. The tells are a result that comes back fast and clean while the symptom persists, and a set of successive refutations that all share one probe.

**Instrument validity** — the property that a measurement reports the system rather than the observer, and that a probe can reach the code under test. A clock read on either side of an agent's own tool call measures the agent's turn, not the system; prefer the system's self-reported timings, or remove the agent from the loop. Establish validity before the first measurement of a session, by measuring something whose true cost is already known. An instrument error is more durable than a reasoning error: a wrong conclusion can be caught by re-reading the argument, but a wrong instrument corrupts the evidence, so every conclusion drawn from it is internally consistent.

**Asymmetric reliability** — the property that an instrument can be trustworthy in one direction of answer and worthless in the other, so a single "reliability" score for it is meaningless. An instrument whose false-positive rate is near zero while its false-negative rate is high and unmeasured is a valid *positive oracle* — when it fires, believe it — and never a *clearance*: its silence is not evidence of absence, only an absence of measurement. The two rates must therefore be tracked separately, and which of them dominates depends on what the answer is used for: a false positive costs most where the answer prompts an edit, a false negative costs most where it clears a release. The direction an instrument fails in is also the direction nobody checks, because nobody investigates a quiet tool.

**Hypothesis-space attractor** — a conclusion that is disproportionately likely to be *wrong* precisely because it is disproportionately *attractive*: it relieves effort, removes blame, or ends the pressure to keep producing. Because attractiveness and truth are independent, an attractor must clear the highest evidentiary bar rather than the lowest, and the felt pull toward it is the signal to probe harder. Two recur. *Exculpatory explanation* — "it is the platform's fault" — is the attractor of a debugging investigation, answered by the maximum-pain rule: prefer the hypothesis that implicates you, and test it first. *"I am blocked"* is the same attractor wearing the task loop's clothes, since declaring a block ends the pressure while feeling responsible; it is answered by the cheapest disproof — write the self-implicating alternative ("maybe I am calling it wrong") and disprove that before asking a human. A block that has not been probed is a guess wearing the clothes of a constraint.

## Agent orchestration

**Chained prompt** — a multi-phase methodology (an investigation, a review protocol, a release gate) delivered to an agent one phase at a time, in strict order, so that no phase can be skipped and the final phase is genuinely reached. The chain holds only anchors into a live skill file, not copies, so the skill stays the single source of truth. It exists because an agent left to run a methodology from memory drops the unglamorous late phases under momentum.

**Phase** — one step of a chained prompt: a named unit with a prompt, served only after the previous phase is marked complete. Phases run in defined order; completing a phase out of order is rejected. The last phase reached is the contract that the methodology ran to its end, not just its start.

**First-party delivery** — the rule that any prompt, nudge, or wake reaches an agent through the agent's *own* channels — a tool result it reads, or a scheduler it arms itself — never through an external process writing into its session (terminal paste, message injection, a daemon posting a beat). Its opposite, session injection, reads as external automation of the agent (a Terms-of-Service ban risk) and implies a rival second driver contending over the agent's resources; first-party delivery has exactly one driver — the agent acting on itself. *Avoid:* injection-based delivery, tmux paste.

**Anti-idle self-wake** — the first-party mechanism that keeps an agent from going idle in the middle of a chained prompt. Rather than an outside process waking the agent, the chain tells the agent to arm its own recurring wake (its harness scheduler), and a reminder tool returns the current phase, its prompt, and a standing "do not go idle, do not stop to ask" message for that self-armed wake to fire. Only fires into a persistent, alive-idle session — a live event loop between turns — not a fully dormant one.
