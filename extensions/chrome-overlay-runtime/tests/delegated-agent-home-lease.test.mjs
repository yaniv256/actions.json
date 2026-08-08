import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyProposalState,
  deriveDiscoveryProposal,
  deriveHomeLease,
  senderMatchesLease,
} from "../src/delegated-agent/home-lease.mjs";

const manifestHref = "https://github.com/example/course-agent/blob/0123456789abcdef0123456789abcdef01234567/agent.json";
const sender = (overrides = {}) => ({
  tab: { id: 41, url: "https://course.example/chapter/one", ...overrides.tab },
  url: "https://course.example/chapter/one",
  origin: "https://course.example",
  frameId: 0,
  documentId: "document-one",
  ...overrides,
});

test("discovery derives repository identity and source authority only from a top-level Chrome sender", () => {
  const proposal = deriveDiscoveryProposal({ href: manifestHref }, sender());
  assert.deepEqual(proposal.repository, {
    owner: "example",
    repo: "course-agent",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    manifestPath: "agent.json",
  });
  assert.deepEqual(proposal.source, {
    tabId: 41,
    frameId: 0,
    documentId: "document-one",
    origin: "https://course.example",
    url: "https://course.example/chapter/one",
  });
  assert.equal(proposal.href, manifestHref);
});

test("discovery rejects iframe, missing document identity, sender-origin mismatch, and mutable GitHub refs", () => {
  assert.throws(() => deriveDiscoveryProposal({ href: manifestHref }, sender({ frameId: 1 })), /top-level/i);
  assert.throws(() => deriveDiscoveryProposal({ href: manifestHref }, sender({ documentId: null })), /document/i);
  assert.throws(
    () => deriveDiscoveryProposal({ href: manifestHref }, sender({ origin: "https://other.example" })),
    /origin/i,
  );
  assert.throws(
    () => deriveDiscoveryProposal({ href: manifestHref.replace(/0123456789abcdef0123456789abcdef01234567/, "main") }, sender()),
    /commit|blob/i,
  );
});

test("home leases are top-level, nonce-bound, and use the browser-authenticated document", () => {
  const lease = deriveHomeLease(sender(), {
    portNonce: "nonce-one",
    leasedAt: "2026-07-15T12:00:00.000Z",
  });
  assert.deepEqual(lease, {
    schemaVersion: 1,
    tabId: 41,
    frameId: 0,
    documentId: "document-one",
    origin: "https://course.example",
    portNonce: "nonce-one",
    leasedAt: "2026-07-15T12:00:00.000Z",
  });
  assert.equal(senderMatchesLease(sender(), lease), true);
  assert.equal(senderMatchesLease(sender({ documentId: "stale-document" }), lease), false);
  assert.equal(senderMatchesLease(sender({ origin: "https://other.example" }), lease), false);
  assert.equal(senderMatchesLease(sender({ tab: { id: 42 } }), lease), false);
});

test("BFCache lifecycle messages may change frame number but never document, tab, or origin identity", () => {
  const lease = deriveHomeLease(sender(), {
    portNonce: "nonce-one",
    leasedAt: "2026-07-15T12:00:00.000Z",
  });
  assert.equal(senderMatchesLease(sender({ frameId: 7 }), lease), false);
  assert.equal(senderMatchesLease(sender({ frameId: 7 }), lease, { lifecycle: true }), true);
  assert.equal(senderMatchesLease(sender({ frameId: 7, documentId: "other" }), lease, { lifecycle: true }), false);
});

test("proposal states distinguish unapproved, dormant, live, changed bundle, and invalid", () => {
  const proposal = deriveDiscoveryProposal({ href: manifestHref }, sender());
  const approval = {
    sourceOrigin: proposal.source.origin,
    githubOwner: proposal.repository.owner,
    githubRepo: proposal.repository.repo,
    commitSha: proposal.repository.commitSha,
    manifestPath: proposal.repository.manifestPath,
    revokedAt: null,
  };
  assert.equal(classifyProposalState({ proposal }), "unapproved");
  assert.equal(classifyProposalState({ proposal, approval }), "approved-dormant");
  assert.equal(classifyProposalState({ proposal, approval, group: { status: "live", home: { documentId: "document-one" } } }), "live");
  assert.equal(classifyProposalState({ proposal, approval: { ...approval, commitSha: "f".repeat(40) } }), "changed-bundle");
  assert.equal(classifyProposalState({ proposal: { valid: false } }), "invalid");
  assert.equal(classifyProposalState({ proposal, approval: { ...approval, revokedAt: "2026-07-15T13:00:00.000Z" } }), "unapproved");
});
