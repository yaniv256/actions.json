// Minimal AWS Signature V4 signer for whole-object S3 requests, using
// WebCrypto only (crypto.subtle exists in MV3 service workers and node>=19),
// so the extension carries no AWS SDK dependency. Canonical form always signs
// host, x-amz-content-sha256, and x-amz-date plus any caller headers.

const enc = new TextEncoder();

const HEX = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const sha256 = async (bytes) => HEX(await crypto.subtle.digest("SHA-256", bytes));

async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

// AWS uri-encoding: RFC3986 with uppercase percent-escapes; '/' preserved only
// in paths.
const uriEncode = (s, keepSlash) => {
  const encoded = encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return keepSlash ? encoded.replace(/%2F/gi, "/") : encoded;
};

export async function signS3Request({
  method,
  url,
  headers = {},
  bodyBytes,
  accessKeyId,
  secretAccessKey,
  region,
  service = "s3",
  date = new Date(),
}) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const shortDate = amzDate.slice(0, 8);
  const payloadHash = await sha256(bodyBytes);

  const allHeaders = {
    ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]),
    ),
    host: u.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaderNames = Object.keys(allHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${allHeaders[k]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    method.toUpperCase(),
    uriEncode(decodeURIComponent(u.pathname), true) || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${shortDate}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256(enc.encode(canonicalRequest)),
  ].join("\n");

  let key = enc.encode("AWS4" + secretAccessKey);
  for (const part of [shortDate, region, service, "aws4_request"]) {
    key = await hmac(key, part);
  }
  const signature = HEX(await hmac(key, stringToSign));

  return {
    ...allHeaders,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
