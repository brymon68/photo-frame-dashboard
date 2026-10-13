import { WEATHER_URL, parseWeather, currentWeather, hourlyWeather } from './weather-feed.js';

const App = window.App, KEY = 'hq-albuquerque-weather-v1', INTERVAL = 15 * 60 * 1000;
const native = location.origin === 'https://appassets.androidplatform.net';
let forecast = null, busy = false, lastAttempt = 0, clockDay = '', refreshAfterClockChange = false;
const state = App.weather = { updated: 0, stale: false, error: false };
const updatedFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
App.weatherNow = function () {
  const weather = currentWeather(forecast, App.now());
  if (!forecast && state.error) weather.label = 'Weather unavailable';
  return weather;
};
App.hourly = count => hourlyWeather(forecast, App.now(), count);
state.label = function () {
  if (!forecast) return state.error ? 'Weather unavailable · retrying' : 'Loading weather…';
  const d = new Date(state.updated);
  const when = updatedFormat.format(d);
  const old = Math.abs(Date.now() - state.updated) > INTERVAL * 2;
  return (state.stale || state.error || old ? 'Saved weather · ' : 'Updated ') + when;
};
function paint() { App.emit('weather'); }
state.refresh = async function () {
  if (busy) return;
  busy = true; lastAttempt = Date.now();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(native ? './weather/forecast.json' : WEATHER_URL, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Weather unavailable');
    const data = await response.json(), parsed = parseWeather(data);
    const updated = native ? Number(response.headers.get('X-Weather-Updated')) : Date.now();
    if (!Number.isFinite(updated) || updated <= 0) throw new Error('Missing update time');
    forecast = parsed; state.updated = updated;
    state.stale = native && response.headers.get('X-Weather-Stale') === 'true';
    state.error = false;
    try { localStorage.setItem(KEY, JSON.stringify({ data, updated })); } catch (e) { /* Native cache also persists. */ }
  } catch (e) { state.error = true; state.stale = !!forecast; }
  finally {
    clearTimeout(timeout); busy = false; paint();
    if (refreshAfterClockChange) { refreshAfterClockChange = false; state.refresh(); }
  }
};
App.on('ready', function () {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && Number.isFinite(saved.updated) && saved.updated > 0) {
      forecast = parseWeather(saved.data); state.updated = saved.updated; state.stale = true;
    }
  } catch (e) { /* Invalid saved data must not block a fresh request. */ }
  paint(); state.refresh();
  setInterval(state.refresh, INTERVAL);
  window.addEventListener('online', state.refresh);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && Math.abs(Date.now() - lastAttempt) >= INTERVAL) state.refresh(); });
});
App.on('minute', function () {
  const day = App.now().toDateString();
  if ((clockDay && day !== clockDay) || (lastAttempt && Math.abs(Date.now() - lastAttempt) >= INTERVAL)) {
    if (busy) refreshAfterClockChange = true;
    else state.refresh();
  }
  clockDay = day;
  paint();
});
