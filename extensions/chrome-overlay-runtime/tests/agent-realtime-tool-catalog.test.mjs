import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadPrimitiveDictionary } from "../../../runtime/actions-json-runtime/src/primitives/dictionary-loader.mjs";
import {
  buildRealtimeToolCatalog,
  filterRealtimeToolsForBlockedPrimitives,
} from "../src/agent/realtime-tool-catalog.mjs";

test("realtime tool catalog exposes stable actions.site and browser.screenshot tools", async () => {
  const dictionary = await loadPrimitiveDictionary();
  const tools = buildRealtimeToolCatalog({ dictionary, host: "extension" });
  const names = tools.map((tool) => tool.name);

  assert.equal(names.includes("actions.site"), true);
  assert.equal(names.includes("browser.screenshot"), true);
  assert.equal(names.filter((name) => name.includes("amazon") || name.includes("linkedin")).length, 0);

  const actionsSite = tools.find((tool) => tool.name === "actions.site");
  assert.equal(actionsSite.type, "function");
  assert.match(actionsSite.description, /current website/);
  assert.deepEqual(actionsSite.parameters.properties.mode.enum, ["list", "call", "state_read", "state_summary", "state_diff"]);
  assert.equal(actionsSite.parameters.properties.action.type, "string");
  assert.equal(actionsSite.parameters.properties.projection_name.type, "string");
  assert.equal(actionsSite.parameters.properties.summary_name.type, "string");
  assert.equal(actionsSite.parameters.properties.action_name, undefined);

  const screenshot = tools.find((tool) => tool.name === "browser.screenshot");
  assert.equal(screenshot.type, "function");
  assert.equal(screenshot.parameters.properties.format.enum.includes("png"), true);
});

test("realtime tool catalog includes supported stage 1 primitives without unsupported host tools", async () => {
  const dictionary = await loadPrimitiveDictionary();
  const extensionTools = buildRealtimeToolCatalog({ dictionary, host: "extension" });
  const embedTools = buildRealtimeToolCatalog({ dictionary, host: "embed" });

  assert.equal(extensionTools.some((tool) => tool.name === "pointer.click"), true);
  assert.equal(extensionTools.some((tool) => tool.name === "transfer.write"), true);
  assert.equal(extensionTools.some((tool) => tool.name === "transfer.insert"), true);
  assert.equal(extensionTools.some((tool) => tool.name === "storage.read_file"), true);
  assert.equal(extensionTools.some((tool) => tool.name === "clipboard.write"), false);
  assert.equal(extensionTools.some((tool) => tool.name === "clipboard.read"), false);
  assert.equal(extensionTools.some((tool) => tool.name === "runtime.session.name"), false);
  assert.equal(extensionTools.some((tool) => tool.name === "runtime.session.finalize_tabs"), false);
  assert.equal(embedTools.some((tool) => tool.name === "pointer.click"), true);
  assert.equal(embedTools.some((tool) => tool.name === "transfer.write"), false);
  assert.equal(embedTools.some((tool) => tool.name === "storage.read_file"), false);
  assert.equal(embedTools.some((tool) => tool.name === "runtime.session.name"), false);
  assert.equal(embedTools.some((tool) => tool.name === "browser.screenshot"), true);
});

test("realtime tool catalog reads the packaged extension primitive manifest", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"),
  );
  const tools = buildRealtimeToolCatalog({
    dictionary: manifest.primitive_dictionary,
    host: "extension",
  });
  const names = tools.map((tool) => tool.name);

  assert.equal(names.includes("actions.site"), true);
  assert.equal(names.includes("pointer.click"), true);
  assert.equal(names.includes("viewport.scroll"), true);
  assert.equal(names.includes("locator.element_info"), true);
  assert.equal(names.includes("browser.screenshot"), true);
  assert.equal(names.includes("overlay.open"), true);
  assert.equal(names.includes("overlay.register_launcher"), true);
  assert.equal(names.includes("overlay.close"), true);
  assert.equal(names.includes("transfer.write"), true);
  assert.equal(names.includes("transfer.read"), true);
  assert.equal(names.includes("transfer.clear"), true);
  assert.equal(names.includes("transfer.insert"), true);
  assert.equal(names.includes("storage.read_file"), true);

  const click = tools.find((tool) => tool.name === "pointer.click");
  assert.deepEqual(click.parameters.required, ["x", "y"]);
  assert.equal(click.parameters.properties.x.type, "number");
  assert.equal(click.parameters.properties.y.type, "number");

  const overlayOpen = tools.find((tool) => tool.name === "overlay.open");
  assert.equal(overlayOpen.parameters.required, undefined);
  assert.equal(overlayOpen.parameters.properties.html.type, "string");
  assert.equal(overlayOpen.parameters.properties.template.type, "object");
  assert.equal(overlayOpen.parameters.properties.template.properties.scope.type, "string");
  assert.equal(overlayOpen.parameters.properties.template.properties.path.type, "string");
  assert.equal(overlayOpen.parameters.properties.data.type, "object");

  const transferWrite = tools.find((tool) => tool.name === "transfer.write");
  assert.deepEqual(transferWrite.parameters.required, ["label", "format", "value"]);
  assert.equal(transferWrite.parameters.properties.format.enum.includes("application/json"), true);

  const storageReadFile = tools.find((tool) => tool.name === "storage.read_file");
  assert.equal(storageReadFile.parameters.properties.path.type, "string");
  assert.equal(storageReadFile.parameters.properties.id.type, "string");
  assert.equal(storageReadFile.parameters.properties.max_bytes.type, "integer");
});

test("packaged extension supported primitives all carry model-usable metadata", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"),
  );
  const supported = manifest.primitive_dictionary.primitives.filter(
    (primitive) => primitive.support === "supported",
  );

  assert.ok(supported.length > 0);
  for (const primitive of supported) {
    assert.equal(typeof primitive.summary, "string", `${primitive.name} should include summary`);
    assert.ok(primitive.summary.trim(), `${primitive.name} should include non-empty summary`);
    assert.equal(
      typeof primitive.input_schema,
      "object",
      `${primitive.name} should include input_schema`,
    );
    assert.equal(
      primitive.input_schema.type,
      "object",
      `${primitive.name} input_schema should be an object schema`,
    );
  }
});

test("packaged extension does not advertise primitives that lack an action route", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"),
  );
  const staticToolNames = new Set((manifest.tools || []).map((tool) => tool.name));
  const dynamicContentRoutes = new Set([
    "browser.claimed_tabs.list",
    "browser.claimed_tabs.activate",
    "pointer.move",
    "pointer.double_click",
    "pointer.drag",
    "text.insert",
    "keyboard.press",
    "page.info",
    "dom.observe.visible",
    "dom.snapshot_text",
    "locator.text_content",
    "locator.wait_for",
    "transfer.write",
    "transfer.read",
    "transfer.clear",
    "transfer.insert",
    "storage.read_file",
    "overlay.menu.hide",
    "overlay.menu.show",
    "overlay.menu.collapse",
    "overlay.menu.expand",
    "overlay.menu.move",
    "task.add",
    "task.next",
    "task.complete",
    "task.list",
    "task.clear",
  ]);
  const unroutable = manifest.primitive_dictionary.primitives
    .filter((primitive) => primitive.support === "supported")
    .map((primitive) => primitive.name)
    .filter((name) => !staticToolNames.has(name) && !dynamicContentRoutes.has(name));

  assert.deepEqual(unroutable, []);
});

test("realtime tool catalog fails closed when packaged primitive metadata omits a schema", () => {
  const packagedDictionary = {
    primitives: [
      {
        name: "pointer.click",
        summary: "Click a point.",
        support: "supported",
        capability_class: "portable",
        portable: true,
      },
    ],
  };

  assert.throws(
    () => buildRealtimeToolCatalog({ dictionary: packagedDictionary, host: "extension" }),
    /Supported primitive pointer\.click is missing input_schema/,
  );
});

test("realtime tool catalog removes only browser.run_javascript for site JavaScript eval blocks", async () => {
  const dictionary = {
    primitives: [
      {
        name: "browser.run_javascript",
        summary: "Run page JavaScript.",
        input_schema: { type: "object" },
        adapters: { extension: { support: "supported" } },
      },
      {
        name: "debug.run_javascript",
        summary: "Run privileged debugger JavaScript.",
        input_schema: { type: "object" },
        adapters: { extension: { support: "supported" } },
      },
    ],
  };
  const tools = buildRealtimeToolCatalog({ dictionary, host: "extension" });
  assert.equal(tools.some((tool) => tool.name === "browser.run_javascript"), true);
  assert.equal(tools.some((tool) => tool.name === "debug.run_javascript"), true);

  const filtered = filterRealtimeToolsForBlockedPrimitives(tools, [
    "browser.run_javascript",
    "debug.run_javascript",
  ]);
  const names = filtered.map((tool) => tool.name);

  assert.equal(names.includes("browser.run_javascript"), false);
  assert.equal(names.includes("debug.run_javascript"), true);
});
