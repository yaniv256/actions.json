import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelevantStorageBundle,
  clearStorageBundle,
  formatStorageDiagnostics,
  importStorageSyncBundle,
  loadStorageBundle,
  parseStoragePath,
  relevantStorageProbePaths,
  selectedSiteFolderPrefix,
  saveStorageBundle,
  siteHostMatchesPage,
  STORAGE_KEY,
  writeTargetsForBundle,
} from "../src/storage-bundle.mjs";

test("matches storage site host to the current page host and www subdomains", () => {
  assert.equal(siteHostMatchesPage("amazon.com", "https://www.amazon.com/gp/video"), true);
  assert.equal(siteHostMatchesPage("linear.app", "https://linear.app/actionsjson/issue/ACT-10"), true);
  assert.equal(siteHostMatchesPage("amazon.com", "https://example.com"), false);
});

test("plans targeted storage probe paths for the current page host", () => {
  assert.deepEqual(relevantStorageProbePaths("https://www.amazon.com/gp/video"), {
    hosts: ["www.amazon.com", "amazon.com"],
    rootScopeSitePaths: [
      ["scopes", "private", "sites", "www.amazon.com"],
      ["scopes", "public", "sites", "www.amazon.com"],
      ["scopes", "private", "sites", "amazon.com"],
      ["scopes", "public", "sites", "amazon.com"],
    ],
    sharedScopesRoot: ["scopes", "shared"],
    selectedScopeSitePaths: [
      ["sites", "www.amazon.com"],
      ["sites", "amazon.com"],
    ],
  });
});

test("formats root-folder diagnostics for a page-relevant storage load", () => {
  const text = formatStorageDiagnostics({
    version: "0.1.3",
    storageKey: STORAGE_KEY,
    currentUrl: "https://www.amazon.com/gp/video/channel/example",
    selectedFolderName: "actions.json.storage",
    folderRead: {
      mode: "root",
      selectedSitePrefix: null,
      entriesRead: 9,
      probes: [
        { path: "scopes/private/sites/www.amazon.com", status: "missing" },
        { path: "scopes/public/sites/www.amazon.com", status: "missing" },
        { path: "scopes/private/sites/amazon.com", status: "found", fileCount: 9 },
        { path: "scopes/public/sites/amazon.com", status: "missing" },
        { path: "scopes/shared", status: "missing" },
        { path: "sites/www.amazon.com", status: "missing" },
        { path: "sites/amazon.com", status: "missing" },
      ],
      errors: [],
    },
    bundle: {
      fileCount: 9,
      pageHost: "www.amazon.com",
      rejected: [],
      files: {
        "scopes/private/sites/amazon.com/prime-video/actions.json": {},
      },
    },
  });

  assert.match(text, /Bookmarklet version: 0\.1\.3/);
  assert.match(text, /Current host: www\.amazon\.com/);
  assert.match(text, /Host candidates: www\.amazon\.com, amazon\.com/);
  assert.match(text, /Selected folder: actions\.json\.storage/);
  assert.equal(text.includes("Default scope:"), false);
  assert.match(text, /Probe log:/);
  assert.match(text, /FOUND\s+scopes\/private\/sites\/amazon\.com \(9 file\(s\)\)/);
  assert.match(text, /missing\s+scopes\/private\/sites\/www\.amazon\.com/);
  assert.match(text, /Stored bundle: 9 file\(s\)/);
  assert.match(text, /scopes\/private\/sites\/amazon\.com\/prime-video\/actions\.json/);
});

test("recognizes a selected current-site folder and assigns a scope prefix", () => {
  assert.equal(
    selectedSiteFolderPrefix("amazon.com", "https://www.amazon.com/gp/video", "private"),
    "scopes/private/sites/amazon.com",
  );
  assert.equal(
    selectedSiteFolderPrefix("amazon.com", "https://www.amazon.com/gp/video", "shared:team"),
    "scopes/shared/team/sites/amazon.com",
  );
  assert.equal(selectedSiteFolderPrefix("linear.app", "https://www.amazon.com/gp/video"), null);
});

test("parses canonical private, shared, and public scoped storage paths", () => {
  assert.deepEqual(
    parseStoragePath("actions.json.storage/scopes/private/sites/amazon.com/prime-video/actions.json"),
    {
      scope: "private",
      siteHost: "amazon.com",
      sitePath: "prime-video/actions.json",
      canonicalPath: "scopes/private/sites/amazon.com/prime-video/actions.json",
    },
  );

  assert.deepEqual(
    parseStoragePath(
      "actions.json.storage/scopes/shared/trusted-agents/sites/amazon.com/prime-video/overlays/watch.overlay.json",
    ),
    {
      scope: "shared:trusted-agents",
      siteHost: "amazon.com",
      sitePath: "prime-video/overlays/watch.overlay.json",
      canonicalPath:
        "scopes/shared/trusted-agents/sites/amazon.com/prime-video/overlays/watch.overlay.json",
    },
  );

  assert.deepEqual(
    parseStoragePath("scopes/public/sites/amazon.com/prime-video/actions.json"),
    {
      scope: "public",
      siteHost: "amazon.com",
      sitePath: "prime-video/actions.json",
      canonicalPath: "scopes/public/sites/amazon.com/prime-video/actions.json",
    },
  );
});

test("parses selected scope repositories and bare site folders", () => {
  assert.equal(
    parseStoragePath("actions.json.storage.private/sites/linear.app/workspace/actions.json")?.canonicalPath,
    "scopes/private/sites/linear.app/workspace/actions.json",
  );
  assert.equal(
    parseStoragePath("actions.json.storage.shared.team/sites/linear.app/workspace/actions.json")
      ?.canonicalPath,
    "scopes/shared/team/sites/linear.app/workspace/actions.json",
  );
  assert.equal(
    parseStoragePath("sites/linear.app/workspace/actions.json", { defaultScope: "public" })
      ?.canonicalPath,
    "scopes/public/sites/linear.app/workspace/actions.json",
  );
});

test("builds a page-relevant bundle across scopes and rejects unrelated sites", () => {
  const bundle = buildRelevantStorageBundle(
    [
      {
        path: "actions.json.storage/scopes/private/sites/amazon.com/prime-video/actions.json",
        text: "{\"name\":\"private amazon\"}",
      },
      {
        path: "actions.json.storage/scopes/shared/trusted-agents/sites/amazon.com/prime-video/actions.json",
        text: "{\"name\":\"shared amazon\"}",
      },
      {
        path: "actions.json.storage/scopes/public/sites/linear.app/workspace/actions.json",
        text: "{\"name\":\"linear\"}",
      },
    ],
    { currentUrl: "https://www.amazon.com/gp/video/storefront" },
  );

  assert.equal(bundle.fileCount, 2);
  assert.deepEqual(Object.keys(bundle.files).sort(), [
    "scopes/private/sites/amazon.com/prime-video/actions.json",
    "scopes/shared/trusted-agents/sites/amazon.com/prime-video/actions.json",
  ]);
  assert.deepEqual(bundle.rejected, [
    "actions.json.storage/scopes/public/sites/linear.app/workspace/actions.json",
  ]);
});

test("saves, loads, and clears the bundle from browser-style local storage", () => {
  const backing = new Map();
  const storage = {
    setItem(key, value) {
      backing.set(key, value);
    },
    getItem(key) {
      return backing.get(key) ?? null;
    },
    removeItem(key) {
      backing.delete(key);
    },
  };
  const bundle = buildRelevantStorageBundle(
    [
      {
        path: "scopes/private/sites/amazon.com/prime-video/actions.json",
        text: "{\"name\":\"amazon\"}",
      },
    ],
    { currentUrl: "https://www.amazon.com/" },
  );

  saveStorageBundle(storage, bundle);
  assert.equal(backing.has(STORAGE_KEY), true);
  assert.deepEqual(loadStorageBundle(storage), bundle);

  clearStorageBundle(storage);
  assert.equal(loadStorageBundle(storage), null);
});

test("imports an MCP storage sync bundle into browser-local page storage", () => {
  const backing = new Map();
  const storage = {
    setItem(key, value) {
      backing.set(key, value);
    },
    getItem(key) {
      return backing.get(key) ?? null;
    },
    removeItem(key) {
      backing.delete(key);
    },
  };

  const result = importStorageSyncBundle(storage, {
    bundle: {
      protocol: "actions.json.storage.bundle",
      version: 1,
      synced_at_ms: 12345,
      entries: [
        {
          path: "scopes/private/sites/amazon.com/prime-video/actions.json",
          content: "{\"name\":\"amazon\"}",
          content_type: "application/json",
          bytes: 17,
        },
        {
          path: "scopes/private/sites/linear.app/workspace/actions.json",
          content: "{\"name\":\"linear\"}",
          content_type: "application/json",
          bytes: 17,
        },
      ],
    },
    currentUrl: "https://www.amazon.com/gp/video/storefront",
  });

  assert.deepEqual(result, {
    ok: true,
    entry_count: 1,
    rejected_count: 1,
    synced_at_ms: 12345,
  });

  assert.deepEqual(Object.keys(loadStorageBundle(storage).files), [
    "scopes/private/sites/amazon.com/prime-video/actions.json",
  ]);
  assert.equal(
    loadStorageBundle(storage).files["scopes/private/sites/amazon.com/prime-video/actions.json"].text,
    "{\"name\":\"amazon\"}",
  );
});

test("rejects non-MCP storage sync bundles during import", () => {
  assert.throws(
    () =>
      importStorageSyncBundle(
        {
          setItem() {},
        },
        {
          bundle: { protocol: "actions.json.storage.browser-bundle", files: {} },
          currentUrl: "https://www.amazon.com/",
        },
      ),
    /requires an actions\.json\.storage\.bundle/,
  );
});

test("converts bundles into safe write targets", () => {
  const bundle = {
    files: {
      "scopes/private/sites/amazon.com/prime-video/actions.json": {
        text: "{\"name\":\"amazon\"}",
      },
    },
  };

  assert.deepEqual(writeTargetsForBundle(bundle), [
    {
      path: "scopes/private/sites/amazon.com/prime-video/actions.json",
      parts: ["scopes", "private", "sites", "amazon.com", "prime-video", "actions.json"],
      text: "{\"name\":\"amazon\"}",
    },
  ]);
});

test("rejects unsafe bundle write paths", () => {
  assert.throws(
    () =>
      writeTargetsForBundle({
        files: {
          "../outside.json": { text: "{}" },
        },
      }),
    /Unsafe storage path/,
  );
});
