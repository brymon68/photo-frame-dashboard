import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraPlayer } from '../js/camera-player.js';

const settle = () => new Promise(setImmediate);
function fixture(options = {}) {
  const timers = new Map(), requests = [], peers = [], states = [], streams = [];
  let timer = 0, session = 0, now = 10000, frames = 0, queuedEvents = [], holdStart = null;
  class Peer {
    constructor(config) { this.config = config; this.closed = false; this.transceivers = []; this.remoteCandidates = []; peers.push(this); }
    createDataChannel(name) { this.channel = name; }
    addTransceiver(kind, config) { this.transceivers.push({ kind, ...config }); }
    async createOffer() { return { type: 'offer', sdp: 'browser-sdp' }; }
    async setLocalDescription() { this.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'ice', sdpMid: '0', sdpMLineIndex: 0 }) } }); }
    async setRemoteDescription(answer) { this.answer = answer; }
    async addIceCandidate(candidate) {
      if (options.rejectTcp && / tcp /i.test(candidate.candidate)) throw new Error('TCP unsupported');
      this.remoteCandidates.push(candidate);
    }
    async getStats() { return new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: frames }]]); }
    close() { this.closed = true; }
  }
  class Stream { constructor() { this.tracks = []; streams.push(this); } addTrack(track) { this.tracks.push(track); } }
  const video = { videoWidth: 0, videoHeight: 0, paused: true, srcObject: null,
    play: async () => { video.paused = false; }, pause() { video.paused = true; }, removeAttribute() {}, load() {} };
  const env = { Peer, Stream, origin: 'https://appassets.androidplatform.net', now: () => now,
    session: () => String(++session).padStart(32, '0'), later: (fn, ms) => { const id = ++timer; timers.set(id, { fn, ms }); return id; }, cancel: id => timers.delete(id),
    fetch: async (url, config) => {
      requests.push({ url, ...config });
      if (url.includes('/start/')) {
        if (options.holdStart) return new Promise(resolve => { holdStart = resolve; });
        return { ok: !options.startError, json: async () => ({ configuration: { iceServers: [] }, dataChannel: options.dataChannel ?? 'dataSendChannel' }) };
      }
      if (url.includes('/events/')) { const events = queuedEvents; queuedEvents = []; return { ok: true, json: async () => ({ events, state: 'streaming' }) }; }
      return { ok: true, json: async () => ({ ok: true }) };
    }, ...options.environment };
  const player = createCameraPlayer(video, { onState: (state, detail) => states.push({ state, detail }) }, env);
  return { player, video, requests, peers, states, streams, timers,
    events: value => { queuedEvents = value; }, frames: n => { frames = n; }, advance: ms => { now += ms; },
    release: () => holdStart({ ok: true, json: async () => ({ configuration: {}, dataChannel: 'dataSendChannel' }) }),
    async run(ms) { const item = [...timers].find(([, item]) => item.ms === ms); assert.ok(item, 'timer ' + ms); timers.delete(item[0]); item[1].fn(); await settle(); } };
}

test('uses the native signaling bridge, queues local ICE behind offer and treats only decoded video as streaming', async () => {
  const f = fixture();
  f.events([{ type: 'candidate', candidate: { candidate: 'remote-ice' } }, { type: 'answer', answer: 'remote-sdp' }]);
  await f.player.start('camera.porch'); await settle();
  const peer = f.peers[0];
  assert.equal(peer.channel, 'dataSendChannel');
  assert.deepEqual(peer.transceivers.map(t => t.kind), ['audio', 'video']);
  assert.ok(peer.transceivers.every(t => t.direction === 'recvonly'));
  assert.equal(peer.answer.sdp, 'remote-sdp');
  assert.equal(peer.remoteCandidates[0].candidate, 'remote-ice');
  assert.ok(f.requests.findIndex(r => r.url.includes('/offer/')) < f.requests.findIndex(r => r.url.includes('/candidate/')));
  assert.deepEqual(f.states.map(s => s.state), ['connecting']);
  peer.ontrack({ track: { kind: 'video' } });
  await settle();
  assert.deepEqual(f.states.map(s => s.state), ['connecting']);
  f.video.videoWidth = 640; f.video.videoHeight = 360; f.frames(3);
  await f.run(1000);
  assert.equal(f.states.at(-1).state, 'streaming');
  assert.equal(f.video.muted, true);
  f.player.stop();
});

const ice = protocol => ({ candidate: `candidate:1 1 ${protocol} 123 192.0.2.1 18555 typ host${protocol === 'tcp' ? ' tcptype passive' : ''}` });
const sendsIce = f => f.requests.filter(r => r.url.includes('/candidate/'));
const hasTimer = (f, ms) => [...f.timers.values()].some(item => item.ms === ms);

test('go2rtc tries TCP candidates received before the answer and keeps UDP out after TCP connects', async () => {
  const f = fixture({ dataChannel: '' });
  f.events([{ type: 'candidate', candidate: ice('udp') }, { type: 'candidate', candidate: ice('tcp') }]);
  await f.player.start('camera.doorbell'); await settle();
  const peer = f.peers[0];
  assert.equal(peer.channel, undefined);
  assert.equal(sendsIce(f).length, 0);
  assert.deepEqual(peer.remoteCandidates, []);
  assert.equal(hasTimer(f, 750), false);
  assert.equal(hasTimer(f, 3000), false);

  f.events([{ type: 'answer', answer: 'remote-sdp' }]); await f.run(400);
  assert.deepEqual(peer.remoteCandidates, [{ ...ice('tcp'), sdpMid: '0' }]);
  assert.equal(hasTimer(f, 3000), true);
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  assert.equal(hasTimer(f, 3000), false);
  assert.deepEqual(f.states.map(s => s.state), ['connecting']);
  peer.onicecandidate({ candidate: { toJSON: () => ice('udp') } });
  f.events([{ type: 'candidate', candidate: ice('udp') }]); await f.run(400);
  assert.equal(sendsIce(f).length, 0);
  assert.equal(peer.remoteCandidates.length, 1);

  peer.ontrack({ track: { kind: 'video' } }); await settle();
  f.video.videoWidth = 720; f.video.videoHeight = 990; f.frames(4); await f.run(1000);
  assert.equal(f.states.at(-1).state, 'streaming');
  f.player.stop(); await settle();
  assert.equal(f.timers.size, 0);
});

test('go2rtc without a TCP candidate releases queued UDP and local ICE after a short grace', async () => {
  const f = fixture({ dataChannel: '' });
  f.events([{ type: 'candidate', candidate: { ...ice('udp'), sdpMLineIndex: 0 } }, { type: 'answer', answer: 'remote-sdp' }]);
  await f.player.start('camera.doorbell'); await settle();
  const peer = f.peers[0];
  assert.equal(sendsIce(f).length, 0);
  assert.deepEqual(peer.remoteCandidates, []);
  await f.run(750);
  assert.equal(sendsIce(f).length, 1);
  assert.deepEqual(peer.remoteCandidates, [{ ...ice('udp'), sdpMLineIndex: 0 }]);
  assert.ok(f.requests.findIndex(r => r.url.includes('/offer/')) < f.requests.findIndex(r => r.url.includes('/candidate/')));
  peer.onicecandidate({ candidate: { toJSON: () => ice('udp') } }); await settle();
  f.events([{ type: 'candidate', candidate: ice('tcp') }, { type: 'candidate', candidate: ice('udp') }]); await f.run(400);
  assert.equal(sendsIce(f).length, 2);
  assert.equal(peer.remoteCandidates.length, 3);
  assert.equal(hasTimer(f, 3000), false);
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  assert.equal(f.states.at(-1).state, 'connecting');
  f.player.stop();
});

test('late TCP candidates get a bounded connection attempt before normal ICE fallback', async () => {
  const f = fixture({ dataChannel: '' });
  f.events([{ type: 'answer', answer: 'remote-sdp' }, { type: 'candidate', candidate: ice('udp') }]);
  await f.player.start('camera.doorbell'); await settle();
  assert.equal(hasTimer(f, 750), true);
  f.events([{ type: 'candidate', candidate: ice('tcp') }]); await f.run(400);
  assert.equal(hasTimer(f, 750), false);
  assert.equal(sendsIce(f).length, 0);
  assert.deepEqual(f.peers[0].remoteCandidates, [{ ...ice('tcp'), sdpMid: '0' }]);
  await f.run(3000);
  assert.equal(sendsIce(f).length, 1);
  assert.deepEqual(f.peers[0].remoteCandidates, [{ ...ice('tcp'), sdpMid: '0' }, { ...ice('udp'), sdpMid: '0' }]);
  assert.equal(f.peers[0].closed, false);
  f.player.stop();
});

test('failed TCP negotiation falls back immediately, while failure after fallback still closes the session', async () => {
  const f = fixture({ dataChannel: '' });
  f.events([{ type: 'answer', answer: 'remote-sdp' }, { type: 'candidate', candidate: ice('tcp') }, { type: 'candidate', candidate: ice('udp') }]);
  await f.player.start('camera.doorbell'); await settle();
  const peer = f.peers[0];
  peer.connectionState = 'failed'; peer.onconnectionstatechange(); await settle();
  assert.equal(peer.closed, false);
  assert.equal(sendsIce(f).length, 1);
  assert.equal(peer.remoteCandidates.length, 2);
  assert.equal(hasTimer(f, 3000), false);
  peer.onconnectionstatechange();
  assert.equal(peer.closed, true);
  assert.equal(f.states.at(-1).state, 'error');
});

test('rejected TCP candidates release UDP and local ICE without closing the camera', async () => {
  const f = fixture({ dataChannel: '', rejectTcp: true });
  f.events([{ type: 'candidate', candidate: ice('udp') }, { type: 'candidate', candidate: ice('tcp') },
    { type: 'candidate', candidate: ice('tcp') }, { type: 'answer', answer: 'remote-sdp' }]);
  await f.player.start('camera.doorbell'); await settle();
  assert.equal(f.peers[0].closed, false);
  assert.deepEqual(f.peers[0].remoteCandidates, [{ ...ice('udp'), sdpMid: '0' }]);
  assert.equal(sendsIce(f).length, 1);
  assert.equal(hasTimer(f, 750), false);
  assert.equal(hasTimer(f, 3000), false);
  assert.deepEqual(f.states.map(s => s.state), ['connecting']);
  f.events([{ type: 'candidate', candidate: ice('tcp') }, { type: 'candidate', candidate: ice('udp') }]); await f.run(400);
  assert.equal(f.peers[0].closed, false);
  assert.equal(f.peers[0].remoteCandidates.length, 2);
  assert.equal(sendsIce(f).length, 1);
  f.player.stop();
});

test('switching cameras cancels TCP fallback and stale callbacks cannot send old candidates', async () => {
  const f = fixture({ dataChannel: '' });
  f.events([{ type: 'answer', answer: 'remote-sdp' }, { type: 'candidate', candidate: ice('udp') }]);
  await f.player.start('camera.doorbell'); await settle();
  const oldFallback = [...f.timers.values()].find(item => item.ms === 750).fn;
  const oldCandidate = f.peers[0].onicecandidate;
  await f.player.start('camera.driveway'); await settle();
  assert.equal(hasTimer(f, 750), false);
  oldFallback(); oldCandidate({ candidate: { toJSON: () => ice('udp') } }); await settle();
  assert.equal(sendsIce(f).length, 0);
  assert.equal(f.peers[1].closed, false);
  f.player.stop(); await settle();
  assert.equal(f.timers.size, 0);
});

test('stalled decoded frames clear the old image, close the peer and allow an explicit retry', async () => {
  const f = fixture(); await f.player.start('camera.porch'); await settle();
  f.peers[0].ontrack({ track: { kind: 'video' } });
  f.video.videoWidth = 640; f.video.videoHeight = 360; f.frames(1); await f.run(1000);
  f.advance(13000); await f.run(1000);
  assert.equal(f.states.at(-1).state, 'error');
  assert.match(f.states.at(-1).detail, /stopped sending/);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.peers[0].closed, true);
  assert.equal(f.requests.filter(r => r.url === './cameras/stop').length, 1);
  await f.player.start('camera.porch');
  assert.equal(f.peers.length, 2);
  assert.notEqual(f.requests.filter(r => r.url.includes('/start/'))[0].url, f.requests.filter(r => r.url.includes('/start/'))[1].url);
  f.player.stop();
});

test('timeout never calls a signaled or empty video live, and cleans native session', async () => {
  const f = fixture(); await f.player.start('camera.porch'); await settle();
  await f.run(30000);
  assert.equal(f.states.at(-1).state, 'error');
  assert.equal(f.peers[0].closed, true);
  assert.equal(f.video.srcObject, null);
  assert.ok(f.requests.some(r => r.url === './cameras/stop'));
});

test('switching cameras stops the previous stream, ignores callbacks after close, and stop is idempotent', async () => {
  const f = fixture(); await f.player.start('camera.porch'); await settle();
  const previousTrack = f.peers[0].ontrack;
  await f.player.start('camera.driveway');
  assert.equal(f.peers[0].closed, true);
  assert.equal(f.peers[1].closed, false);
  previousTrack({ track: { kind: 'video' } });
  assert.equal(f.streams[0].tracks.length, 0);
  f.player.stop(); f.player.stop();
  await settle();
  assert.equal(f.requests.filter(r => r.url === './cameras/stop').length, 2);
  assert.equal(f.timers.size, 0);
});

test('closing during native startup aborts its request and cannot create a late peer', async () => {
  const f = fixture({ holdStart: true }); const pending = f.player.start('camera.porch');
  f.player.stop();
  assert.equal(f.requests[0].signal.aborted, true);
  f.release(); await pending;
  assert.equal(f.peers.length, 0);
  assert.equal(f.requests.filter(r => r.url === './cameras/stop').length, 1);
});

test('browser preview and malformed camera IDs cannot start native requests', async () => {
  const preview = fixture({ environment: { origin: 'http://localhost' } });
  await preview.player.start('camera.porch');
  assert.equal(preview.requests.length, 0);
  const f = fixture(); await f.player.start('../camera.porch');
  assert.equal(f.requests.length, 0);
});
