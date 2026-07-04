export const READINESS_TARGET = 95;

export const SEMANTIC_DIMENSIONS = [
  {
    key: "task_coverage",
    label: "Task coverage",
    prompt: "Does the map cover the durable user tasks it claims to support?",
    max_points: 20,
  },
  {
    key: "persona_guidance",
    label: "Persona guidance",
    prompt: "Does the site-local guidance tell an agent when and how to use the map?",
    max_points: 15,
  },
  {
    key: "proof_quality",
    label: "Proof quality",
    prompt: "Does the proof package link claims to concrete action logs, failures, fixes, and screenshots?",
    max_points: 20,
  },
  {
    key: "accepted_gap_reasonableness",
    label: "Accepted-gap reasonableness",
    prompt: "Are accepted gaps named, justified, bounded, and safe for the intended promotion scope?",
    max_points: 15,
  },
];

export function emptySemanticAssessments() {
  return SEMANTIC_DIMENSIONS.map((dimension) => ({
    ...dimension,
    status: "incomplete",
    score: null,
    evidence: "",
  }));
}
