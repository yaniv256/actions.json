export function describePrimitiveCapability(dictionary, { primitive, host, context = {} } = {}) {
  if (primitive === "runtime.transport.bridge" && host === "bookmarklet") {
    return describeBookmarkletTransport({ context });
  }

  const entry = dictionary?.primitives?.find((item) => item.name === primitive);
  if (!entry) {
    return {
      primitive,
      host,
      support: "unsupported",
      reason: "primitive_not_found",
      capability_class: null,
      portable: false,
    };
  }

  const adapter = entry.adapters?.[host];
  return {
    primitive,
    host,
    support: adapter?.support ?? "unsupported",
    reason: adapter?.reason ?? null,
    capability_class: entry.capability_class,
    portable: entry.portable,
  };
}

function describeBookmarkletTransport({ context }) {
  const bridgeAllowed = context.bridgeAllowedByPagePolicy !== false;
  return {
    primitive: "runtime.transport.bridge",
    host: "bookmarklet",
    support: bridgeAllowed ? "supported" : "unsupported",
    reason: bridgeAllowed ? null : "transport_unavailable",
    capability_class: "transport",
    portable: false,
    transport: context.transport || "websocket",
    bridge_url: context.bridgeUrl || null,
  };
}
