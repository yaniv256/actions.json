import {
  canonicalizeDelegatedOrigin,
  parseCanonicalGitHubBlobUrl,
} from "./delegated-policy.mjs";

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

const senderAuthority = (sender, { requireTopLevel = true } = {}) => {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError("Chrome sender tab identity is required");
  if (requireTopLevel && sender?.frameId !== 0) throw new TypeError("Discovery requires a top-level frame");
  if (!Number.isInteger(sender?.frameId) || sender.frameId < 0) throw new TypeError("Chrome sender frame identity is required");
  if (!isNonEmptyString(sender?.documentId)) throw new TypeError("Chrome sender document identity is required");
  if (!isNonEmptyString(sender?.url)) throw new TypeError("Chrome sender URL is required");
  let url;
  try {
    url = new URL(sender.url);
  } catch {
    throw new TypeError("Chrome sender URL is invalid");
  }
  const origin = canonicalizeDelegatedOrigin(url.origin, { allowLocalhost: true });
  if (sender.origin !== undefined && sender.origin !== origin) {
    throw new TypeError("Chrome sender origin does not match its URL");
  }
  if (isNonEmptyString(sender.tab.url) && new URL(sender.tab.url).origin !== origin) {
    throw new TypeError("Chrome sender tab origin does not match its document URL");
  }
  return { tabId, frameId: sender.frameId, documentId: sender.documentId, origin, url: url.href };
};

const proposalIdentity = ({ source, repository }) => [
  source.origin,
  repository.owner,
  repository.repo,
  repository.commitSha,
  repository.manifestPath,
].map((value) => `${value.length}:${value}`).join("|");

export function deriveDiscoveryProposal(message, sender) {
  if (!isNonEmptyString(message?.href)) throw new TypeError("Discovery link href is required");
  const source = senderAuthority(sender);
  const parsed = parseCanonicalGitHubBlobUrl(message.href);
  const repository = {
    owner: parsed.owner,
    repo: parsed.repo,
    commitSha: parsed.commitSha,
    manifestPath: parsed.manifestPath,
  };
  const proposal = {
    schemaVersion: 1,
    valid: true,
    href: message.href,
    source,
    repository,
  };
  return { ...proposal, proposalId: proposalIdentity(proposal) };
}

export function deriveHomeLease(sender, { portNonce, leasedAt = new Date().toISOString() } = {}) {
  const source = senderAuthority(sender);
  if (!isNonEmptyString(portNonce)) throw new TypeError("Home lease port nonce is required");
  if (!isNonEmptyString(leasedAt) || !Number.isFinite(Date.parse(leasedAt))) {
    throw new TypeError("Home lease timestamp is invalid");
  }
  return {
    schemaVersion: 1,
    tabId: source.tabId,
    frameId: 0,
    documentId: source.documentId,
    origin: source.origin,
    portNonce,
    leasedAt,
  };
}

export function senderMatchesLease(sender, lease, { lifecycle = false } = {}) {
  try {
    const source = senderAuthority(sender, { requireTopLevel: !lifecycle });
    return lease?.schemaVersion === 1
      && source.tabId === lease.tabId
      && source.documentId === lease.documentId
      && source.origin === lease.origin
      && (lifecycle || source.frameId === lease.frameId);
  } catch {
    return false;
  }
}

const approvalMatchesProposal = (approval, proposal) => approval
  && approval.revokedAt === null
  && approval.sourceOrigin === proposal.source.origin
  && approval.githubOwner === proposal.repository.owner
  && approval.githubRepo === proposal.repository.repo
  && approval.commitSha === proposal.repository.commitSha
  && approval.manifestPath === proposal.repository.manifestPath;

export function classifyProposalState({ proposal, approval = null, group = null } = {}) {
  if (!proposal?.valid) return "invalid";
  if (approval?.revokedAt !== null && approval?.revokedAt !== undefined) return "unapproved";
  if (!approval) return "unapproved";
  if (!approvalMatchesProposal(approval, proposal)) return "changed-bundle";
  if (group?.status === "live" && group?.home?.documentId === proposal.source.documentId) return "live";
  return "approved-dormant";
}
