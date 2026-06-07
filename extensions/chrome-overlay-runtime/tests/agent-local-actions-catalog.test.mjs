import assert from "node:assert/strict";
import test from "node:test";
import {
  listSiteActionsFromBundle,
  resolveSiteActionFromBundle,
  siteBlockedPrimitiveNamesFromBundle,
} from "../src/agent/local-actions-catalog.mjs";

const bundle = {
  protocol: "actions.json.storage.bundle",
  entries: [
    {
      path: "scopes/shared/pragmaworks/sites/pragmaworks.dev/home/actions.json",
      content: JSON.stringify({
        protocol: "actions.json",
        requires: {
          primitive_dictionary: {
            blocked_primitives: ["browser.run_javascript", "debug.run_javascript"],
          },
        },
        tools: [
          {
            name: "pragmaworks.site.map",
            description: "Return the site map.",
            input_schema: { type: "object" },
            x_actions: {
              static_output: { ok: true, site: "pragmaworks.dev" },
            },
          },
          {
            name: "pragmaworks.sections.list",
            description: "List visible sections.",
            input_schema: { type: "object" },
            x_actions: {
              handler: "dom.list_sections",
              binding: {
                target_url_contains: "pragmaworks.dev",
                arguments: { include_hidden: false },
              },
            },
          },
        ],
      }),
    },
  ],
};

test("local actions catalog lists current-site actions from a shared storage bundle", () => {
  const actions = listSiteActionsFromBundle(bundle, "https://pragmaworks.dev/");
  assert.deepEqual(
    actions.map((action) => action.name),
    ["pragmaworks.site.map", "pragmaworks.sections.list"],
  );
  assert.equal(actions[1].target_url_contains, "pragmaworks.dev");
});

test("local actions catalog reads site blocked primitive declarations", () => {
  assert.deepEqual(
    siteBlockedPrimitiveNamesFromBundle(bundle, "https://pragmaworks.dev/"),
    ["browser.run_javascript", "debug.run_javascript"],
  );
  assert.deepEqual(siteBlockedPrimitiveNamesFromBundle(bundle, "https://example.com/"), []);
});

test("local actions catalog resolves static and primitive-backed stored actions", () => {
  assert.deepEqual(
    resolveSiteActionFromBundle(bundle, "https://pragmaworks.dev/", {
      action: "pragmaworks.site.map",
      arguments: {},
    }),
    {
      ok: true,
      static_output: { ok: true, site: "pragmaworks.dev" },
    },
  );
  assert.deepEqual(
    resolveSiteActionFromBundle(bundle, "https://pragmaworks.dev/", {
      action: "pragmaworks.sections.list",
      arguments: { max_items: 10 },
    }),
    {
      ok: true,
      resolved: {
        name: "dom.list_sections",
        arguments: { include_hidden: false, max_items: 10 },
        target_url_contains: "pragmaworks.dev",
      },
    },
  );
});
