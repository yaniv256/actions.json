import assert from "node:assert/strict";
import test from "node:test";

import { RealtimeWebRtcTransportFactory } from "../src/agent/realtime-webrtc-transport.mjs";

function createMockPeerConnection() {
  const dataChannel = new EventTarget();
  dataChannel.readyState = "open";
  dataChannel.bufferedAmount = 2048;
  dataChannel.sent = [];
  dataChannel.send = (raw) => dataChannel.sent.push(JSON.parse(raw));
  dataChannel.close = () => {
    dataChannel.readyState = "closed";
    dataChannel.closed = true;
    dataChannel.dispatchEvent(new Event("close"));
  };
  const pc = {
    dataChannel,
    localDescription: null,
    remoteDescription: null,
    tracks: [],
    transceivers: [],
    closed: false,
    connectionState: "connected",
    iceConnectionState: "connected",
    iceGatheringState: "complete",
    signalingState: "stable",
    createDataChannel(name) {
      assert.equal(name, "oai-events");
      return dataChannel;
    },
    addTrack(track, stream) {
      this.tracks.push({ track, stream });
    },
    addTransceiver(kind, options) {
      this.transceivers.push({ kind, options });
    },
    async createOffer() {
      return { type: "offer", sdp: "mock-offer-sdp" };
    },
    async setLocalDescription(offer) {
      this.localDescription = offer;
    },
    async setRemoteDescription(answer) {
      this.remoteDescription = answer;
    },
    close() {
      this.closed = true;
    },
  };
  return pc;
}

test("Realtime WebRTC transport creates a client secret, posts SDP, and sends data-channel events", async () => {
  const fetchCalls = [];
  const pc = createMockPeerConnection();
  const factory = new RealtimeWebRtcTransportFactory({
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      if (url.endsWith("/realtime/client_secrets")) {
        return {
          ok: true,
          async json() {
            return { value: "ek_mock_client_secret" };
          },
        };
      }
      if (url.endsWith("/realtime/calls")) {
        return {
          ok: true,
          async text() {
            return "mock-answer-sdp";
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    rtcPeerConnectionFactory: () => pc,
  });
  const transport = factory.create({
    apiKey: "sk-proj-secret",
    model: "gpt-realtime-2",
    textOnly: true,
  });

  await transport.connect();
  await transport.sendEvent({ type: "session.update", session: { model: "gpt-realtime-2" } });

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer sk-proj-secret");
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    session: {
      type: "realtime",
      model: "gpt-realtime-2",
    },
  });
  assert.equal(fetchCalls[1].url, "https://api.openai.com/v1/realtime/calls");
  assert.equal(fetchCalls[1].options.body, "mock-offer-sdp");
  assert.equal(fetchCalls[1].options.headers.Authorization, "Bearer ek_mock_client_secret");
  assert.equal(fetchCalls[1].options.headers["Content-Type"], "application/sdp");
  assert.deepEqual(pc.remoteDescription, { type: "answer", sdp: "mock-answer-sdp" });
  assert.deepEqual(pc.transceivers, [{ kind: "audio", options: { direction: "recvonly" } }]);
  assert.deepEqual(pc.dataChannel.sent, [{ type: "session.update", session: { model: "gpt-realtime-2" } }]);
});

test("Realtime WebRTC transport rejects sends when the data channel is not open", async () => {
  const pc = createMockPeerConnection();
  const factory = new RealtimeWebRtcTransportFactory({
    fetchImpl: async (url) => ({
      ok: true,
      async json() {
        return { value: "ek_mock_client_secret" };
      },
      async text() {
        return "mock-answer-sdp";
      },
    }),
    rtcPeerConnectionFactory: () => pc,
  });
  const transport = factory.create({
    apiKey: "sk-proj-secret",
    model: "gpt-realtime-2",
    textOnly: true,
  });

  await transport.connect();
  pc.dataChannel.readyState = "closing";

  await assert.rejects(
    () => transport.sendEvent({ type: "response.create" }),
    /Realtime data channel is not open/,
  );
  assert.deepEqual(pc.dataChannel.sent, []);
});

test("Realtime WebRTC transport reports data-channel close and error events", async () => {
  const pc = createMockPeerConnection();
  const observed = [];
  const factory = new RealtimeWebRtcTransportFactory({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { value: "ek_mock_client_secret" };
      },
      async text() {
        return "mock-answer-sdp";
      },
    }),
    rtcPeerConnectionFactory: () => pc,
  });
  const transport = factory.create({
    apiKey: "sk-proj-secret",
    model: "gpt-realtime-2",
    textOnly: true,
  });
  transport.onStatusEvent = (event) => observed.push(event);

  await transport.connect();
  pc.dataChannel.dispatchEvent(new Event("error"));
  await transport.close();

  assert.deepEqual(observed, [
    {
      type: "realtime.data_channel.error",
      data_channel_state: "open",
      closed_by_client: false,
      close_code: null,
      close_reason: null,
      close_was_clean: null,
      peer_connection_state: "connected",
      ice_connection_state: "connected",
      ice_gathering_state: "complete",
      signaling_state: "stable",
      data_channel_buffered_amount: 2048,
      error_message: null,
    },
    {
      type: "realtime.data_channel.close",
      data_channel_state: "closed",
      closed_by_client: true,
      close_code: null,
      close_reason: null,
      close_was_clean: null,
      peer_connection_state: "connected",
      ice_connection_state: "connected",
      ice_gathering_state: "complete",
      signaling_state: "stable",
      data_channel_buffered_amount: 2048,
      error_message: null,
    },
  ]);
});

test("Realtime WebRTC transport includes upstream SDP exchange error bodies", async () => {
  const pc = createMockPeerConnection();
  const factory = new RealtimeWebRtcTransportFactory({
    fetchImpl: async (url) => {
      if (url.endsWith("/realtime/client_secrets")) {
        return {
          ok: true,
          async json() {
            return { value: "ek_mock_client_secret" };
          },
        };
      }
      return {
        ok: false,
        status: 400,
        async text() {
          return "invalid SDP: missing audio media line";
        },
      };
    },
    rtcPeerConnectionFactory: () => pc,
  });
  const transport = factory.create({
    apiKey: "sk-proj-secret",
    model: "gpt-realtime-2",
    textOnly: true,
  });

  await assert.rejects(
    () => transport.connect(),
    /Realtime SDP exchange failed with status 400: invalid SDP: missing audio media line/,
  );
});

test("Realtime WebRTC transport closes peer connection, data channel, audio tracks, and remote audio", async () => {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  const audio = { removed: false, srcObject: null, remove() { this.removed = true; } };
  const pc = createMockPeerConnection();
  const factory = new RealtimeWebRtcTransportFactory({
    fetchImpl: async (url) => ({
      ok: true,
      async json() {
        return { value: "ek_mock_client_secret" };
      },
      async text() {
        return "mock-answer-sdp";
      },
    }),
    rtcPeerConnectionFactory: () => pc,
    mediaDevices: {
      async getUserMedia() {
        return stream;
      },
    },
    documentRef: {
      createElement(tagName) {
        assert.equal(tagName, "audio");
        return audio;
      },
      body: {
        appendChild(element) {
          assert.equal(element, audio);
        },
      },
    },
  });
  const transport = factory.create({
    apiKey: "sk-proj-secret",
    model: "gpt-realtime-2",
    textOnly: false,
  });

  await transport.connect();
  await transport.close();

  assert.equal(track.stopped, true);
  assert.equal(pc.dataChannel.closed, true);
  assert.equal(pc.closed, true);
  assert.equal(audio.removed, true);
});

function createAudioTransportHarness(remoteOutputAdapter = null) {
  const microphoneTrack = { enabled: true, stop() {} };
  const microphoneStream = {
    getTracks: () => [microphoneTrack],
    getAudioTracks: () => [microphoneTrack],
  };
  const audio = {
    autoplay: false,
    muted: false,
    srcObject: null,
    plays: 0,
    play() { this.plays += 1; return Promise.resolve(); },
    remove() { this.removed = true; },
  };
  const pc = createMockPeerConnection();
  const factory = new RealtimeWebRtcTransportFactory({
    fetchImpl: async (url) => ({
      ok: true,
      async json() { return { value: "ek_mock_client_secret" }; },
      async text() { return "mock-answer-sdp"; },
    }),
    rtcPeerConnectionFactory: () => pc,
    mediaDevices: { async getUserMedia() { return microphoneStream; } },
    documentRef: {
      createElement() { return audio; },
      body: { appendChild() {} },
    },
    remoteOutputAdapter,
  });
  return {
    audio,
    pc,
    remoteOutputAdapter,
    transport: factory.create({ apiKey: "sk-proj-secret", model: "gpt-realtime-2", textOnly: false }),
  };
}

test("Realtime WebRTC transport keeps direct audio as the default remote output", async () => {
  const { audio, pc, transport } = createAudioTransportHarness();
  await transport.connect();
  const remoteStream = { id: "remote-stream" };

  await pc.ontrack({ track: { id: "assistant-audio" }, streams: [remoteStream] });

  assert.equal(audio.srcObject, remoteStream);
  assert.equal(audio.muted, false);
  assert.equal(audio.plays, 1);
});

test("a ready remote-output adapter suppresses duplicate direct audio only after a successful handoff", async () => {
  const calls = [];
  const adapter = {
    isReady: () => true,
    async attachTrack(track) { calls.push(["attach", track.id]); return true; },
    setMuted(muted) { calls.push(["mute", muted]); },
    async detach() { calls.push(["detach"]); },
  };
  const { audio, pc, transport } = createAudioTransportHarness(adapter);
  await transport.connect();

  await pc.ontrack({ track: { id: "assistant-audio" }, streams: [{ id: "remote-stream" }] });

  assert.equal(audio.muted, true);
  assert.deepEqual(calls, [["attach", "assistant-audio"], ["mute", false]]);
  await transport.setOutputMuted(true);
  assert.deepEqual(calls.at(-1), ["mute", true]);
  await transport.close();
  assert.deepEqual(calls.at(-1), ["detach"]);
});

test("a rejected avatar handoff immediately restores direct audio fallback", async () => {
  const adapter = {
    isReady: () => true,
    async attachTrack() { return false; },
    setMuted() {},
    async detach() {},
  };
  const { audio, pc, transport } = createAudioTransportHarness(adapter);
  await transport.connect();

  await pc.ontrack({ track: { id: "assistant-audio" }, streams: [{ id: "remote-stream" }] });

  assert.equal(audio.muted, false);
  assert.equal(audio.plays, 1);
});

test("an adapter runtime failure restores the already-armed direct audio sink", async () => {
  let fallback;
  const adapter = {
    isReady: () => true,
    async attachTrack() { return true; },
    setMuted() {},
    setFallbackHandler(handler) { fallback = handler; },
    async detach() {},
  };
  const { audio, pc, transport } = createAudioTransportHarness(adapter);
  await transport.connect();
  await pc.ontrack({ track: { id: "assistant-audio" }, streams: [{ id: "remote-stream" }] });
  assert.equal(audio.muted, true);

  fallback();

  assert.equal(audio.muted, false);
});

test("closing during an asynchronous avatar handoff detaches the late attachment", async () => {
  let resolveAttach;
  const calls = [];
  const adapter = {
    isReady: () => true,
    attachTrack() {
      calls.push("attach-started");
      return new Promise((resolve) => { resolveAttach = resolve; });
    },
    setMuted() {},
    async detach() { calls.push("detach"); },
  };
  const { pc, transport } = createAudioTransportHarness(adapter);
  await transport.connect();

  const handoff = pc.ontrack({ track: { id: "assistant-audio" }, streams: [{ id: "remote-stream" }] });
  await Promise.resolve();
  await transport.close();
  resolveAttach(true);
  await handoff;

  assert.deepEqual(calls, ["attach-started", "detach", "detach"]);
});
