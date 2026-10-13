import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { WEATHER_URL, parseWeather, currentWeather, hourlyWeather } from '../js/weather-feed.js';

const script = readFileSync(new URL('../js/weather-sync.js', import.meta.url), 'utf8').replace(/^import .*\n/, '');
const KEY = 'hq-albuquerque-weather-v1';
const stamp = +new Date('2026-10-12T12:00:00-06:00');
function data() {
  return { timezone: 'America/Denver', current_units: { temperature_2m: '°F' },
    current: { time: stamp / 1000, temperature_2m: 72, apparent_temperature: 70, relative_humidity_2m: 20, wind_speed_10m: 6, weather_code: 0, is_day: 1 },
    hourly: { time: [stamp / 1000], temperature_2m: [72], precipitation_probability: [0], weather_code: [0], is_day: [1] },
    daily: { time: [stamp / 1000], temperature_2m_max: [78], temperature_2m_min: [50] }
  };
}
function fixture({ saved, native = true } = {}) {
  const handlers = {}, storage = new Map(), timers = [], requests = [];
  let now = stamp;
  class Clock extends Date { static now() { return now; } }
  if (saved) storage.set(KEY, JSON.stringify(saved));
  const App = { on: (name, fn) => { handlers[name] = fn; }, emit() {}, now: () => new Date(now) };
  let next = async () => ({ ok: true, json: async () => data(), headers: new Map([['X-Weather-Updated', String(now)], ['X-Weather-Stale', 'false']]) });
  vm.runInNewContext(script, { window: { App, addEventListener() {} }, location: { origin: native ? 'https://appassets.androidplatform.net' : 'http://localhost' },
    document: { addEventListener() {} }, localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    WEATHER_URL, parseWeather, currentWeather, hourlyWeather, Date: Clock, Intl, AbortController, setTimeout, clearTimeout,
    setInterval: (fn, ms) => timers.push({ fn, ms }), fetch: async url => { requests.push(url); return next(); } });
  return { App, storage, timers, requests, next: fn => { next = fn; }, async start() { handlers.ready(); await new Promise(setImmediate); },
    async minute(time) { now = time; handlers.minute(); await new Promise(setImmediate); } };
}

test('native and hosted weather refresh and cache successful data', async () => {
  for (const native of [true, false]) {
    const f = fixture({ native }); await f.start();
    assert.equal(f.App.weatherNow().temp, 72);
    assert.equal(f.requests[0], native ? './weather/forecast.json' : WEATHER_URL);
    assert.equal(f.timers[0].ms, 900000);
    assert.equal(JSON.parse(f.storage.get(KEY)).data.current.temperature_2m, 72);
    assert.match(f.App.weather.label(), /^Updated/);
  }
});

test('offline startup and malformed refreshes preserve saved weather with its timestamp', async () => {
  const f = fixture({ saved: { data: data(), updated: stamp } });
  f.next(async () => { throw new Error('Offline'); }); await f.start();
  assert.equal(f.App.weatherNow().temp, 72);
  assert.equal(f.App.weather.stale, true);
  assert.match(f.App.weather.label(), /^Saved weather/);
  f.next(async () => ({ ok: true, json: async () => ({ error: true }) }));
  await f.App.weather.refresh();
  assert.equal(f.App.weatherNow().temp, 72);
  assert.equal(JSON.parse(f.storage.get(KEY)).updated, stamp);
});

test('first launch offline has no invented weather and recovers on refresh', async () => {
  const f = fixture(); f.next(async () => { throw new Error('Offline'); }); await f.start();
  assert.equal(f.App.weatherNow().temp, '—'); assert.equal(f.App.hourly(7).length, 0);
  assert.match(f.App.weather.label(), /unavailable/);
  f.next(async () => ({ ok: true, json: async () => data(), headers: new Map([['X-Weather-Updated', String(stamp)]]) }));
  await f.App.weather.refresh(); assert.equal(f.App.weatherNow().temp, 72); assert.equal(f.App.weather.error, false);
});

test('a reset clock jumping forward refreshes immediately', async () => {
  const f = fixture(); await f.start(); await f.minute(stamp); await f.minute(stamp + 86400000);
  assert.equal(f.requests.length, 2);
});
