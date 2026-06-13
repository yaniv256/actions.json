const ACTIONS_SITE_PARAMETERS = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: {
      type: "string",
      enum: ["list", "call", "state_read", "state_summary", "state_diff"],
      description: "Use list to inspect current-site actions and state projections; use call to execute one named current-site action; use state_read/state_summary to read mapped logical state; use state_diff to compare with the last snapshot.",
    },
    action: {
      type: "string",
      description:
        "Required when mode is call. The site action name returned by actions.site list. Pass it in THIS parameter — there is no 'name' parameter, and it does not go inside 'arguments'.",
    },
    arguments: {
      type: "object",
      description: "Arguments for the named current-site action.",
      additionalProperties: true,
    },
    target_runtime_id: {
      type: "string",
      description: "Optional runtime id when the agent needs to target a specific authorized browser runtime.",
    },
    projection_name: {
      type: "string",
      description: "Required for state_read and state_summary. The state projection name returned by actions.site list.",
    },
    summary_name: {
      type: "string",
      description: "Optional for state_summary. The projection summary name returned by actions.site list.",
    },
    max_bytes: {
      type: "integer",
      minimum: 1,
      description: "Optional payload budget for state_read.",
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
        "List or call actions.json actions available for the current website.",
        "Do not assume site-specific actions are globally available; call mode=list for the active page first.",
        "For mode=call, put the site action name in the 'action' parameter and its inputs in 'arguments', for example {\"mode\": \"call\", \"action\": \"site.do.thing\", \"arguments\": {}}.",
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
