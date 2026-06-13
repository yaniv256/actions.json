const DEFAULT_API_BASE = "https://api.openai.com/v1";
const DATA_CHANNEL_NAME = "oai-events";

async function assertOkResponse(response, label) {
  if (response?.ok) return;
  let body = "";
  try {
    body = typeof response?.text === "function" ? await response.text() : "";
  } catch {
    body = "";
  }
  const suffix = body ? `: ${body}` : "";
  throw new Error(`${label} failed with status ${response?.status || "unknown"}${suffix}`);
}

function clientSecretValue(payload) {
  return payload?.value || payload?.client_secret?.value;
}

function waitForDataChannelOpen(dataChannel, timeoutMs = 10_000) {
  if (!dataChannel?.readyState || dataChannel.readyState === "open") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Realtime data channel did not open before timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      dataChannel.removeEventListener?.("open", handleOpen);
      dataChannel.removeEventListener?.("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Realtime data channel failed to open"));
    };
    dataChannel.addEventListener?.("open", handleOpen);
    dataChannel.addEventListener?.("error", handleError);
  });
}

function statusEventForTransport({ type, transport, event = null, error = null }) {
  const dataChannel = transport.dataChannel;
  const peerConnection = transport.peerConnection;
  return {
    type,
    data_channel_state: dataChannel?.readyState || (type === "realtime.data_channel.close" ? "closed" : "unknown"),
    closed_by_client: transport.closed,
    close_code: Number.isFinite(event?.code) ? event.code : null,
    close_reason: typeof event?.reason === "string" ? event.reason : null,
    close_was_clean: typeof event?.wasClean === "boolean" ? event.wasClean : null,
    peer_connection_state: peerConnection?.connectionState || null,
    ice_connection_state: peerConnection?.iceConnectionState || null,
    ice_gathering_state: peerConnection?.iceGatheringState || null,
    signaling_state: peerConnection?.signalingState || null,
    data_channel_buffered_amount: Number.isFinite(dataChannel?.bufferedAmount) ? dataChannel.bufferedAmount : null,
    error_message: error?.message || event?.error?.message || null,
  };
}

export class RealtimeWebRtcTransportFactory {
  constructor({
    fetchImpl = globalThis.fetch?.bind(globalThis),
    rtcPeerConnectionFactory = () => new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    }),
    mediaDevices = globalThis.navigator?.mediaDevices,
    documentRef = globalThis.document,
    apiBase = DEFAULT_API_BASE,
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("RealtimeWebRtcTransportFactory requires fetch");
    }
    this.fetchImpl = fetchImpl;
    this.rtcPeerConnectionFactory = rtcPeerConnectionFactory;
    this.mediaDevices = mediaDevices;
    this.documentRef = documentRef;
    this.apiBase = apiBase;
  }

  create(options) {
    return new RealtimeWebRtcTransport({
      ...options,
      fetchImpl: this.fetchImpl,
      rtcPeerConnectionFactory: this.rtcPeerConnectionFactory,
      mediaDevices: this.mediaDevices,
      documentRef: this.documentRef,
      apiBase: this.apiBase,
    });
  }
}

class RealtimeWebRtcTransport {
  constructor({
    apiKey,
    model,
    textOnly = true,
    fetchImpl,
    rtcPeerConnectionFactory,
    mediaDevices,
    documentRef,
    apiBase,
  }) {
    this.apiKey = apiKey;
    this.model = model;
    this.textOnly = textOnly;
    this.fetchImpl = fetchImpl;
    this.rtcPeerConnectionFactory = rtcPeerConnectionFactory;
    this.mediaDevices = mediaDevices;
    this.documentRef = documentRef;
    this.apiBase = apiBase;
    this.peerConnection = null;
    this.dataChannel = null;
    this.localStream = null;
    this.remoteAudio = null;
    this.closed = false;
    this.onStatusEvent = null;
  }

  async connect() {
    this.closed = false;
    const ephemeralKey = await this.createClientSecret();
    this.peerConnection = this.rtcPeerConnectionFactory();
    this.dataChannel = this.peerConnection.createDataChannel(DATA_CHANNEL_NAME);

    this.dataChannel.addEventListener?.("message", (event) => {
      if (!this.onEvent) return;
      this.onEvent(JSON.parse(event.data));
    });
    this.dataChannel.addEventListener?.("close", (event) => {
      this.onStatusEvent?.(statusEventForTransport({
        type: "realtime.data_channel.close",
        transport: this,
        event,
      }));
    });
    this.dataChannel.addEventListener?.("error", (event) => {
      this.onStatusEvent?.(statusEventForTransport({
        type: "realtime.data_channel.error",
        transport: this,
        event,
        error: event?.error,
      }));
    });

    if (this.textOnly) {
      this.peerConnection.addTransceiver?.("audio", { direction: "recvonly" });
    } else {
      await this.attachAudio();
    }

    const offer = await this.peerConnection.createOffer();
    if (!offer?.sdp?.trim()) {
      throw new Error("Realtime WebRTC offer did not include SDP");
    }
    await this.peerConnection.setLocalDescription(offer);

    const sdpResponse = await this.fetchImpl(`${this.apiBase}/realtime/calls`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp",
      },
    });
    await assertOkResponse(sdpResponse, "Realtime SDP exchange");
    await this.peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text(),
    });
    await waitForDataChannelOpen(this.dataChannel);
  }

  async createClientSecret() {
    const response = await this.fetchImpl(`${this.apiBase}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: this.model,
        },
      }),
    });
    await assertOkResponse(response, "Realtime client secret creation");
    const payload = await response.json();
    const secret = clientSecretValue(payload);
    if (typeof secret !== "string" || !secret) {
      throw new Error("Realtime client secret response did not include a usable value");
    }
    return secret;
  }

  async attachAudio() {
    if (!this.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is unavailable in this browser context");
    }
    this.localStream = await this.mediaDevices.getUserMedia({ audio: true });
    const tracks = this.localStream.getTracks();
    if (tracks.length === 0) {
      throw new Error("Microphone returned no audio tracks");
    }
    for (const track of tracks) {
      this.peerConnection.addTrack(track, this.localStream);
    }
    if (this.documentRef?.createElement && this.documentRef?.body?.appendChild) {
      this.remoteAudio = this.documentRef.createElement("audio");
      this.remoteAudio.autoplay = true;
      this.documentRef.body.appendChild(this.remoteAudio);
      this.peerConnection.ontrack = (event) => {
        this.remoteAudio.srcObject = event.streams[0];
        this.remoteAudio.play?.().catch?.(() => {});
      };
    }
  }

  async sendEvent(event) {
    if (!this.dataChannel) {
      throw new Error("Realtime data channel is not connected");
    }
    if (this.dataChannel.readyState && this.dataChannel.readyState !== "open") {
      const error = new Error(`Realtime data channel is not open: ${this.dataChannel.readyState}`);
      error.code = "realtime_data_channel_not_open";
      error.dataChannelState = this.dataChannel.readyState;
      error.peerConnectionState = this.peerConnection?.connectionState || null;
      error.iceConnectionState = this.peerConnection?.iceConnectionState || null;
      error.signalingState = this.peerConnection?.signalingState || null;
      error.dataChannelBufferedAmount = Number.isFinite(this.dataChannel.bufferedAmount)
        ? this.dataChannel.bufferedAmount
        : null;
      throw error;
    }
    this.dataChannel.send(JSON.stringify(event));
  }

  async setInputMuted(muted) {
    if (!this.localStream) {
      throw new Error("Realtime microphone stream is not connected");
    }
    const audioTracks = this.localStream.getAudioTracks?.();
    const tracks = audioTracks?.length ? audioTracks : this.localStream.getTracks();
    for (const track of tracks) {
      track.enabled = !muted;
    }
  }

  async setOutputMuted(muted) {
    if (this.remoteAudio) {
      this.remoteAudio.muted = Boolean(muted);
    }
  }

  async close() {
    this.closed = true;
    this.dataChannel?.close?.();
    this.dataChannel = null;
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove?.();
      this.remoteAudio = null;
    }
    this.peerConnection?.close?.();
    this.peerConnection = null;
  }
}
