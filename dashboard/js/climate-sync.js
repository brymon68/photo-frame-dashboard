import { parseClimate, climateTemperature, climateDetails } from './climate-feed.js';

const App = window.App, INTERVAL = 30000;
const native = location.origin === 'https://appassets.androidplatform.net';
const state = App.climate = { devices: [], configured: native, loading: native, stale: false, error: false, updated: 0 };
let busy = null, lastAttempt = 0;
const isStale = () => state.stale || state.error || !state.updated || Date.now() < state.updated || Date.now() - state.updated > INTERVAL * 2;
state.temperature = device => climateTemperature(device, isStale());
state.details = device => climateDetails(device, isStale());
state.label = () => !state.configured ? 'Connect Home Assistant' : state.loading ? 'Loading climate…'
  : state.error || state.stale ? 'Climate unavailable' : 'No climate devices';
state.refresh = async function (afterCommand = false) {
  if (!native) return;
  if (busy) {
    await busy;
    if (afterCommand === true) return state.refresh();
    return;
  }
  lastAttempt = Date.now();
  busy = (async () => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('./climate/devices.json', { cache: 'no-store', signal: controller.signal });
      if (response.status === 404) {
        state.configured = false; state.devices = []; state.updated = 0; state.error = false; state.stale = false;
      } else {
        if (!response.ok) throw new Error('Climate unavailable');
        const devices = parseClimate(await response.json());
        const updated = Number(response.headers.get('X-Climate-Updated'));
        if (!Number.isFinite(updated) || updated <= 0) throw new Error('Missing climate timestamp');
        state.devices = devices; state.updated = updated; state.configured = true; state.error = false;
        state.stale = response.headers.get('X-Climate-Stale') === 'true';
      }
    } catch (e) { state.error = true; state.stale = true; }
    finally { clearTimeout(timeout); state.loading = false; App.emit('climate'); }
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
