import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const encoder = new TextEncoder();

/** SHA-256 hex for a UTF-8 string in Node, Workers, and browsers. */
export function sha256Hex(value) {
  return bytesToHex(sha256(encoder.encode(String(value))));
}
