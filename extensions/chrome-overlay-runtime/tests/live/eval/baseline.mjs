// EVAL-U4: per-trial baseline reset. Restores the sandbox Doc to the pristine fixture
// text before each task so a trial's expected result is deterministic.
//
// Reset mechanism (deferred-question resolution): the reset is HARNESS infrastructure,
// not an agent capability, so it does NOT go through the agent's site-action map (there
// is deliberately no whole-document `docs.set_all` map action to keep the agent's
// surface minimal). Instead the harness drives it directly over its own CDP page
// session: select-all (Ctrl+A) then insert the baseline text via CDP Input, on the same
// doc id every trial (no per-trial doc proliferation, deterministic regardless of the
// previous trial's end state). `cdp` is the harness's bound {press, insertText, readText}
// helpers over the Doc page target.
import { BASELINE_PARAGRAPHS } from '../fixtures/docs-edit-tasks.mjs';

export const BASELINE_TEXT = BASELINE_PARAGRAPHS.join('\n');

/**
 * Reset the Doc to the pristine baseline over CDP.
 * @param {object} cdp - harness CDP helpers bound to the Doc page:
 *   { pressChord(keys), insertText(text), readText():Promise<string>, sleep(ms) }.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function resetBaseline(cdp) {
  const sleep = cdp.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    // Seat the caret in the canvas, select the whole doc, and overwrite it. CDP
    // Input.insertText delivers a trusted paste-like insertion Docs accepts.
    await cdp.pressChord('Control+a');
    await sleep(150);
    await cdp.insertText(BASELINE_TEXT);
    await sleep(1200); // canvas repaints async; settle before scoring/next trial
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `baseline reset failed: ${String(e && e.message || e)}` };
  }
}

/**
 * Verify the doc currently matches the pristine baseline (used to confirm a reset
 * actually landed before starting a trial — a reset that silently no-ops would score
 * every task against stale text).
 */
export function isPristine(docText) {
  const text = Array.isArray(docText) ? docText.join('\n') : String(docText);
  // Anchor on a few distinctive baseline substrings rather than exact equality
  // (Docs may normalize trailing whitespace / paragraph marks on read-back).
  return text.includes('Project Wildflower: Field Notes')
    && text.includes('recieve a weekly digest')
    && text.includes('About 50% of submissions');
}
