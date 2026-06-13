// Normalizes actions.site call-mode arguments from the shapes models actually
// send. The canonical contract is { mode: "call", action: "<site action>",
// arguments: {...} }, but hosted models reliably reach for the MCP tools/call
// convention ({ name: ... }) or nest the action inside arguments — and the old
// "requires arguments.action" error steered them INTO the nested shape.
// Recover the intent instead of failing three calls in a row.
//
// Returns { action, actionArguments } or null when no action name is present
// in any accepted position.
export function normalizeSiteActionCallArgs(args = {}) {
  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const rawArguments =
    source.arguments && typeof source.arguments === "object" && !Array.isArray(source.arguments)
      ? source.arguments
      : {};

  const topLevel = [source.action, source.action_name, source.name].find(
    (value) => typeof value === "string" && value,
  );

  if (topLevel) {
    let actionArguments = rawArguments;
    if (actionArguments.action === topLevel) {
      // The model duplicated the action name inside arguments; strip it so it
      // does not collide with the site action's own strict input schema.
      const { action: _duplicate, ...rest } = actionArguments;
      actionArguments = rest;
    }
    return { action: topLevel, actionArguments };
  }

  if (typeof rawArguments.action === "string" && rawArguments.action) {
    // Nested-only shape: lift the action name out and pass the rest through.
    const { action, ...rest } = rawArguments;
    return { action, actionArguments: rest };
  }

  return null;
}
