// Entry point of the a11y bundle: the ChromeVox policy core (the "brain"),
// bundled unmodified from third_party/chromevox with Tier-B platform seams
// stubbed (docs/a11y-shim-spec.md). The announcer (U5) drives LiveRegions via
// the TreeChange contract and receives utterances through the TTS sink seam.
export {LiveRegions} from '/chromevox/mv3/background/live_regions.js';
export {Output} from '/chromevox/mv3/background/output/output.js';
export {ChromeVoxRange} from '/chromevox/mv3/background/chromevox_range.js';
export {ChromeVox} from '/chromevox/mv3/background/chromevox.js';
export {QueueMode, TtsCategory} from '/chromevox/mv3/common/tts_types.js';
export {LocaleOutputHelper} from '/chromevox/mv3/common/locale_output_helper.js';
export {CursorRange} from '/common/cursors/range.js';
export {AutomationUtil} from '/common/automation_util.js';
export {AutomationPredicate} from '/common/automation_predicate.js';
