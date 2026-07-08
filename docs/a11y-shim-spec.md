# AutomationShim Spec (a11y phase 1, U1 deliverable)

Authoritative contract for replatforming ChromeVox's live-region brain onto standard-extension inputs. Derived from the vendored fork at `third_party/chromevox` (chromium/src @ `7df028f9`, chromevox + `accessibility/common` subtrees). Plan: `docs/plans/2026-07-06-accessibility-primitive-layer-brainstorm.md`.

**Method:** import-closure walk from `mv3/background/live_regions.ts` + `mv3/background/output/*.ts` (425 edges); AutomationNode member enumeration over identifiers TypeScript-typed as `AutomationNode` plus conventional node locals; `chrome.automation.*` symbol grep; line-verified read of `live_regions.ts`. Grep-based member enumeration is a superset guide — U3 finalizes per-member semantics against recorded AX-tree fixtures.

---

## 1. The TreeChange observer contract (verified line-by-line)

The **only** web-content entry point into LiveRegions (`mv3/background/live_regions.ts`):

- Constructor (L64–68): `chrome.automation.addTreeChangeObserver(TreeChangeObserverFilter.LIVE_REGION_TREE_CHANGES, treeChange => this.onTreeChange(treeChange))`. The shim implements `addTreeChangeObserver` for this filter.
- `TreeChange = {type, target}` where `target` is an AutomationNode and `type ∈ {NODE_CREATED, SUBTREE_CREATED, TEXT_CHANGED, NODE_REMOVED, SUBTREE_UPDATE_END}`.
- `onTreeChange` (L117–151): early-returns unless `target.containerLiveStatus` is set and ≠ `'off'` — **except `SUBTREE_UPDATE_END`, which must always be delivered** (it flushes the queued batch, L148–150). Relevance parsing (`additions`/`text`/`removals`/`all` from `containerLiveRelevant`) happens **in the fork** (L129–146) — the observer must NOT pre-filter by relevance, only supply the attributes.
- Emission rule for the U4 observer: per changed **descendant node** (not region root), typed records, each burst terminated by one `SUBTREE_UPDATE_END`.
- Timing/dedupe the fork already owns (don't duplicate): 5000ms `LIVE_REGION_QUEUE_TIME_MS` window (L53), 20ms same-node throttle (L58), `liveRegionNodeSet_` WeakSet recursive dedupe (L243–253), `containerLiveBusy` skip (L179), `liveAtomic` walk-up (L183–185), `@live_regions_removed` for removals (L145).

## 2. Suppression & flush topology (the anti-"delivered but silent" contract)

`shouldIgnoreLiveRegion_` (L255–281), in order:
1. static `announceLiveRegionsFromBackgroundTabs_` flag (false; private — not a seam).
2. **`ChromeVoxRange.current.start.node.root === node.root` → NOT ignored (L260–263).** Maintaining `ChromeVoxRange.current` inside the active tab's tree is *sufficient* to defeat suppression for that tab. The announcer owns this.
3. Fallback: `hostView = getTopLevelRoot(node).parent` — **null on a bare per-tab tree → ignored.** The synthetic ancestor (below) rescues non-current tabs.

Flush semantics (`outputLiveRegionChangeForNode_`, L200–224): `forceQueue = !hostView || !hostView.state['focused'] || currentRange.root !== node.root || status==='polite'` — without a focused synthetic ancestor everything is `QueueMode.QUEUE`, never `CATEGORY_FLUSH`. QueueMode is additionally time-multiplexed by the 5s window, so **politeness is NOT recoverable from QueueMode** (plan KTD4): politeness rides the observer metadata; QueueMode only informs the `interrupt` hint.

**Synthetic topology the shim presents:** a synthetic `desktop` root (also serves `chrome.automation.getDesktop`) → per-tab synthetic `window` node (`role: window`, `state.focused` true for the active tab, not INVISIBLE) → the tab's real AX page root. `getTopLevelRoot(node).parent` then resolves to the synthetic window.

## 3. Module closure: 89 modules → bundle vs stub

Closure: 69 `chromevox/mv3` + 20 `common/` modules. Full lists reproducible via the walk in this spec's Method. Cut set:

**Tier A — bundle unmodified (the brain):** `background/live_regions.ts`; `background/output/` (all 11: output, output_rules, output_formatter, output_format_parser, output_format_tree, output_ancestry_info, output_role_info, output_interface, output_logger, output_types, braille_output — braille_output stays, its braille deps are stubbed below it); `background/chromevox_range.ts`, `background/chromevox_state.ts`, `background/chromevox.ts` (the static tts/braille/earcons holder — our injection point), `background/focus_bounds.ts`; `background/editing/editable_line.ts` (+ its editing chain if the build pulls it cleanly); `mv3/common/`: tts_types, msgs, locale_output_helper, spannable, role_type, log_types, custom_automation_event, earcon_id, command, event_source_type, internal_key_event, tree_dumper; `common/` (vendored): automation_predicate, automation_util, tree_walker, constants, cursors/{cursor,range,recovery_strategy}, string_util, word_utils, paragraph_utils, async_util, settings, event_generator, key_code, extension_util, testing/test_import_manager.

**Tier B — stub by esbuild alias (the platform leaves):**

| Seam | Modules aliased | Stub behavior |
|---|---|---|
| TTS → sink | abstract_tts, primary_tts, tts_background, console_tts, composite_tts, tts_interface | our `tts_sink` implements the TtsInterface `speak(text, queueMode, properties)`; emits announcement records |
| Braille | braille/{braille_command_handler, braille_interface, braille_translator, liblouis, spans}, braille_command_data, braille_key_types, nav_braille | no-op |
| Panel/offscreen | panel_bridge, panel_command, panel_menu_data, offscreen_bridge(+constants) | no-op |
| Bridge plumbing | bridge_helper, bridge_callback_manager, bridge_constants | no-op |
| Settings/storage | settings_manager, local_storage, prefs | static `normal`-profile object |
| Logging | logging/{event_stream_logger, log_store, log_url_watcher} | no-op |
| Msgs formatter | `/chromevox/mv3/third_party/messageformat/messageformat.rollup.js` (a Chromium **build artifact**, absent from every source subtree) | thin adapter over npm `@messageformat/core` (MIT — the same library Chromium rolls up) |
| Phonetics | phonetic_data.js (+ its generated `../phonetic_dictionaries.js`), tamachiyomi/ja_phonetic_data | empty dictionaries |
| Misc | math_handler, abstract_earcons/earcons, event/{base_automation_handler, desktop_automation_interface}, input/command_handler_interface, event_source | no-op / inert holders |

**Resolution rule for U2:** bundle Tier A; alias Tier B; any remaining unresolved import gets case-by-case triage *within these seams*. **Stop condition** (plan Goal Capsule): a module that requires a NEW privileged surface not covered by this table.

## 4. chrome.automation API surface the shim provides

Runtime functions (4): `addTreeChangeObserver(filter, cb)` (§1); `getFocus(cb)` → focused node in active tab; `getDesktop(cb)` → synthetic desktop root (§2); `setDocumentSelection(...)` (from cursors/range select paths) → no-op with debug log in phase 1.
Runtime enum-value objects (used as values, not just types): `EventType`, `RoleType`, `StateType`, `TreeChangeType`, `TreeChangeObserverFilter`, `ActionType`, `NameFromType`, `Restriction`, `DefaultActionVerb`, `HasPopup`, `InvalidState`, `MarkerType`, `SortDirectionType`, `AriaCurrentState` — provided as a `chrome.automation` value shim module (values mirror Chromium's string enums).

## 5. AutomationNode member surface

100 distinct members accessed across the closure (grep enumeration; counts = file spread). **Core set (accessed in ≥3 files or by Tier-A hot paths):** role, parent, root, state, children, firstChild, lastChild, nextSibling, previousSibling, value, location, checked, description, restriction, display, docUrl, url, nextOnLine, wordStarts/wordEnds, textSelStart/textSelEnd (dark on canvas — known), unclippedLocation, indexInParent, nameFrom, roleDescription, inputType, detectedLanguage, activeDescendant(For), containerLive{Status,Relevant,Busy,Atomic}, liveAtomic, tableCell{Row,Column}Index, tableCell{Row,Column}Headers, ariaCell{Row,Column}IndexText, posInSet, setSize, selected, hasPopup, modal, hierarchicalLevel, invalidState, placeholder, tooltip, autoComplete, accessKey, customActions, standardActions, defaultActionVerb, doDefaultLabel, longClickLabel, clickable, htmlTag, language, markers, matches, addEventListener/removeEventListener (event subscription on nodes — no-op acceptable phase 1), querySelectorAll (no-op/`queryAXTree` bridge), boundsForRange (editing; may no-op), font/style members (bold, italic, underline, fontSize, fontFamily, color, lineThrough, sub/superscript — editing/rich-text paths; low priority), selectionStart/EndObject+Offset, nextWindowFocus/previousWindowFocus (synthetic-topology aware), sortDirection, mathContent (stubbed with math_handler), isButton/isComboBox/isCheckBox/isImage (predicate helpers on the node in newer API — implement from role).
CDP mapping: role/name/value/description/states/properties from `AXNode`; `location`/`unclippedLocation` via `backendDOMNodeId` box model; tree links from `childIds`/`parentId` wrappers; live-region attrs from AXNode properties (`live`, `atomic`, `relevant`, `busy` → containerLive* per ancestor walk); textSel* undefined on canvas (per plan).

## 6. Announcement record shape (sink output → bridge)

`{text, politeness, category, interrupt, tab, region, ts}` — `politeness` correlated from U4 observer metadata (NOT QueueMode); `interrupt` = QueueMode==CATEGORY_FLUSH hint; `tab` = source tabId; `region` = stable region identity for coalescing (additive roles exempt per R5).

## 7. Stop-condition assessment

None triggered. Every closure module lands in a Tier; every external touchpoint has a seam; the two non-source imports (messageformat rollup, phonetic dictionaries) are build artifacts with clean replacements. The heaviest residual risk is Tier-A drag from `editing/*` via chromevox_range/editable_line — bounded by the Tier-B `event/` + `input/` stubs and triaged mechanically in U2.
