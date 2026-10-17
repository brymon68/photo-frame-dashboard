import { parseCameras, cameraAvailable, doorbellCamera } from './cameras-feed.js';

const App = window.App, INTERVAL = 30000;
const native = location.origin === 'https://appassets.androidplatform.net';
const state = App.cameras = { devices: [], configured: native, loading: native, stale: false, error: false, updated: 0 };
let busy = null, lastAttempt = 0;
const isStale = () => state.stale || state.error || !state.updated || Date.now() < state.updated || Date.now() - state.updated > INTERVAL * 2;
state.canView = camera => native && state.configured && cameraAvailable(camera, isStale());
state.doorbell = () => doorbellCamera(state.devices);
state.status = camera => state.canView(camera) ? 'Tap to watch' : 'Unavailable';
state.label = () => !state.configured ? 'Connect Home Assistant to see your cameras.' : state.loading ? 'Loading cameras…'
  : isStale() ? 'Cameras unavailable. Try refreshing.' : 'No cameras found in Home Assistant.';
state.refresh = async function () {
  if (!native) return;
  if (busy) return busy;
  lastAttempt = Date.now();
  busy = (async () => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('./cameras/devices.json', { cache: 'no-store', signal: controller.signal });
      if (response.status === 404) {
        state.configured = false; state.devices = []; state.updated = 0; state.error = false; state.stale = false;
      } else {
        if (!response.ok) throw new Error('Cameras unavailable');
        const devices = parseCameras(await response.json());
        const updated = Number(response.headers.get('X-Cameras-Updated'));
        if (!Number.isFinite(updated) || updated <= 0) throw new Error('Missing camera timestamp');
        state.devices = devices; state.updated = updated; state.configured = true; state.error = false;
        state.stale = response.headers.get('X-Cameras-Stale') === 'true';
      }
    } catch (_) { state.error = true; state.stale = true; }
    finally { clearTimeout(timeout); state.loading = false; App.emit('cameras'); }
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
