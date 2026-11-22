import canonicalDictionary from "../primitives/dictionary.v1.json" with { type: "json" };

export { canonicalDictionary };
export { RealtimeAgentAdapter } from "./realtime-agent-adapter.mjs";
export {
  DurableReceiptStore,
  EmbedHost,
  PrimitiveRegistry,
  ReceiptLedger,
  authorityKey,
  effectiveHostRevision,
  requestDigest,
} from "./embed-host.mjs";

export {
  DOCUMENT_KIND,
  LAYER,
  REASON,
  REMEDIATION_FOR_REASON,
  resolveCapability,
  resolveCatalog,
} from "../primitives/capability-resolver.mjs";
