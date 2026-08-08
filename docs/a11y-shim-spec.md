# Accessibility Automation Runtime

The Chrome extension includes an accessibility runtime that adapts Chrome's
accessibility tree into the subset of the `chrome.automation` model used by the
bundled ChromeVox live-region pipeline. This document describes the behavior in
the current implementation. The executable sources and tests remain the
authority when this overview and the runtime differ.

## Runtime components

- `src/a11y/automation_shim.js` wraps CDP accessibility nodes as `ShimNode`
  objects, maintains parent/child relationships, and installs the supported
  `chrome.automation` functions.
- `src/a11y/live_region_observer.js` discovers ARIA live regions in page DOM,
  observes later additions and text changes, and emits bounded tree-change
  batches.
- `src/a11y/announcer.js` connects the accessibility tree and tree-change
  stream to the bundled ChromeVox live-region logic.
- `src/a11y/tts_sink.js` converts ChromeVox speech output into extension
  announcement records.
- `esbuild.a11y.mjs` bundles the required ChromeVox modules and substitutes
  standard-extension implementations for privileged ChromeOS seams.

## Supported automation surface

`installAutomationShim({getTree})` installs four operations on
`chrome.automation`:

- `addTreeChangeObserver` and `removeTreeChangeObserver` maintain the observer
  set used by the live-region pipeline.
- `getDesktop` returns the current tree's synthetic desktop root.
- `getFocus` returns the focused node from the current tree.
- `setDocumentSelection` is intentionally a no-op; the standard extension does
  not claim to implement ChromeOS document-selection authority.

The returned dispatcher sends each tree-change record to every registered
observer. An exception in one observer is contained and does not suppress the
others.

`ShimNode` exposes the roles, relationships, state, text, live-region metadata,
selection metadata, table metadata, and action helpers consumed by the bundled
ChromeVox modules. Values are derived from CDP AX nodes and normalized into the
string-valued enums used by `chrome.automation`.

## Tree topology and focus

Each accessibility tree is attached beneath synthetic desktop and window
nodes. The active window is marked focused. This supplies the topology that
ChromeVox uses to distinguish the active document and to decide whether an
announcement should interrupt or queue.

The synthetic nodes are runtime structure only. They do not grant page or tab
authority; tab ownership and debugger attachment remain governed by the
extension's session and claim checks.

## Live-region observation

The page observer scans the current document for ARIA live regions and watches
for regions added later. Each region is observed once. Regions whose computed
politeness is `off` are ignored.

DOM mutations are translated into bounded records containing:

- change type;
- text, capped at 4,000 characters;
- stable region identity;
- politeness, atomic, relevant, role, and busy metadata.

Records from one scheduled burst are emitted together and terminated by a
`subtreeUpdateEnd` record. ChromeVox then applies its live-region relevance,
atomicity, busy-state, queueing, and deduplication behavior.

## Announcement records

Speech output is represented as structured announcement data rather than sent
directly to a privileged system TTS API. Records carry the announcement text,
politeness and interruption hints, source tab and region identity, and a
timestamp. The bridge and extension runtime can therefore expose announcements
without granting page code access to accessibility internals.

## Deliberately unsupported platform seams

The bundle replaces ChromeOS-only braille, panel, offscreen, settings,
platform-storage, logging, earcon, and bridge modules with inert or bounded
standard-extension adapters. These substitutions are explicit in
`esbuild.a11y.mjs`; an unresolved ChromeVox import fails the build instead of
silently expanding the extension's authority.

## Verification

Current behavior is covered by the accessibility unit tests, extension runtime
characterization tests, package-completeness checks, and the live accessibility
smoke test. Packaging must include the generated accessibility bundle and all
runtime imports, and the live gate must load the unpacked extension in Chromium
and exercise the behavior end to end.
