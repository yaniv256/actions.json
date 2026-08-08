const ACTIONS_SITE_PARAMETERS = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: {
      type: "string",
      enum: ["list", "call", "state_read", "state_summary", "state_diff", "navigate", "search"],
      description: "List or call site actions, read mapped state, or navigate/search an active projection snapshot.",
    },
    action: {
      type: "string",
      description: "Site action name for call mode.",
    },
    arguments: {
      type: "object",
      additionalProperties: true,
    },
    target_runtime_id: {
      type: "string",
    },
    projection_name: {
      type: "string",
    },
    summary_name: {
      type: "string",
    },
    summary_arguments: {
      type: "object",
      additionalProperties: true,
    },
    max_bytes: {
      type: "integer",
      minimum: 256,
      maximum: 48000,
    },
    query: {
      type: "string",
      description: "List filter or search query.",
    },
    page_size: {
      type: "integer",
      minimum: 1,
      maximum: 5,
    },
    continuation: {
      type: "string",
    },
    snapshot_id: {
      type: "string",
      description: "Snapshot id for navigate/search.",
    },
    node_ref: {
      type: "string",
    },
    operation: {
      type: "string",
      enum: ["roots", "node", "neighbors", "traverse"],
    },
    direction: {
      type: "string",
      enum: ["outbound", "inbound"],
    },
    edge_types: {
      type: "array",
      items: { type: "string" },
    },
    max_depth: {
      type: "integer",
      minimum: 0,
    },
    measure_filter: {
      type: "object",
      additionalProperties: true,
    },
    measure_order: {
      type: "object",
      additionalProperties: true,
    },
    scope: {
      type: "object",
      additionalProperties: true,
    },
    cursor: {
      type: "string",
    },
    search_mode: {
      type: "string",
      enum: ["semantic", "lexical"],
    },
  },
  additionalProperties: false,
};

function realtimeFunctionTool({ name, description, parameters }) {
  return {
    type: "function",
    name,
    description,
    parameters,
  };
}

function primitiveToolDescription(primitive) {
  const base = primitive.summary || `Execute ${primitive.name}.`;
  const portability = primitive.portable ? "Portable action." : `${primitive.capability_class} action.`;
  return `${base} ${portability}`;
}

function primitiveSupportForHost(primitive, host) {
  if (typeof primitive.support === "string") {
    return primitive.support;
  }
  const adapter = primitive.adapters?.[host];
  return adapter?.support || "unsupported";
}

function primitiveHasHostMetadataShape(primitive) {
  return typeof primitive.support === "string";
}

function schemaForPrimitiveTool(primitive) {
  if (primitive.input_schema) {
    return primitive.input_schema;
  }
  if (primitiveHasHostMetadataShape(primitive)) {
    throw new Error(`Supported primitive ${primitive.name} is missing input_schema in packaged metadata`);
  }
  return { type: "object", additionalProperties: false };
}

const SITE_SUPPRESSIBLE_PRIMITIVE_TOOLS = new Set(["browser.run_javascript"]);

export function filterRealtimeToolsForBlockedPrimitives(tools, blockedPrimitives = []) {
  const blocked = new Set(
    blockedPrimitives.filter((primitiveName) => SITE_SUPPRESSIBLE_PRIMITIVE_TOOLS.has(primitiveName)),
  );
  if (blocked.size === 0) {
    return tools;
  }
  return tools.filter((tool) => !blocked.has(tool.name));
}

export function buildRealtimeToolCatalog({ dictionary, host = "extension", blockedPrimitives = [] }) {
  if (!dictionary || !Array.isArray(dictionary.primitives)) {
    throw new Error("buildRealtimeToolCatalog requires a primitive dictionary");
  }

  const tools = [
    realtimeFunctionTool({
      name: "actions.site",
      description: [
        "Use bounded actions.json capabilities for the current page.",
        "Call mode=list first; use navigate/search only with a snapshot_id returned by state_read.",
        "For mode=call, put the site action name in the 'action' parameter and its inputs in 'arguments', for example {\"mode\": \"call\", \"action\": \"site.do.thing\", \"arguments\": {}}.",
        "snapshot_required means run state_read; stale or invalid snapshot/cursor errors require a fresh state_read.",
      ].join(" "),
      parameters: ACTIONS_SITE_PARAMETERS,
    }),
  ];

  for (const primitive of dictionary.primitives) {
    const support = primitiveSupportForHost(primitive, host);
    const shouldAdvertise =
      support === "supported" ||
      (primitive.name === "browser.screenshot" && host === "embed");
    if (!shouldAdvertise) continue;

    tools.push(
      realtimeFunctionTool({
        name: primitive.name,
        description: primitiveToolDescription(primitive),
        parameters: schemaForPrimitiveTool(primitive),
      }),
    );
  }

  return filterRealtimeToolsForBlockedPrimitives(tools, blockedPrimitives);
}
