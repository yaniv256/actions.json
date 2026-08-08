import assert from "node:assert/strict";
import test from "node:test";

const policy = await import("../src/delegated-agent/delegated-policy.mjs").catch(() => ({}));

test("R7/R13 policy module exposes the delegated security surface", () => {
  assert.equal(typeof policy.parseCanonicalGitHubBlobUrl, "function");
  assert.equal(typeof policy.canonicalizeDelegatedOrigin, "function");
  assert.equal(typeof policy.canonicalizePathPrefix, "function");
  assert.equal(typeof policy.isUrlInDelegatedScope, "function");
  assert.equal(typeof policy.validateOutputSchema, "function");
  assert.equal(typeof policy.validatePackageFile, "function");
  assert.equal(typeof policy.validateDelegatedPrimitiveUse, "function");
  assert.equal(Array.isArray(policy.DELEGATED_PRIMITIVE_ALLOWLIST), true);
  assert.throws(() => policy.DELEGATED_PRIMITIVE_ALLOWLIST.push("browser.run_javascript"), TypeError);
});

test("R7 accepts only a canonical public GitHub blob URL pinned to a lowercase full SHA", { skip: !policy.parseCanonicalGitHubBlobUrl }, () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(
    policy.parseCanonicalGitHubBlobUrl(`https://github.com/example/agent-bundle/blob/${sha}/agent.json`),
    { owner: "example", repo: "agent-bundle", commitSha: sha, manifestPath: "agent.json" },
  );

  for (const url of [
    "https://github.com/example/agent-bundle/blob/main/agent.json",
    `https://github.com/example/agent-bundle/blob/${sha.slice(0, 12)}/agent.json`,
    `https://github.com/example/agent-bundle/blob/${sha.toUpperCase()}/agent.json`,
    `https://github.com/example/agent-bundle/tree/${sha}/agent.json`,
    `https://user@github.com/example/agent-bundle/blob/${sha}/agent.json`,
    `https://github.com/example/agent-bundle/blob/${sha}/agent.json?raw=1`,
    `https://github.com/example/agent-bundle/blob/${sha}/agent.json#readme`,
    `https://github.com/example/agent-bundle/blob/${sha}/dir%2Fagent.json`,
    `https://github.com/example/agent-bundle/blob/${sha}/dir%5Cagent.json`,
  ]) {
    assert.throws(() => policy.parseCanonicalGitHubBlobUrl(url), /GitHub|canonical|commit|path/i, url);
  }
});

test("R9/R13 canonical origins reject wildcard, credentials, fragments, IPs, and ambiguous Unicode", { skip: !policy.canonicalizeDelegatedOrigin }, () => {
  assert.equal(policy.canonicalizeDelegatedOrigin("https://course.example"), "https://course.example");
  assert.equal(policy.canonicalizeDelegatedOrigin("https://course.example:8443"), "https://course.example:8443");
  for (const origin of [
    "https://*.example.com",
    "https://user:secret@example.com",
    "https://example.com/#fragment",
    "https://127.0.0.1",
    "https://[::1]",
    "https://münich.example",
    "https://xn--mnich-kva.example",
    "http://course.example",
  ]) {
    assert.throws(() => policy.canonicalizeDelegatedOrigin(origin), /origin|host|HTTPS|Unicode|IP/i, origin);
  }
  assert.equal(
    policy.canonicalizeDelegatedOrigin("http://localhost:3000", { allowLocalhost: true }),
    "http://localhost:3000",
  );
});

test("R13 path scopes are canonical segment prefixes and reject encoded bypasses", { skip: !policy.canonicalizePathPrefix }, () => {
  assert.equal(policy.canonicalizePathPrefix("/foo/bar"), "/foo/bar");
  for (const path of [
    "foo",
    "/foo/../admin",
    "/foo/%2fadmin",
    "/foo/%252fadmin",
    "/foo/%5cadmin",
    "/foo/%00admin",
    "/foo\\admin",
    "/foo?admin=true",
    "/foo#admin",
  ]) {
    assert.throws(() => policy.canonicalizePathPrefix(path), /path|encoded|control|canonical/i, path);
  }
  const target = { origin: "https://tasks.example", path_prefixes: ["/foo"] };
  assert.equal(policy.isUrlInDelegatedScope("https://tasks.example/foo", target), true);
  assert.equal(policy.isUrlInDelegatedScope("https://tasks.example/foo/", target), true);
  assert.equal(policy.isUrlInDelegatedScope("https://tasks.example/foo/bar?q=1#part", target), true);
  assert.equal(policy.isUrlInDelegatedScope("https://tasks.example/foobar", target), false);
  assert.equal(policy.isUrlInDelegatedScope("https://other.example/foo", target), false);
  assert.equal(policy.isUrlInDelegatedScope("https://tasks.example/foo/%2fadmin", target), false);
});

test("R13 path canonicalization reaches a fixed point for deeply nested encodings", { skip: !policy.canonicalizePathPrefix }, () => {
  const encodeLayers = (value, layers) => {
    let encoded = value;
    for (let index = 0; index < layers; index += 1) encoded = encodeURIComponent(encoded);
    return encoded;
  };
  const target = { origin: "https://tasks.example", path_prefixes: ["/safe"] };
  for (const layers of [4, 5, 10]) {
    for (const bypass of ["/admin", "\\admin", "\u0000admin"]) {
      const path = `/safe/${encodeLayers(bypass, layers)}`;
      assert.throws(() => policy.canonicalizePathPrefix(path), /encoded|control|path/i, `${layers}: ${bypass}`);
      assert.equal(policy.isUrlInDelegatedScope(`https://tasks.example${path}`, target), false, `${layers}: ${bypass}`);
    }
  }
});

test("R13 policy limits are centralized at their contract values", { skip: !policy.DELEGATED_POLICY_LIMITS }, () => {
  assert.deepEqual(policy.DELEGATED_POLICY_LIMITS, {
    maxFiles: 64,
    maxFileBytes: 256 * 1024,
    maxBundleBytes: 2 * 1024 * 1024,
    maxActions: 128,
    maxTargets: 32,
    maxPathPrefixesPerTarget: 64,
    maxResultBytes: 64 * 1024,
    maxStoredBundlesBytes: 32 * 1024 * 1024,
    defaultTimeoutMs: 60_000,
    minTimeoutMs: 5_000,
    maxTimeoutMs: 180_000,
  });
});

test("R13 output schemas allow only bounded non-sensitive JSON projections", { skip: !policy.validateOutputSchema }, () => {
  const good = {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 200 },
      items: { type: "array", maxItems: 10, items: { type: "boolean" } },
    },
    required: ["title"],
    additionalProperties: false,
  };
  assert.deepEqual(policy.validateOutputSchema(good), []);

  const defects = policy.validateOutputSchema({
    type: "object",
    properties: {
      cookie: { type: "string" },
      raw_html: { type: "string", maxLength: 1000 },
      rawHTML: { type: "string", maxLength: 1000 },
      headers: { type: "string", maxLength: 1000 },
      media: {},
      list: { type: "array", items: { type: "string", maxLength: 5 } },
    },
    additionalProperties: true,
  });
  const codes = new Set(defects.map((problem) => problem.code));
  assert.equal(codes.has("output_sensitive_field"), true);
  assert.equal(codes.has("output_string_unbounded"), true);
  assert.equal(codes.has("output_array_unbounded"), true);
  assert.equal(codes.has("output_arbitrary_properties"), true);
  assert.equal(codes.has("output_schema_type_missing"), true);
  const sensitivePaths = defects.filter((problem) => problem.code === "output_sensitive_field").map((problem) => problem.path);
  assert.equal(sensitivePaths.some((path) => path.endsWith(".rawHTML")), true);
  assert.equal(sensitivePaths.some((path) => path.endsWith(".headers")), true);
});

test("R13 output schemas reject every undeclared or widening schema keyword", { skip: !policy.validateOutputSchema }, () => {
  const forbiddenKeywords = [
    "$ref",
    "$defs",
    "anyOf",
    "allOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "dependentSchemas",
    "unevaluatedItems",
    "x_widen",
  ];
  for (const keyword of forbiddenKeywords) {
    const schema = {
      type: "object",
      properties: { safe: { type: "boolean" } },
      additionalProperties: false,
      [keyword]: keyword === "$ref" ? "#/$defs/value" : {},
    };
    const problems = policy.validateOutputSchema(schema);
    assert.equal(
      problems.some((problem) => problem.code === "output_schema_keyword_forbidden" && problem.path.endsWith(`.${keyword}`)),
      true,
      keyword,
    );
  }
});

test("R13 output schema sensitive-field matching catches semantic tokens inside compound names", { skip: !policy.validateOutputSchema }, () => {
  const names = [
    "response_headers",
    "user_cookie_value",
    "accessTokenValue",
    "raw_html_body",
    "screenshot_url",
  ];
  const schema = {
    type: "object",
    properties: Object.fromEntries(names.map((name) => [name, { type: "string", maxLength: 100 }])),
    additionalProperties: false,
  };
  const sensitive = policy.validateOutputSchema(schema)
    .filter((problem) => problem.code === "output_sensitive_field")
    .map((problem) => problem.path.split(".").at(-1));
  assert.deepEqual(new Set(sensitive), new Set(names));
});

test("R13 package policy rejects non-regular and hidden executable content", { skip: !policy.validatePackageFile }, () => {
  const checks = [
    [{ path: "link", mode: "120000", type: "blob", bytes: new TextEncoder().encode("target") }, "package_symlink"],
    [{ path: "vendor", mode: "160000", type: "commit", bytes: new Uint8Array() }, "package_submodule"],
    [{ path: "tool.sh", mode: "100755", type: "blob", bytes: new TextEncoder().encode("echo hi") }, "package_executable"],
    [{ path: "page.html", mode: "100644", type: "blob", bytes: new TextEncoder().encode("<p>x</p>") }, "package_forbidden_extension"],
    [{ path: "payload.txt", mode: "100644", type: "blob", bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) }, "package_binary"],
    [{ path: "large.dat", mode: "100644", type: "blob", size: 256 * 1024 + 1, bytes: new Uint8Array() }, "package_file_too_large"],
    [{ path: "pointer.md", mode: "100644", type: "blob", bytes: new TextEncoder().encode("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n") }, "package_lfs_pointer"],
    [{ path: "hidden.txt", mode: "100644", type: "blob", bytes: new TextEncoder().encode("#!/usr/bin/env node\n") }, "package_hidden_executable"],
    [{ path: "active.md", mode: "100644", type: "blob", bytes: new TextEncoder().encode("<script src='payload'></script>\n") }, "package_hidden_executable"],
  ];
  for (const [file, expectedCode] of checks) {
    const codes = policy.validatePackageFile(file).map((problem) => problem.code);
    assert.equal(codes.includes(expectedCode), true, `${file.path}: ${codes.join(",")}`);
  }
});

test("R13 review text rejects all embedded active markup and CSS URL payloads", { skip: !policy.validatePackageFile }, () => {
  const payloads = [
    "# Review\n<img src=x onerror=alert(1)>",
    "<svg><g onload=alert(1)></g></svg>",
    "<math><mtext><img src=x onerror=alert(1)></mtext></math>",
    "<iframe srcdoc='<script>alert(1)</script>'></iframe>",
    "<div style=\"background-image: url(https://evil.example/x)\">x</div>",
    "< ImG\nSrC=x\noNeRrOr=alert(1) >",
  ];
  for (const [index, content] of payloads.entries()) {
    const problems = policy.validatePackageFile({
      path: `review-${index}.md`,
      mode: "100644",
      type: "blob",
      bytes: new TextEncoder().encode(content),
    });
    assert.equal(problems.some((problem) => problem.code === "package_hidden_executable"), true, content);
  }
});

test("R13 delegated workflows use an explicit primitive allowlist", { skip: !policy.validateDelegatedPrimitiveUse }, () => {
  assert.deepEqual(policy.validateDelegatedPrimitiveUse("locator.element_info", "$.steps[0]"), []);
  assert.deepEqual(policy.validateDelegatedPrimitiveUse("keyboard.press", "$.steps[0]"), []);
  for (const primitive of [
    "browser.run_javascript",
    "debug.run_javascript",
    "bridge.tools.call",
    "browser.open_tab",
    "dynamic.load",
    "made.up.primitive",
  ]) {
    const problems = policy.validateDelegatedPrimitiveUse(primitive, "$.steps[0]");
    assert.equal(problems.length > 0, true, primitive);
  }
});
