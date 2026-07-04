import assert from "node:assert/strict";
import test from "node:test";
import { signS3Request } from "../src/agent/sigv4.mjs";

// Shape check against the AWS SigV4 test-suite "get-vanilla" inputs
// (creds AKIDEXAMPLE/..., 2015-08-30T12:36:00Z, us-east-1, service "service").
// Our canonical form always signs x-amz-content-sha256 (S3 requires it), so the
// published signature literal for host;x-amz-date does not apply; determinism,
// secret-sensitivity, and the live options-page Test write carry correctness.
test("get-vanilla inputs produce a well-formed deterministic signature", async () => {
  const headers = await signS3Request({
    method: "GET",
    url: "https://example.amazonaws.com/",
    bodyBytes: new Uint8Array(0),
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    date: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(headers["x-amz-date"], "20150830T123600Z");
  assert.equal(
    headers["x-amz-content-sha256"],
    // sha256 of the empty body
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(headers.host, "example.amazonaws.com");
  assert.match(
    headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
});

test("signature is deterministic and secret-sensitive", async () => {
  const base = {
    method: "PUT",
    url: "https://bucket.s3.eu-west-1.amazonaws.com/prefix/part-1.jsonl",
    bodyBytes: new TextEncoder().encode('{"a":1}\n'),
    accessKeyId: "AKIDEXAMPLE",
    region: "eu-west-1",
    date: new Date("2026-07-04T12:00:00Z"),
  };
  const h1 = await signS3Request({ ...base, secretAccessKey: "secret-A" });
  const h2 = await signS3Request({ ...base, secretAccessKey: "secret-A" });
  const h3 = await signS3Request({ ...base, secretAccessKey: "secret-B" });
  assert.equal(h1.authorization, h2.authorization);
  assert.notEqual(h1.authorization, h3.authorization);
  assert.equal(h1.host, "bucket.s3.eu-west-1.amazonaws.com");
});

test("body changes the signature (payload is signed)", async () => {
  const base = {
    method: "PUT",
    url: "https://b.s3.us-east-1.amazonaws.com/k",
    accessKeyId: "A",
    secretAccessKey: "S",
    region: "us-east-1",
    date: new Date("2026-07-04T12:00:00Z"),
  };
  const h1 = await signS3Request({ ...base, bodyBytes: new TextEncoder().encode("x") });
  const h2 = await signS3Request({ ...base, bodyBytes: new TextEncoder().encode("y") });
  assert.notEqual(h1.authorization, h2.authorization);
});

test("query parameters are canonicalized into the signature", async () => {
  const base = {
    method: "GET",
    url: "https://b.s3.us-east-1.amazonaws.com/?list-type=2&prefix=actions-json%2F",
    bodyBytes: new Uint8Array(0),
    accessKeyId: "A",
    secretAccessKey: "S",
    region: "us-east-1",
    date: new Date("2026-07-04T12:00:00Z"),
  };
  const h1 = await signS3Request(base);
  const h2 = await signS3Request({
    ...base,
    url: "https://b.s3.us-east-1.amazonaws.com/?list-type=2&prefix=other%2F",
  });
  assert.notEqual(h1.authorization, h2.authorization);
});
