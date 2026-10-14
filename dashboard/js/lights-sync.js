import { parseLights, lightStatus, lightCounts } from './lights-feed.js';

const App = window.App, INTERVAL = 30000;
const native = location.origin === 'https://appassets.androidplatform.net';
const state = App.lights = { rooms: [], lights: [], configured: native, loading: native, stale: false, error: false, updated: 0 };
let busy = null, lastAttempt = 0;
const isStale = () => state.stale || state.error || !state.updated || Date.now() < state.updated || Date.now() - state.updated > INTERVAL * 2;
state.status = light => lightStatus(light, isStale());
state.counts = lights => lightCounts(lights || state.lights, isStale());
state.label = () => !state.configured ? 'Connect Home Assistant' : state.loading ? 'Loading rooms…'
  : isStale() ? 'Lights unavailable' : 'No lights';
state.summary = () => {
  const counts = state.counts();
  return { value: isStale() || !state.configured || state.lights.length > 0 && counts.unavailable === state.lights.length ? '—' : counts.on,
    detail: isStale() || !state.configured ? state.label() : counts.unavailable ? counts.label
      : 'on in ' + counts.rooms + (counts.rooms === 1 ? ' room' : ' rooms') };
};
state.refresh = async function (afterCommand = false) {
  if (!native) return;
  if (busy) {
    await busy;
    if (afterCommand === true) return state.refresh();
    return;
  }
  lastAttempt = Date.now();
  busy = (async () => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch('./lights/rooms.json', { cache: 'no-store', signal: controller.signal });
      if (response.status === 404) {
        state.configured = false; state.rooms = []; state.lights = []; state.updated = 0; state.error = false; state.stale = false;
      } else {
        if (!response.ok) throw new Error('Lights unavailable');
        const data = parseLights(await response.json());
        const updated = Number(response.headers.get('X-Lights-Updated'));
        if (!Number.isFinite(updated) || updated <= 0) throw new Error('Missing lights timestamp');
        state.rooms = data.rooms; state.lights = data.lights; state.updated = updated; state.configured = true; state.error = false;
        state.stale = response.headers.get('X-Lights-Stale') === 'true';
      }
    } catch (e) { state.error = true; state.stale = true; }
    finally { clearTimeout(timeout); state.loading = false; App.emit('lights'); }
  })();
  try { await busy; } finally { busy = null; }
};
App.on('ready', function () {
  state.refresh();
  if (!native) return;
  setInterval(state.refresh, INTERVAL);
  window.addEventListener('online', state.refresh);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Math.abs(Date.now() - lastAttempt) >= INTERVAL) state.refresh();
  });
});
