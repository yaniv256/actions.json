import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_LEDGER_FILE = "accepted-gaps.json";

export async function loadAcceptedGapLedger(siteFolder, ledgerPath = null) {
  const resolved = ledgerPath ? path.resolve(ledgerPath) : path.join(siteFolder, DEFAULT_LEDGER_FILE);
  const text = await fs.readFile(resolved, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (text == null) {
    return { path: resolved, accepted_gaps: [] };
  }
  try {
    const ledger = JSON.parse(text);
    return {
      path: resolved,
      accepted_gaps: Array.isArray(ledger?.accepted_gaps) ? ledger.accepted_gaps : [],
    };
  } catch (error) {
    throw new Error(`Invalid accepted-gap ledger ${resolved}: ${error.message}`);
  }
}

export function applyAcceptedGapLedger(findings, ledger = null) {
  const acceptedGaps = Array.isArray(ledger?.accepted_gaps) ? ledger.accepted_gaps : [];
  const byId = new Map(acceptedGaps.map((entry) => [entry.finding_id, entry]));
  const matched = new Set();
  const overlaid = findings.map((finding) => {
    const entry = byId.get(finding.id);
    if (!entry) return finding;
    matched.add(finding.id);
    return {
      ...finding,
      status: "accepted",
      accepted_gap: {
        rationale: entry.rationale || "",
        accepted_by: entry.accepted_by || null,
        accepted_at: entry.accepted_at || null,
      },
    };
  });
  const staleEntries = acceptedGaps
    .filter((entry) => !matched.has(entry.finding_id))
    .map((entry) => ({
      finding_id: entry.finding_id,
      rationale: entry.rationale || "",
      status: "stale",
    }));
  return { findings: overlaid, staleEntries };
}
