export const BRIDGE_HANDSHAKE_SECRET_KEY = "bridgeHandshakeSecret";
export const BRIDGE_PAIRING_UPDATED_MESSAGE = "actions-json:bridge-pairing-updated";

const normalizedSecret = (value) => String(value ?? "").trim();

export const bridgePairingState = async (storageArea) => {
  const stored = await storageArea.get(BRIDGE_HANDSHAKE_SECRET_KEY);
  return {
    paired: normalizedSecret(stored?.[BRIDGE_HANDSHAKE_SECRET_KEY]).length > 0,
  };
};

export const saveBridgePairingSecret = async ({ storageArea, runtime, value, bridgeUrl = "" }) => {
  const secret = normalizedSecret(value);
  if (secret.length < 32) {
    return {
      ok: false,
      code: "secret_too_short",
      message: "Paste the complete bridge handshake secret (at least 32 characters).",
    };
  }

  await storageArea.set({ [BRIDGE_HANDSHAKE_SECRET_KEY]: secret });
  const reconnect = await runtime.sendMessage({
    type: BRIDGE_PAIRING_UPDATED_MESSAGE,
    bridgeUrl: typeof bridgeUrl === "string" ? bridgeUrl.trim() : "",
  });
  if (!reconnect?.ok) {
    return {
      ok: false,
      saved: true,
      code: reconnect?.error?.code || "bridge_reconnect_failed",
      message:
        reconnect?.error?.message ||
        "The secret was saved, but the bridge refused the connection. Check that it came from this MCP installation.",
    };
  }
  return { ok: true, saved: true, connected: true };
};

export const removeBridgePairingSecret = async ({ storageArea, runtime }) => {
  await storageArea.remove(BRIDGE_HANDSHAKE_SECRET_KEY);
  await runtime.sendMessage({ type: BRIDGE_PAIRING_UPDATED_MESSAGE }).catch(() => null);
  return { ok: true, paired: false };
};
