const ENTITY = /^camera\.[a-z0-9_]+$/;
const NATIVE_ORIGIN = 'https://appassets.androidplatform.net';
const TCP_DISCOVERY_MS = 750;
const TCP_CONNECT_MS = 3000;

// The page exchanges SDP/ICE with the same-origin native bridge; HA credentials,
// session IDs and external signaling URLs never enter the dashboard.
export function createCameraPlayer(video, { onState = () => {} } = {}, environment = {}) {
  const env = {
    fetch: (...args) => fetch(...args),
    Peer: globalThis.RTCPeerConnection, Stream: globalThis.MediaStream,
    origin: globalThis.location && location.origin, now: () => Date.now(),
    later: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id),
    session: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
    ...environment
  };
  let current = null;

  function dispose(attempt) {
    if (!attempt || !attempt.active) return;
    attempt.active = false;
    attempt.abort.abort();
    attempt.timers.forEach(env.cancel); attempt.timers.clear();
    attempt.candidates.length = attempt.remoteCandidates.length = 0;
    if (attempt.peer) {
      attempt.peer.ontrack = attempt.peer.onicecandidate = attempt.peer.onconnectionstatechange = null;
      attempt.peer.close();
    }
    video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
    // This explicit close also releases sessions if the WebView keeps requests alive.
    const controller = new AbortController();
    const timeout = env.later(() => controller.abort(), 10000);
    Promise.resolve(env.fetch('./cameras/stop', { method: 'POST', cache: 'no-store', signal: controller.signal,
      headers: { 'X-HomeHQ-Camera-Session': attempt.session } })).catch(() => {}).finally(() => env.cancel(timeout));
  }
  function stop() { const previous = current; current = null; dispose(previous); }
  function fail(message = 'Couldn’t connect to this camera. Try again.') {
    const previous = current;
    if (!previous || !previous.active) return;
    current = null; dispose(previous); onState('error', message);
  }
  function later(attempt, fn, delay) {
    const timer = env.later(() => {
      attempt.timers.delete(timer);
      if (attempt.active && current === attempt) fn();
    }, delay);
    attempt.timers.add(timer);
    return timer;
  }
  async function request(attempt, action, signal) {
    const response = await env.fetch('./cameras/' + action + '/' + attempt.id + '?session=' + attempt.session, {
      method: signal ? 'POST' : 'GET', cache: 'no-store', signal: attempt.abort.signal,
      ...(signal ? { headers: { 'X-HomeHQ-Camera-Signal': JSON.stringify(signal) } } : {})
    });
    if (!attempt.active) return null;
    if (!response.ok) throw new Error('Camera unavailable');
    return response.json();
  }
  async function candidate(attempt, value) {
    try { await request(attempt, 'candidate', { candidate: value }); }
    catch (_) { if (attempt.active) fail('Camera connection was interrupted. Try again.'); }
  }
  function cancelIceTimer(attempt) {
    if (attempt.iceTimer == null) return;
    env.cancel(attempt.iceTimer); attempt.timers.delete(attempt.iceTimer); attempt.iceTimer = null;
  }
  function isTcp(value) { return /^candidate:\S+\s+\d+\s+tcp\s/i.test(value.candidate || ''); }
  async function addRemoteCandidate(attempt, value) {
    try { await attempt.peer.addIceCandidate(value); }
    catch (error) {
      if (attempt.preferTcp && !attempt.tcpConnected && isTcp(value)) await fallbackIce(attempt);
      else throw error;
    }
  }
  async function addRemoteCandidates(attempt) {
    const pending = attempt.remoteCandidates.splice(0);
    for (const value of pending) {
      if (!attempt.active) return;
      if (attempt.preferTcp && !attempt.iceFallback && !isTcp(value)) attempt.remoteCandidates.push(value);
      else await addRemoteCandidate(attempt, value);
    }
  }
  async function fallbackIce(attempt) {
    if (!attempt.active || attempt.iceFallback || attempt.tcpConnected) return;
    attempt.iceFallback = true; cancelIceTimer(attempt);
    if (attempt.offered) attempt.candidates.splice(0).forEach(value => candidate(attempt, value));
    try { if (attempt.answered) await addRemoteCandidates(attempt); }
    catch (_) { if (attempt.active) fail('Camera connection was interrupted. Try again.'); }
  }
  function waitForTcp(attempt) {
    if (!attempt.preferTcp || !attempt.answered || attempt.iceFallback || attempt.tcpConnected) return;
    cancelIceTimer(attempt);
    attempt.iceTimer = later(attempt, () => fallbackIce(attempt), attempt.tcpSeen ? TCP_CONNECT_MS : TCP_DISCOVERY_MS);
  }
  async function remoteCandidate(attempt, raw) {
    // HA's go2rtc provider sends candidate strings without a media section.
    const value = !raw.sdpMid && raw.sdpMLineIndex == null ? { ...raw, sdpMid: '0' } : raw;
    if (attempt.tcpConnected && !isTcp(value)) return;
    const firstTcp = isTcp(value) && !attempt.tcpSeen;
    if (firstTcp) attempt.tcpSeen = true;
    if (!attempt.answered || (attempt.preferTcp && !attempt.iceFallback && !isTcp(value))) attempt.remoteCandidates.push(value);
    else await addRemoteCandidate(attempt, value);
    if (firstTcp && attempt.active) waitForTcp(attempt);
  }
  async function events(attempt) {
    try {
      const result = await request(attempt, 'events');
      if (!attempt.active) return;
      if (!result || !Array.isArray(result.events) || result.state === 'error' || result.state === 'closed') throw new Error('Session ended');
      for (const event of result.events) {
        if (!attempt.active) return;
        if (event.type === 'error') throw new Error('Camera unavailable');
        if (event.type === 'answer') {
          if (typeof event.answer !== 'string' || attempt.answered) throw new Error('Invalid answer');
          await attempt.peer.setRemoteDescription({ type: 'answer', sdp: event.answer });
          if (!attempt.active) return;
          attempt.answered = true;
          await addRemoteCandidates(attempt);
          if (!attempt.active) return;
          waitForTcp(attempt);
        } else if (event.type === 'candidate' && event.candidate) {
          await remoteCandidate(attempt, event.candidate);
        }
      }
      later(attempt, () => events(attempt), 400);
    } catch (_) { if (attempt.active) fail('Camera connection was interrupted. Try again.'); }
  }
  async function health(attempt) {
    try {
      const stats = await attempt.peer.getStats();
      if (!attempt.active) return;
      let frames = 0;
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')
            && Number.isFinite(report.framesDecoded)) frames += report.framesDecoded;
      });
      // Receiving a track or an SDP answer alone does not mean video is playing.
      if (frames > attempt.frames && video.videoWidth > 0 && video.videoHeight > 0 && !video.paused) {
        attempt.lastFrame = env.now();
        if (!attempt.playing) { attempt.playing = true; onState('streaming'); }
      }
      attempt.frames = frames;
      if (attempt.playing && env.now() - attempt.lastFrame > 12000) {
        fail('The camera stopped sending video. Try again.'); return;
      }
      later(attempt, () => health(attempt), 1000);
    } catch (_) { if (attempt.active) fail('Couldn’t verify camera playback. Try again.'); }
  }
  async function start(id) {
    stop();
    if (!ENTITY.test(id) || env.origin !== NATIVE_ORIGIN || !env.Peer || !env.Stream) {
      onState('error', 'Camera streaming is available on your connected frame.'); return;
    }
    const attempt = current = { id, session: env.session(), active: true, abort: new AbortController(), timers: new Set(),
      candidates: [], remoteCandidates: [], offered: false, answered: false, frames: 0, lastFrame: 0, playing: false, peer: null,
      preferTcp: false, tcpSeen: false, tcpConnected: false, iceFallback: false, iceTimer: null };
    onState('connecting');
    later(attempt, () => { if (!attempt.playing) fail('This camera is taking too long to connect. Try again.'); }, 30000);
    try {
      const setup = await request(attempt, 'start');
      if (!attempt.active) return;
      if (!setup || !setup.configuration || typeof setup.dataChannel !== 'string') throw new Error('Invalid camera setup');
      // Local go2rtc cameras can use passive ICE/TCP, avoiding video loss on busy
      // Wi-Fi. Give that path a short head start, then allow normal ICE if needed.
      // Cameras with a required data channel (such as Nest) keep their usual path.
      attempt.preferTcp = !setup.dataChannel;
      const peer = attempt.peer = new env.Peer(setup.configuration);
      const stream = new env.Stream();
      video.muted = true; video.autoplay = true; video.playsInline = true; video.srcObject = stream;
      peer.ontrack = event => {
        if (!attempt.active) return;
        stream.addTrack(event.track);
        Promise.resolve(video.play()).catch(() => { if (attempt.active) fail('Couldn’t start camera playback. Try again.'); });
      };
      peer.onconnectionstatechange = () => {
        if (!attempt.active) return;
        if (peer.connectionState === 'connected' && attempt.preferTcp && !attempt.iceFallback && attempt.tcpSeen) {
          attempt.tcpConnected = true; cancelIceTimer(attempt);
          attempt.candidates.length = attempt.remoteCandidates.length = 0;
        } else if (peer.connectionState === 'failed' && attempt.preferTcp && !attempt.iceFallback && !attempt.tcpConnected) {
          fallbackIce(attempt);
        } else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') fail('Camera connection was lost. Try again.');
      };
      peer.onicecandidate = event => {
        if (!attempt.active || attempt.tcpConnected || !event.candidate) return;
        const value = event.candidate.toJSON();
        if (attempt.offered && (!attempt.preferTcp || attempt.iceFallback)) candidate(attempt, value); else attempt.candidates.push(value);
      };
      if (setup.dataChannel) peer.createDataChannel(setup.dataChannel);
      peer.addTransceiver('audio', { direction: 'recvonly' });
      peer.addTransceiver('video', { direction: 'recvonly' });
      const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      if (!attempt.active) return;
      await peer.setLocalDescription(offer);
      if (!attempt.active) return;
      await request(attempt, 'offer', { offer: offer.sdp });
      if (!attempt.active) return;
      attempt.offered = true;
      if (!attempt.preferTcp || attempt.iceFallback) attempt.candidates.splice(0).forEach(value => candidate(attempt, value));
      events(attempt); health(attempt);
    } catch (_) { if (attempt.active) fail('Couldn’t connect to this camera. Try again.'); }
  }
  return { start, stop, fail };
}
