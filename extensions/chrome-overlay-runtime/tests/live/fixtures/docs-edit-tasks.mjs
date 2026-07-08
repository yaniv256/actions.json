// EVAL-U1: the durable Docs-editing task fixture for the hosted-agent eval harness.
//
// Promoted from the 95%-goal-run task set (actions.json.storage private eval:
// tasks.json + fixture.md, the "EDIT-EVAL sandbox" doc). These are the SAME 20
// human-phrased tasks the hosted agent was scored on at 20/20, kept here as the
// single source of truth so the harness (baseline reset, run, scoring) all agree.
//
// Assertion schema (richer than a single expected_text — an edit changes one span, so
// substring assertions are more precise and less brittle than a full-document match):
//   say            — the human-phrased prompt delivered to the agent (verbatim)
//   must           — substrings that MUST be present after a correct edit
//   must_any       — when true, only ONE of `must` needs to be present (accepts variants)
//   must_not       — substrings that MUST be absent after a correct edit
//   must_para_start — a paragraph must START with one of these (structural edits)
// A task passes when all present assertions hold (see scorer.mjs — U4).

// The pristine baseline document. baseline reset (U4) restores the doc to exactly this
// before each trial so a task's expected result is deterministic. One paragraph per
// entry; the harness joins with the Docs paragraph separator.
export const BASELINE_PARAGRAPHS = [
  "Project Wildflower: Field Notes",
  "Wildflower is our internal tool for tracking native plant surveys. Volunteers recieve a weekly digest with new sightings, and researchers use the map view to plan feild visits. The tool has been running for for three seasons now.",
  "Getting Started",
  "To join a survey, open the app and tap the green button. You will be asked to to pick a region. Most volunteers choose the region closest to home, but some prefer remote areas because they are less crowded. The onboarding takes about 15 minutes. Its worth doing carefully.",
  "The weather this spring was unusually wet, which delayed several surveys.",
  "Data Quality",
  "Every sighting needs a photo, a location, and a date. Sightings without photos are marked as unverified and dont count toward totals. About 50% of submissions pass review on the first try. The review team meets every Tuesday. They are the heart of the project, they catch nearly everything.",
  "Common mistakes include blurry photos, missing GPS tags, and duplicate entries. Duplicate entries are the most common mistake. The team flags them fast.",
  "Whats Next",
  "We plan to add offline mode next season. Volunteers in remote areas have asked for it, and its the top request in the feedback form. We also want to translate the app into Spanish. The board approved the budget last month.",
];

// All 20 tasks reference this one baseline (a single named seed — see the shape guard).
const BASELINE = "wildflower-field-notes";

export const DOCS_EDIT_TASKS = [
  { id: 1, baseline: BASELINE, prompt: "There's a typo in the first paragraph — 'recieve' should be 'receive'.", must: ["receive a weekly digest"], must_not: ["recieve"] },
  { id: 2, baseline: BASELINE, prompt: "Also 'feild' is misspelled somewhere in the intro, fix it.", must: ["field visits"], must_not: ["feild"] },
  { id: 3, baseline: BASELINE, prompt: "There's a doubled word 'for for' in the first paragraph, remove one.", must: ["running for three seasons"], must_not: ["for for"] },
  { id: 4, baseline: BASELINE, prompt: "In Getting Started there's a doubled 'to to' — fix it.", must: ["be asked to pick a region"], must_not: ["to to"] },
  { id: 5, baseline: BASELINE, prompt: "Near the end of Getting Started, 'Its worth doing carefully' needs an apostrophe in Its.", must: ["It's worth doing carefully", "It’s worth doing carefully"], must_any: true, must_not: ["Its worth doing"] },
  { id: 6, baseline: BASELINE, prompt: "Delete the sentence about the weather — the whole line about the wet spring.", must: [], must_not: ["unusually wet", "The weather this spring"] },
  { id: 7, baseline: BASELINE, prompt: "In Data Quality, 'dont' is missing its apostrophe.", must: ["don't count toward totals", "don’t count toward totals"], must_any: true, must_not: ["dont count"] },
  { id: 8, baseline: BASELINE, prompt: "Change 50% to 60% in the Data Quality section.", must: ["About 60% of submissions"], must_not: ["About 50%"] },
  { id: 9, baseline: BASELINE, prompt: "There's a comma splice: 'They are the heart of the project, they catch nearly everything.' Make it two sentences.", must: ["heart of the project. They catch nearly everything"], must_not: ["project, they catch"] },
  { id: 10, baseline: BASELINE, prompt: "The heading 'Whats Next' needs an apostrophe.", must: ["What's Next", "What’s Next"], must_any: true, must_not: ["Whats Next"] },
  { id: 11, baseline: BASELINE, prompt: "In the last paragraph, 'its the top request' should be \"it's\".", must: ["it's the top request", "it’s the top request"], must_any: true, must_not: ["and its the top request"] },
  { id: 12, baseline: BASELINE, prompt: "The duplicate-entries bit says the same thing twice — 'Duplicate entries are the most common mistake' repeats the sentence before it. Remove that repeated sentence.", must: ["duplicate entries. The team flags them fast"], must_not: ["Duplicate entries are the most common mistake."] },
  { id: 13, baseline: BASELINE, prompt: "Change 'tap the green button' to 'tap the Join button'.", must: ["tap the Join button"], must_not: ["green button"] },
  { id: 14, baseline: BASELINE, prompt: "Add a sentence at the very end of the document: 'Questions go to the project channel.'", must: ["Questions go to the project channel."] },
  { id: 15, baseline: BASELINE, prompt: "The onboarding time changed — make it 20 minutes instead of 15.", must: ["about 20 minutes"], must_not: ["about 15 minutes"] },
  { id: 16, baseline: BASELINE, prompt: "Rename the title line 'Project Wildflower: Field Notes' to 'Project Wildflower: Field Guide'.", must: ["Project Wildflower: Field Guide"], must_not: ["Field Notes"] },
  { id: 17, baseline: BASELINE, prompt: "In the first paragraph, call it 'our open-source tool' instead of 'our internal tool'.", must: ["our open-source tool"], must_not: ["our internal tool"] },
  { id: 18, baseline: BASELINE, prompt: "Split the Getting Started paragraph into two — start a new paragraph at 'The onboarding takes'.", must_para_start: ["The onboarding takes"] },
  { id: 19, baseline: BASELINE, prompt: "Spanish is now shipped — change 'We also want to translate the app into Spanish' to 'The app is now available in Spanish'.", must: ["The app is now available in Spanish"], must_not: ["want to translate the app"] },
  { id: 20, baseline: BASELINE, prompt: "Add 'and Portuguese' after 'Spanish' in that last paragraph.", must: ["Spanish and Portuguese"] },
];

// The one known baseline id every task references (guarded in the shape test).
export const KNOWN_BASELINES = new Set([BASELINE]);
