import { promises as fs } from "node:fs";
import path from "node:path";

import { emptySemanticAssessments, READINESS_TARGET, SEMANTIC_DIMENSIONS } from "./score-template.mjs";

const DEDUCTIONS = {
  high: 12,
  medium: 6,
  low: 2,
};

export async function readScoreInput(options = {}) {
  const auditReport = options.audit ? JSON.parse(await fs.readFile(path.resolve(options.audit), "utf8")) : null;
  const semantic = options.semantic ? JSON.parse(await fs.readFile(path.resolve(options.semantic), "utf8")) : null;
  return { auditReport, semantic };
}

export function runScore(context, { auditReport, semantic = null, before = null, after = null } = {}) {
  const findings = Array.isArray(auditReport?.findings) ? auditReport.findings : [];
  const openFindings = findings.filter((finding) => finding.status !== "accepted");
  const acceptedFindings = findings.filter((finding) => finding.status === "accepted");
  const mechanicalDeductions = openFindings.map((finding) => ({
    finding_id: finding.id,
    code: finding.code,
    severity: finding.severity,
    points: DEDUCTIONS[finding.severity] ?? DEDUCTIONS.low,
  }));
  const mechanicalScore = Math.max(
    0,
    100 - mechanicalDeductions.reduce((total, deduction) => total + deduction.points, 0),
  );
  const semanticAssessments = normalizeSemanticAssessments(semantic);
  const semanticComplete = semanticAssessments.every((assessment) => assessment.status === "complete");
  const finalScore = semanticComplete
    ? Math.round((mechanicalScore * 0.7) + (semanticScore(semanticAssessments) * 0.3))
    : null;

  return {
    ok: true,
    map_path: context.mapPath,
    site_folder: context.siteFolder,
    target_score: READINESS_TARGET,
    status: finalScore == null ? "incomplete" : finalScore >= READINESS_TARGET ? "ready" : "not_ready",
    mechanical: {
      score: mechanicalScore,
      deductions: mechanicalDeductions,
      accepted_gaps: acceptedFindings.map((finding) => ({
        finding_id: finding.id,
        code: finding.code,
        severity: finding.severity,
        rationale: finding.accepted_gap?.rationale || "",
      })),
    },
    semantic: {
      status: semanticComplete ? "complete" : "incomplete",
      assessments: semanticAssessments,
    },
    final_score: finalScore,
    before_after: beforeAfterDelta(before, after),
  };
}

function normalizeSemanticAssessments(semantic) {
  const byKey = new Map(
    Array.isArray(semantic?.assessments)
      ? semantic.assessments.map((assessment) => [assessment.key, assessment])
      : [],
  );
  return emptySemanticAssessments().map((placeholder) => {
    const assessment = byKey.get(placeholder.key);
    if (!assessment) return placeholder;
    const score = Number(assessment.score);
    const max = SEMANTIC_DIMENSIONS.find((dimension) => dimension.key === placeholder.key)?.max_points || 0;
    return {
      ...placeholder,
      status: Number.isFinite(score) ? "complete" : "incomplete",
      score: Number.isFinite(score) ? Math.max(0, Math.min(max, score)) : null,
      evidence: typeof assessment.evidence === "string" ? assessment.evidence : "",
    };
  });
}

function semanticScore(assessments) {
  const earned = assessments.reduce((total, assessment) => total + (assessment.score || 0), 0);
  const possible = assessments.reduce((total, assessment) => total + assessment.max_points, 0);
  return possible > 0 ? Math.round((earned / possible) * 100) : 0;
}

function beforeAfterDelta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return null;
  }
  return {
    before,
    after,
    delta: after - before,
  };
}
