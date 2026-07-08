// EVAL-U4: pure exact-substring scorer for a Docs-editing trial. Ported from the
// goal-run check.py so the harness and the historical runs score identically.
//
// A task passes when every applicable assertion holds against the resulting doc text:
//   must            — all listed substrings present (unless must_any)
//   must_any        — only ONE of `must` needs to be present (variant acceptance)
//   must_not        — none of the listed substrings present
//   must_para_start — some paragraph starts with one of these (structural edits)
// Text is normalized first (smart quotes -> ascii, NBSP -> space) so a curly-quote
// edit isn't scored as a mismatch on a straight-quote assertion and vice versa.

// Normalize smart punctuation + non-breaking space to their plain forms.
export function normalize(s) {
  return String(s)
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ');
}

/**
 * Score one task against the resulting doc text.
 * @param {object} task - a fixture task ({ must, must_any, must_not, must_para_start }).
 * @param {string|string[]} docText - the resulting doc text: a string (paragraphs joined
 *   by "\n") or an array of paragraph strings.
 * @returns {{ pass: boolean, fails: string[] }}
 */
export function scoreTask(task, docText) {
  const paragraphs = Array.isArray(docText) ? docText.map(normalize) : normalize(docText).split('\n');
  const text = paragraphs.join('\n');
  const fails = [];

  const must = (task.must || []).map(normalize);
  if (must.length) {
    if (task.must_any) {
      if (!must.some((m) => text.includes(m))) fails.push(`none of the accepted variants present: ${JSON.stringify(must)}`);
    } else {
      for (const m of must) if (!text.includes(m)) fails.push(`missing: ${JSON.stringify(m)}`);
    }
  }

  for (const m of task.must_not || []) {
    if (text.includes(normalize(m))) fails.push(`still present: ${JSON.stringify(m)}`);
  }

  for (const p of task.must_para_start || []) {
    const needle = normalize(p);
    if (!paragraphs.some((l) => l.trim().startsWith(needle))) fails.push(`no paragraph starts with: ${JSON.stringify(p)}`);
  }

  return { pass: fails.length === 0, fails };
}

/**
 * A short neighborhood diff for a failure artifact: for each failing substring, show the
 * window of doc text around where it was expected (or the offending match for must_not),
 * so a failure can be root-caused without re-running.
 */
export function neighborhoodDiff(task, docText, radius = 40) {
  const text = (Array.isArray(docText) ? docText.map(normalize).join('\n') : normalize(docText));
  const notes = [];
  for (const m of (task.must || []).map(normalize)) {
    if (!text.includes(m)) {
      // Show where a near-prefix of the expected string lands, if anywhere.
      const probe = m.slice(0, Math.min(12, m.length));
      const at = text.indexOf(probe);
      notes.push(at >= 0
        ? `expected ${JSON.stringify(m)}; nearest ${JSON.stringify(probe)} at …${text.slice(Math.max(0, at - radius), at + probe.length + radius)}…`
        : `expected ${JSON.stringify(m)}; no anchor found`);
    }
  }
  for (const m of task.must_not || []) {
    const at = text.indexOf(normalize(m));
    if (at >= 0) notes.push(`unexpected ${JSON.stringify(m)} at …${text.slice(Math.max(0, at - radius), at + m.length + radius)}…`);
  }
  return notes;
}
