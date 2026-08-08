import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const schema = await import("../src/delegated-agent/bundle-schema.mjs").catch(() => ({}));
const fetcher = await import("../src/delegated-agent/github-bundle-fetcher.mjs").catch(() => ({}));
const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/delegated-agent-bundles/valid",
);
const commitSha = "0123456789abcdef0123456789abcdef01234567";
const treeSha = "89abcdef0123456789abcdef0123456789abcdef";
const manifestPath = "agent.json";
const manifestUrl = `https://github.com/example/agent-bundle/blob/${commitSha}/${manifestPath}`;
const fixturePaths = [
  "agent.json",
  "sites/tasks.example/actions.json",
  "sites/tasks.example/SKILL.md",
];

async function fixtureFiles() {
  return Promise.all(fixturePaths.map(async (filePath) => ({
    path: filePath,
    mode: "100644",
    type: "blob",
    bytes: new Uint8Array(await readFile(path.join(fixtureRoot, filePath))),
  })));
}

function gitBlobSha(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

async function validSnapshot(overrides = {}) {
  const files = await fixtureFiles();
  for (const file of files) {
    file.size = file.bytes.byteLength;
    file.blobSha = gitBlobSha(file.bytes);
  }
  return {
    proposal: { owner: "example", repo: "agent-bundle", commitSha, manifestPath },
    sourceOrigin: "https://course.example",
    resolvedCommitSha: commitSha,
    treeSha,
    files,
    ...overrides,
  };
}

function rewriteJsonFile(snapshot, filePath, mutate) {
  const file = snapshot.files.find((candidate) => candidate.path === filePath);
  const value = JSON.parse(new TextDecoder().decode(file.bytes));
  mutate(value);
  file.bytes = new TextEncoder().encode(JSON.stringify(value));
  file.size = file.bytes.byteLength;
  file.blobSha = gitBlobSha(file.bytes);
  return value;
}

test("R7-R13 bundle modules expose canonical validation and retrieval APIs", () => {
  assert.equal(typeof schema.canonicalStableSerialize, "function");
  assert.equal(typeof schema.validateDelegatedBundleSnapshot, "function");
  assert.equal(typeof schema.validateInputSchema, "function");
  assert.equal(typeof fetcher.fetchValidatedDelegatedBundle, "function");
  assert.equal(Object.isFrozen(schema.DELEGATED_BUNDLE_MANIFEST_SCHEMA.properties.agent), true);
});

test("R13 input schemas are recursively closed, bounded, and use only explicit keywords", { skip: !schema.validateInputSchema }, () => {
  const good = {
    type: "object",
    description: "Bounded business arguments.",
    properties: {
      title: { type: "string", maxLength: 200 },
      filters: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: { complete: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    },
    required: ["title"],
    additionalProperties: false,
  };
  assert.deepEqual(schema.validateInputSchema(good), []);

  let tooDeep = { type: "string", maxLength: 5 };
  for (let index = 0; index < 12; index += 1) {
    tooDeep = { type: "object", properties: { child: tooDeep }, additionalProperties: false };
  }
  const badSchemas = [
    [{ type: "object", properties: {}, additionalProperties: true }, "input_arbitrary_properties"],
    [{ type: "object", properties: { value: { type: "string" } }, additionalProperties: false }, "input_string_unbounded"],
    [{
      type: "object",
      properties: { values: { type: "array", items: { type: "boolean" } } },
      additionalProperties: false,
    }, "input_array_unbounded"],
    [{ type: "object", properties: {}, additionalProperties: false, $ref: "#/$defs/x" }, "input_schema_keyword_forbidden"],
    [{ type: "object", properties: {}, additionalProperties: false, anyOf: [] }, "input_schema_keyword_forbidden"],
    [tooDeep, "input_schema_too_deep"],
  ];
  for (const [bad, expectedCode] of badSchemas) {
    const problems = schema.validateInputSchema(bad);
    assert.equal(problems.some((problem) => problem.code === expectedCode), true, `${expectedCode}: ${JSON.stringify(problems)}`);
  }
});

test("R8 validates a complete fixture into a deterministic deeply immutable bundle", { skip: !schema.validateDelegatedBundleSnapshot }, async () => {
  const snapshot = await validSnapshot();
  const first = await schema.validateDelegatedBundleSnapshot(snapshot);
  const second = await schema.validateDelegatedBundleSnapshot({
    ...snapshot,
    files: [...snapshot.files].reverse(),
  });

  assert.equal(first.ok, true, JSON.stringify(first.problems));
  assert.equal(second.ok, true, JSON.stringify(second.problems));
  assert.equal(first.bundle.kind, "ValidatedDelegatedBundle");
  assert.equal(first.bundle.bundleDigest, second.bundle.bundleDigest);
  assert.equal(first.bundle.approvalId, second.bundle.approvalId);
  assert.equal(first.bundle.manifest.actions[0].timeout_ms, 60_000);
  assert.deepEqual(first.bundle.inventory.map((item) => item.path), [...fixturePaths].sort());
  assert.equal(Object.isFrozen(first.bundle), true);
  assert.equal(Object.isFrozen(first.bundle.manifest.agent), true);
  assert.throws(() => { first.bundle.manifest.agent.name = "Changed"; }, TypeError);
});

test("R10/R11/AE8 approval identity changes for source origin, commit, or canonical bundle bytes", { skip: !schema.validateDelegatedBundleSnapshot }, async () => {
  const baseSnapshot = await validSnapshot();
  const base = await schema.validateDelegatedBundleSnapshot(baseSnapshot);
  const otherSource = await schema.validateDelegatedBundleSnapshot({
    ...baseSnapshot,
    sourceOrigin: "https://other.example",
  });
  assert.equal(otherSource.ok, false);
  assert.equal(otherSource.problems.some((problem) => problem.code === "source_origin_not_declared"), true);

  const otherCommitSha = "1123456789abcdef0123456789abcdef01234567";
  const otherCommit = await schema.validateDelegatedBundleSnapshot({
    ...baseSnapshot,
    proposal: { ...baseSnapshot.proposal, commitSha: otherCommitSha },
    resolvedCommitSha: otherCommitSha,
  });
  assert.equal(otherCommit.ok, true, JSON.stringify(otherCommit.problems));
  assert.notEqual(base.bundle.approvalId, otherCommit.bundle.approvalId);

  const changed = structuredClone(baseSnapshot);
  const skill = changed.files.find((file) => file.path.endsWith("SKILL.md"));
  skill.bytes = new TextEncoder().encode(new TextDecoder().decode(skill.bytes) + "\nReview exact scopes.\n");
  skill.size = skill.bytes.byteLength;
  skill.blobSha = gitBlobSha(skill.bytes);
  const changedResult = await schema.validateDelegatedBundleSnapshot(changed);
  assert.equal(changedResult.ok, true, JSON.stringify(changedResult.problems));
  assert.notEqual(base.bundle.bundleDigest, changedResult.bundle.bundleDigest);
  assert.notEqual(base.bundle.approvalId, changedResult.bundle.approvalId);
});

test("R7-R13 returns every independently detectable manifest, map, schema, and package defect", { skip: !schema.validateDelegatedBundleSnapshot }, async () => {
  const snapshot = await validSnapshot();
  const manifestFile = snapshot.files.find((file) => file.path === manifestPath);
  const manifest = JSON.parse(new TextDecoder().decode(manifestFile.bytes));
  manifest.agent.id = "not an id";
  manifest.page_supplied_digest = "untrusted";
  manifest.agent.source_origins.push("https://*.example.com");
  manifest.targets[0].path_prefixes.push("/tasks/%2fadmin");
  manifest.actions[0].name = manifest.actions[1].name;
  manifest.actions[0].timeout_ms = 4999;
  manifest.actions[0].policy_exception = true;
  manifest.actions[1].effect = "write";
  manifest.skills[0].path = "../SKILL.md";
  manifestFile.bytes = new TextEncoder().encode(JSON.stringify(manifest));
  manifestFile.size = manifestFile.bytes.byteLength;
  manifestFile.blobSha = gitBlobSha(manifestFile.bytes);

  const mapFile = snapshot.files.find((file) => file.path.endsWith("actions.json") && file.path !== manifestPath);
  const map = JSON.parse(new TextDecoder().decode(mapFile.bytes));
  map.tools[1].output_schema.properties.history = {
    type: "array",
    items: { type: "string", maxLength: 20 },
  };
  map.tools[1].workflow.steps.push({ primitive: "browser.run_javascript", args: { script: "alert(1)" } });
  map.state_projections[0].postconditions = {};
  mapFile.bytes = new TextEncoder().encode(JSON.stringify(map));
  mapFile.size = mapFile.bytes.byteLength;
  mapFile.blobSha = gitBlobSha(mapFile.bytes);

  const result = await schema.validateDelegatedBundleSnapshot(snapshot);
  assert.equal(result.ok, false);
  const codes = new Set(result.problems.map((problem) => problem.code));
  for (const code of [
    "agent_id_invalid",
    "manifest_property_unknown",
    "source_origin_invalid",
    "target_path_invalid",
    "action_name_duplicate",
    "action_timeout_invalid",
    "action_property_unknown",
    "skill_path_invalid",
    "action_not_found",
    "output_array_unbounded",
    "write_postcondition_missing",
    "primitive_forbidden",
  ]) {
    assert.equal(codes.has(code), true, `${code}: ${[...codes].join(",")}`);
  }
});

test("R13 write postconditions require a declared readable projection and structured verifier", { skip: !schema.validateDelegatedBundleSnapshot }, async () => {
  const cases = [
    [
      (map) => { map.state_projections[0].postconditions["tasks.create"] = {}; },
      "write_postcondition_invalid",
    ],
    [
      (map) => { map.state_projections[0].postconditions["tasks.create"].projection = "missing.projection"; },
      "write_postcondition_projection_unknown",
    ],
    [
      (map) => { map.state_projections[0].postconditions["tasks.create"].verify = {}; },
      "write_postcondition_verifier_invalid",
    ],
    [
      (map) => {
        map.state_projections[0].postconditions["tasks.create"].verify = {
          primitive: "pointer.click",
          args: { x: 1, y: 1 },
        };
      },
      "write_postcondition_primitive_forbidden",
    ],
  ];
  for (const [mutate, expectedCode] of cases) {
    const snapshot = await validSnapshot();
    rewriteJsonFile(snapshot, "sites/tasks.example/actions.json", mutate);
    const result = await schema.validateDelegatedBundleSnapshot(snapshot);
    assert.equal(result.ok, false, expectedCode);
    assert.equal(
      result.problems.some((problem) => problem.code === expectedCode),
      true,
      `${expectedCode}: ${JSON.stringify(result.problems)}`,
    );
  }
});

test("R13 an action name must occur exactly once across all declared operational maps", { skip: !schema.validateDelegatedBundleSnapshot }, async () => {
  const snapshot = await validSnapshot();
  const manifest = rewriteJsonFile(snapshot, manifestPath, (value) => {
    value.actions.push({
      name: "other.read",
      map: "sites/tasks.example/copied.actions.json",
      target_ids: ["tasks-web"],
      effect: "read",
    });
  });
  assert.equal(manifest.actions.length, 3);
  const originalMap = JSON.parse(new TextDecoder().decode(
    snapshot.files.find((file) => file.path === "sites/tasks.example/actions.json").bytes,
  ));
  const copiedMap = {
    protocol: "actions.json",
    surface: { origin: "https://tasks.example" },
    tools: [
      structuredClone(originalMap.tools.find((tool) => tool.name === "tasks.list")),
      {
        name: "other.read",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
        output_schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        workflow: {
          version: 1,
          steps: [{ id: "read", primitive: "locator.element_info", args: { locator: { selector: "main" } } }],
        },
      },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(copiedMap));
  snapshot.files.push({
    path: "sites/tasks.example/copied.actions.json",
    mode: "100644",
    type: "blob",
    bytes,
    size: bytes.byteLength,
    blobSha: gitBlobSha(bytes),
  });
  const result = await schema.validateDelegatedBundleSnapshot(snapshot);
  assert.equal(result.ok, false, JSON.stringify(result.problems));
  assert.equal(result.problems.some((problem) => problem.code === "action_name_cross_map_duplicate"), true, JSON.stringify(result.problems));
});

test("R13 rejects excess package resources and duplicate normalized paths", { skip: !schema.validateDelegatedBundleSnapshot }, async () => {
  const snapshot = await validSnapshot();
  snapshot.files.push({
    ...snapshot.files.at(-1),
    path: "sites/tasks.example/e\u0301.md",
  });
  snapshot.files.push({
    ...snapshot.files.at(-1),
    path: "sites/tasks.example/é.md",
  });
  for (let index = snapshot.files.length; index <= 65; index += 1) {
    const bytes = new TextEncoder().encode(`reference ${index}`);
    snapshot.files.push({
      path: `references/${index}.md`,
      mode: "100644",
      type: "blob",
      bytes,
      size: bytes.byteLength,
      blobSha: gitBlobSha(bytes),
    });
  }
  const result = await schema.validateDelegatedBundleSnapshot(snapshot);
  const codes = new Set(result.problems.map((problem) => problem.code));
  assert.equal(codes.has("package_file_limit"), true);
  assert.equal(codes.has("package_duplicate_path"), true);
  assert.equal(codes.has("package_undeclared_file"), true);
});

async function mockGitHubFetch({
  mutateTree,
  fileOverrides = {},
  rawOverrides = {},
  rawResponseFactory,
  redirect,
  rateLimited = false,
} = {}) {
  const files = await fixtureFiles();
  const byPath = new Map(files.map((file) => [file.path, file.bytes]));
  for (const [filePath, bytes] of Object.entries(fileOverrides)) byPath.set(filePath, bytes);
  const tree = [...byPath].map(([filePath, bytes]) => ({
    path: filePath,
    mode: "100644",
    type: "blob",
    sha: gitBlobSha(bytes),
    size: bytes.byteLength,
  }));
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (rateLimited) {
      return new Response(JSON.stringify({ message: "rate limit" }), {
        status: 403,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
      });
    }
    if (url.includes("/git/commits/")) {
      return Response.json({ sha: commitSha, tree: { sha: treeSha } });
    }
    if (url.includes("/git/trees/")) {
      const body = { sha: treeSha, truncated: false, tree: structuredClone(tree) };
      mutateTree?.(body);
      return Response.json(body);
    }
    const marker = `/${commitSha}/`;
    const offset = url.indexOf(marker);
    if (offset >= 0) {
      const filePath = decodeURIComponent(url.slice(offset + marker.length));
      if (redirect && filePath === redirect.path) {
        return new Response(null, { status: 302, headers: { location: redirect.location } });
      }
      const customResponse = rawResponseFactory?.(filePath);
      if (customResponse) return customResponse;
      const bytes = rawOverrides[filePath] ?? byPath.get(filePath);
      return bytes
        ? new Response(bytes, { status: 200, headers: { "content-type": filePath.endsWith(".json") ? "application/json" : "text/markdown" } })
        : new Response("missing", { status: 404 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { fetchImpl, calls };
}

test("R8 mocked fetch independently resolves commit, tree, and immutable raw blobs", { skip: !fetcher.fetchValidatedDelegatedBundle }, async () => {
  const mock = await mockGitHubFetch();
  const result = await fetcher.fetchValidatedDelegatedBundle({
    manifestUrl,
    sourceOrigin: "https://course.example",
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(mock.calls.some((url) => url.includes(`/git/commits/${commitSha}`)), true);
  assert.equal(mock.calls.some((url) => url.includes(`/git/trees/${treeSha}?recursive=1`)), true);
  assert.deepEqual(
    mock.calls.filter((url) => url.startsWith("https://raw.githubusercontent.com/"))
      .map((url) => decodeURIComponent(url.split(`/${commitSha}/`)[1])).sort(),
    fixturePaths.sort(),
  );
});

test("R8 rejects truncated trees, substituted bytes, missing closure files, and unsafe redirects", { skip: !fetcher.fetchValidatedDelegatedBundle }, async (t) => {
  await t.test("truncated tree", async () => {
    const mock = await mockGitHubFetch({ mutateTree: (tree) => { tree.truncated = true; } });
    const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.problems.some((problem) => problem.code === "github_tree_truncated"), true);
  });
  await t.test("substituted raw bytes", async () => {
    const mock = await mockGitHubFetch({ rawOverrides: { "sites/tasks.example/SKILL.md": new TextEncoder().encode("substituted") } });
    const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.problems.some((problem) => problem.code === "blob_sha_mismatch"), true);
  });
  await t.test("missing declared file", async () => {
    const mock = await mockGitHubFetch({ mutateTree: (tree) => { tree.tree = tree.tree.filter((entry) => !entry.path.endsWith("SKILL.md")); } });
    const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.problems.some((problem) => problem.code === "missing_tree_entry"), true);
  });
  await t.test("unsafe redirect", async () => {
    const mock = await mockGitHubFetch({ redirect: { path: "agent.json", location: "https://evil.example/agent.json" } });
    const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.problems.some((problem) => problem.code === "unsafe_redirect"), true);
  });
  await t.test("submodule is rejected from tree metadata without fetching it as a raw file", async () => {
    const mock = await mockGitHubFetch({ mutateTree: (tree) => {
      const skill = tree.tree.find((entry) => entry.path.endsWith("SKILL.md"));
      skill.type = "commit";
      skill.mode = "160000";
    } });
    const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.problems.some((problem) => problem.code === "package_submodule"), true);
    assert.equal(mock.calls.some((url) => url.includes("SKILL.md")), false);
  });
});

test("R13 Git tree byte limits are enforced before any oversized raw blob request", { skip: !fetcher.fetchValidatedDelegatedBundle }, async (t) => {
  await t.test("oversized entry", async () => {
    const mock = await mockGitHubFetch({ mutateTree: (tree) => {
      const manifest = tree.tree.find((entry) => entry.path === manifestPath);
      manifest.size = 256 * 1024 + 1;
    } });
    const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.problems.some((problem) => problem.code === "package_file_too_large"), true, JSON.stringify(result.problems));
    assert.equal(mock.calls.some((url) => url.startsWith("https://raw.githubusercontent.com/")), false);
  });
  for (const invalidSize of [-1, undefined]) {
    await t.test(`invalid tree size ${String(invalidSize)}`, async () => {
      const mock = await mockGitHubFetch({ mutateTree: (tree) => {
        const manifest = tree.tree.find((entry) => entry.path === manifestPath);
        if (invalidSize === undefined) delete manifest.size;
        else manifest.size = invalidSize;
      } });
      const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.problems.some((problem) => problem.code === "tree_size_invalid"), true, JSON.stringify(result.problems));
      assert.equal(mock.calls.some((url) => url.startsWith("https://raw.githubusercontent.com/")), false);
    });
  }
});

test("R13 closure count and aggregate sizes are batch-preflighted before member blob fetches", { skip: !fetcher.fetchValidatedDelegatedBundle }, async (t) => {
  await t.test("file count", async () => {
    const manifest = JSON.parse(await readFile(path.join(fixtureRoot, manifestPath), "utf8"));
    const fileOverrides = {};
    manifest.skills = [];
    for (let index = 0; index < 65; index += 1) {
      const filePath = `reviews/${index}.md`;
      manifest.skills.push({ path: filePath, purpose: `Review ${index}` });
      fileOverrides[filePath] = new TextEncoder().encode(`review ${index}`);
    }
    fileOverrides[manifestPath] = new TextEncoder().encode(JSON.stringify(manifest));
    const mock = await mockGitHubFetch({ fileOverrides });
    const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.problems.some((problem) => problem.code === "package_file_limit"), true, JSON.stringify(result.problems));
    assert.deepEqual(
      mock.calls.filter((url) => url.startsWith("https://raw.githubusercontent.com/")).map((url) => decodeURIComponent(url.split(`/${commitSha}/`)[1])),
      [manifestPath],
    );
  });
  await t.test("aggregate bytes", async () => {
    const manifest = JSON.parse(await readFile(path.join(fixtureRoot, manifestPath), "utf8"));
    const fileOverrides = {};
    manifest.skills = [];
    for (let index = 0; index < 9; index += 1) {
      const filePath = `reviews/large-${index}.md`;
      manifest.skills.push({ path: filePath, purpose: `Large review ${index}` });
      fileOverrides[filePath] = new Uint8Array(240 * 1024).fill(0x61);
    }
    fileOverrides[manifestPath] = new TextEncoder().encode(JSON.stringify(manifest));
    const mock = await mockGitHubFetch({ fileOverrides });
    const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.problems.some((problem) => problem.code === "package_bundle_too_large"), true, JSON.stringify(result.problems));
    assert.deepEqual(
      mock.calls.filter((url) => url.startsWith("https://raw.githubusercontent.com/")).map((url) => decodeURIComponent(url.split(`/${commitSha}/`)[1])),
      [manifestPath],
    );
  });
});

test("R13 raw blob streaming stops at the hard per-file byte cap", { skip: !fetcher.fetchValidatedDelegatedBundle }, async () => {
  const chunk = new Uint8Array(64 * 1024);
  const mock = await mockGitHubFetch({ rawResponseFactory: (filePath) => {
    if (filePath !== manifestPath) return null;
    let chunks = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (chunks >= 5) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        chunks += 1;
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.problems.some((problem) => problem.code === "blob_stream_limit_exceeded"), true, JSON.stringify(result.problems));
});

test("R8 deterministic retrieval defects aggregate with available manifest, scope, and schema defects", { skip: !fetcher.fetchValidatedDelegatedBundle }, async () => {
  const manifest = JSON.parse(await readFile(path.join(fixtureRoot, manifestPath), "utf8"));
  manifest.agent.source_origins.push("https://*.example.com");
  manifest.targets[0].path_prefixes.push("/tasks/%25252fadmin");
  const mapPath = "sites/tasks.example/actions.json";
  const map = JSON.parse(await readFile(path.join(fixtureRoot, mapPath), "utf8"));
  delete map.tools[0].output_schema.properties.items.items.properties.title.maxLength;
  const mock = await mockGitHubFetch({
    fileOverrides: {
      [manifestPath]: new TextEncoder().encode(JSON.stringify(manifest)),
      [mapPath]: new TextEncoder().encode(JSON.stringify(map)),
    },
    mutateTree: (tree) => {
      const skill = tree.tree.find((entry) => entry.path.endsWith("SKILL.md"));
      skill.type = "commit";
      skill.mode = "160000";
    },
  });
  const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
  const codes = new Set(result.problems.map((problem) => problem.code));
  for (const code of ["package_submodule", "source_origin_invalid", "target_path_invalid", "output_string_unbounded"]) {
    assert.equal(codes.has(code), true, `${code}: ${JSON.stringify(result.problems)}`);
  }
  assert.equal(result.kind, "invalid_bundle");
  assert.equal(result.retryable, false);
});

test("R8 independently detectable blob substitutions are aggregated", { skip: !fetcher.fetchValidatedDelegatedBundle }, async () => {
  const mapPath = "sites/tasks.example/actions.json";
  const skillPath = "sites/tasks.example/SKILL.md";
  const mapBytes = new Uint8Array(await readFile(path.join(fixtureRoot, mapPath)));
  const skillBytes = new Uint8Array(await readFile(path.join(fixtureRoot, skillPath)));
  const mock = await mockGitHubFetch({ rawOverrides: {
    [mapPath]: new Uint8Array([...mapBytes, 0x0a]),
    [skillPath]: new Uint8Array([...skillBytes, 0x0a]),
  } });
  const result = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: mock.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.problems.filter((problem) => problem.code === "blob_sha_mismatch").length, 2, JSON.stringify(result.problems));
});

test("R8 reports rate limiting and network failures as retryable retrieval failures", { skip: !fetcher.fetchValidatedDelegatedBundle }, async () => {
  const limited = await mockGitHubFetch({ rateLimited: true });
  const rateResult = await fetcher.fetchValidatedDelegatedBundle({ manifestUrl, sourceOrigin: "https://course.example", fetchImpl: limited.fetchImpl });
  assert.equal(rateResult.ok, false);
  assert.equal(rateResult.kind, "retrieval_error");
  assert.equal(rateResult.retryable, true);
  assert.equal(rateResult.problems[0].code, "github_rate_limited");

  const networkResult = await fetcher.fetchValidatedDelegatedBundle({
    manifestUrl,
    sourceOrigin: "https://course.example",
    fetchImpl: async () => { throw new TypeError("offline"); },
  });
  assert.equal(networkResult.ok, false);
  assert.equal(networkResult.kind, "retrieval_error");
  assert.equal(networkResult.retryable, true);
  assert.equal(networkResult.problems[0].code, "github_network_error");
});
