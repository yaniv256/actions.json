import assert from "node:assert/strict";
import test from "node:test";
import {
  listSiteStorageFilesFromBundle,
  listSiteActionsFromBundle,
  resolveSiteActionFromBundle,
  readSiteStorageFileFromBundle,
  siteBlockedPrimitiveNamesFromBundle,
} from "../src/agent/local-actions-catalog.mjs";

const bundle = {
  protocol: "actions.json.storage.bundle",
  entries: [
    {
      path: "scopes/shared/pragmaworks/sites/pragmaworks.dev/home/actions.json",
      content: JSON.stringify({
        protocol: "actions.json",
        x_actions: {
          files: [
            {
              id: "pragmaworks-skill",
              path: "SKILL.md",
              kind: "skill",
              description: "How to host the PragmaWorks website.",
              read_when: "Read before acting as the PragmaWorks website host.",
            },
          ],
        },
        requires: {
          primitive_dictionary: {
            blocked_primitives: ["browser.run_javascript", "debug.run_javascript"],
          },
        },
        state_projections: [
          {
            name: "pragmaworks.cards",
            snapshot: {
              version: 1,
              source: "dom",
              extract: [],
              projection: {
                language: "jsonata",
                expression: "{% {'cards': []} %}",
              },
            },
            postconditions: {
              "pragmaworks.card.by_title.open": {
                projection: "pragmaworks.cards",
                verify: {
                  language: "jsonata",
                  expression: "{% true %}",
                },
              },
            },
          },
        ],
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
          {
            name: "pragmaworks.card.by_title.candidates",
            description: "Resolve card candidates by title.",
            input_schema: { type: "object" },
            x_actions: {
              handler: "locator.element_info",
              binding: {
                target_url_contains: "pragmaworks.dev",
                arguments: {
                  locator: {
                    selector: "[data-testid='card-name']",
                  },
                },
              },
            },
          },
          {
            name: "pragmaworks.card.by_title.open",
            description: "Resolve a card by title and click its center.",
            input_schema: { type: "object" },
            workflow: {
              version: 1,
              expression_language: "jsonata",
              steps: [
                {
                  id: "findCard",
                  primitive: "locator.element_info",
                  args: {
                    locator: {
                      selector: "[data-testid='card-name']",
                      text_contains: "{% input.title %}",
                    },
                  },
                },
                {
                  id: "clickCard",
                  primitive: "pointer.click",
                  args: {
                    x: "{% steps.findCard.output.clickable_center.x %}",
                    y: "{% steps.findCard.output.clickable_center.y %}",
                  },
                },
              ],
            },
          },
        ],
      }),
    },
    {
      path: "scopes/shared/pragmaworks/sites/pragmaworks.dev/home/SKILL.md",
      content: [
        "---",
        "name: pragmaworks-host",
        "description: Host visitors through Juan's AI engineering methodology.",
        "version: 0.1.0",
        "read_when: Read before introducing the site or answering questions about the methodology.",
        "---",
        "",
        "# PragmaWorks Host Skill",
        "",
        "Ask what engineering friction brought the visitor here.",
      ].join("\n"),
    },
  ],
};

test("local actions catalog lists current-site actions from a shared storage bundle", () => {
  const actions = listSiteActionsFromBundle(bundle, "https://pragmaworks.dev/");
  assert.deepEqual(
    actions.map((action) => action.name),
    [
      "pragmaworks.site.map",
      "pragmaworks.sections.list",
      "pragmaworks.card.by_title.candidates",
      "pragmaworks.card.by_title.open",
    ],
  );
  assert.equal(actions[1].target_url_contains, "pragmaworks.dev");
});

test("local actions catalog resolves workflow-backed stored actions", () => {
  const result = resolveSiteActionFromBundle(bundle, "https://pragmaworks.dev/", {
    action: "pragmaworks.card.by_title.open",
    arguments: { title: "Demo card" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.workflow.action_name, "pragmaworks.card.by_title.open");
  assert.deepEqual(result.workflow.input, { title: "Demo card" });
  assert.equal(result.workflow.definition.expression_language, "jsonata");
  assert.equal(result.workflow.definition.steps[1].primitive, "pointer.click");
  assert.deepEqual(result.workflow.postcondition, {
    projection_name: "pragmaworks.cards",
    definition: {
      projection: "pragmaworks.cards",
      verify: {
        language: "jsonata",
        expression: "{% true %}",
      },
    },
  });
});

test("local actions catalog recursively merges caller arguments into primitive bindings", () => {
  assert.deepEqual(
    resolveSiteActionFromBundle(bundle, "https://pragmaworks.dev/", {
      action: "pragmaworks.card.by_title.candidates",
      arguments: {
        locator: {
          text_contains: "Get Trello control to be demo ready",
        },
      },
    }),
    {
      ok: true,
      resolved: {
        name: "locator.element_info",
        arguments: {
          locator: {
            selector: "[data-testid='card-name']",
            text_contains: "Get Trello control to be demo ready",
          },
        },
        target_url_contains: "pragmaworks.dev",
      },
    },
  );
});

test("local actions catalog lists declared storage files and skill front matter", () => {
  const catalog = listSiteStorageFilesFromBundle(bundle, "https://pragmaworks.dev/");

  assert.deepEqual(catalog.files, [
    {
      id: "pragmaworks-skill",
      path: "scopes/shared/pragmaworks/sites/pragmaworks.dev/home/SKILL.md",
      relative_path: "SKILL.md",
      kind: "skill",
      title: null,
      description: "How to host the PragmaWorks website.",
      read_when: "Read before acting as the PragmaWorks website host.",
      size_bytes: bundle.entries[1].content.length,
    },
  ]);
  assert.deepEqual(catalog.skills, [
    {
      id: "pragmaworks-skill",
      path: "scopes/shared/pragmaworks/sites/pragmaworks.dev/home/SKILL.md",
      relative_path: "SKILL.md",
      kind: "skill",
      description: "How to host the PragmaWorks website.",
      read_when: "Read before acting as the PragmaWorks website host.",
      front_matter: {
        name: "pragmaworks-host",
        description: "Host visitors through Juan's AI engineering methodology.",
        version: "0.1.0",
        read_when: "Read before introducing the site or answering questions about the methodology.",
      },
    },
  ]);
});

test("local actions catalog reads declared text files by id or path", () => {
  const byId = readSiteStorageFileFromBundle(bundle, "https://pragmaworks.dev/", {
    id: "pragmaworks-skill",
  });
  assert.equal(byId.ok, true);
  assert.equal(byId.value.kind, "skill");
  assert.equal(byId.value.path, "scopes/shared/pragmaworks/sites/pragmaworks.dev/home/SKILL.md");
  assert.equal(byId.value.front_matter.name, "pragmaworks-host");
  assert.match(byId.value.text, /PragmaWorks Host Skill/);

  const byPath = readSiteStorageFileFromBundle(bundle, "https://pragmaworks.dev/", {
    path: "scopes/shared/pragmaworks/sites/pragmaworks.dev/home/SKILL.md",
  });
  assert.equal(byPath.ok, true);
  assert.equal(byPath.value.path, byId.value.path);
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
