import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseClimate, climateTemperature, climateDetails } from '../js/climate-feed.js';

const script = readFileSync(new URL('../js/climate-sync.js', import.meta.url), 'utf8').replace(/^import .*\n/, '');
const hallway = { id: 'climate.hallway_hallway', name: 'Hallway', temperature: 73, mode: 'cool', activity: 'idle', target: 74 };
function fixture(native = true) {
  const handlers = {}, events = [], timers = [], requests = [];
  const App = { on: (name, fn) => { handlers[name] = fn; }, emit: name => events.push(name) };
  let next = async () => ({ ok: true, status: 200, json: async () => [hallway], headers: new Map([['X-Climate-Updated', String(Date.now())]]) });
  vm.runInNewContext(script, { window: { App, addEventListener() {} }, document: { addEventListener() {} },
    location: { origin: native ? 'https://appassets.androidplatform.net' : 'http://localhost' },
    parseClimate, climateTemperature, climateDetails, Date, AbortController, setTimeout, clearTimeout,
    setInterval: (fn, ms) => timers.push({ fn, ms }), fetch: async (url, options) => { requests.push({ url, options }); return next(); } });
  return { App, events, timers, requests, next: fn => { next = fn; }, async start() { handlers.ready(); await new Promise(setImmediate); } };
}

test('parses all climate devices in stable order and keeps missing temperatures distinct from zero', () => {
  const devices = parseClimate([hallway, { id: 'climate.bedroom', name: 'Bedroom', temperature: null }, { id: 'climate.attic', name: '', temperature: 0 }]);
  assert.deepEqual(devices.map(d => d.id), ['climate.attic', 'climate.bedroom', hallway.id]);
  assert.equal(climateTemperature(devices[0]), '0°');
  assert.equal(climateTemperature(devices[1]), '—');
  assert.equal(climateTemperature(hallway), '73°');
  assert.equal(climateTemperature(hallway, true), '—');
  for (const invalid of [{}, [hallway, hallway], [{ ...hallway, temperature: '73' }], [{ ...hallway, temperature: NaN }], [{ ...hallway, id: 'sensor.hall' }]]) {
    assert.throws(() => parseClimate(invalid));
  }
});

test('fetches the private native feed without credentials and refreshes every 30 seconds', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.App.climate.temperature(f.App.climate.devices[0]), '73°');
  assert.equal(f.timers[0].ms, 30000);
  assert.equal(f.requests[0].url, './climate/devices.json');
  assert.equal(f.requests[0].options.headers, undefined);
  assert.ok(f.events.includes('climate'));
});

test('failed or malformed refreshes retain names but hide stale temperatures, then recover', async () => {
  const f = fixture(); await f.start();
  for (const reply of [async () => { throw new Error('offline'); }, async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => ({ error: true }) }),
    async () => ({ ok: true, json: async () => [hallway], headers: new Map([['X-Climate-Updated', '1'], ['X-Climate-Stale', 'true']]) })]) {
    f.next(reply); await f.App.climate.refresh();
    assert.equal(f.App.climate.devices[0].name, 'Hallway');
    assert.equal(f.App.climate.temperature(f.App.climate.devices[0]), '—');
    assert.deepEqual(f.App.climate.details(f.App.climate.devices[0]), { status: 'Unavailable', target: '—', tone: '' });
  }
  f.next(async () => ({ ok: true, json: async () => [{ ...hallway, temperature: 72.5 }], headers: new Map([['X-Climate-Updated', String(Date.now())]]) }));
  await f.App.climate.refresh();
  assert.equal(f.App.climate.temperature(f.App.climate.devices[0]), '72.5°');
  assert.equal(f.App.climate.error, false);
});

test('empty discovery clears removed devices and missing configuration clears old readings', async () => {
  const f = fixture(); await f.start();
  f.next(async () => ({ ok: true, json: async () => [], headers: new Map([['X-Climate-Updated', String(Date.now())]]) }));
  await f.App.climate.refresh();
  assert.equal(f.App.climate.devices.length, 0);
  assert.equal(f.App.climate.label(), 'No climate devices');
  f.next(async () => ({ status: 404, ok: false })); await f.App.climate.refresh();
  assert.equal(f.App.climate.configured, false);
  assert.equal(f.App.climate.label(), 'Connect Home Assistant');
});

test('browser preview does not request private Home Assistant data', async () => {
  const f = fixture(false); await f.start();
  assert.equal(f.requests.length, 0);
  assert.equal(f.App.climate.temperature(), '—');
});


test('mode and actual activity remain distinct, with scalar and range targets', () => {
  assert.deepEqual(climateDetails(hallway), { status: 'Cool · Idle', target: '74°', tone: '' });
  assert.deepEqual(climateDetails({ ...hallway, activity: 'cooling' }), { status: 'Cool · Cooling', target: '74°', tone: 'cooling' });
  assert.deepEqual(climateDetails({ ...hallway, mode: 'heat', activity: 'heating', target: 72.5 }), { status: 'Heat · Heating', target: '72.5°', tone: 'heating' });
  assert.deepEqual(climateDetails({ ...hallway, mode: 'heat_cool', target: 74, targetLow: 68, targetHigh: 76 }), { status: 'Heat / Cool · Idle', target: '68°–76°', tone: '' });
  assert.deepEqual(climateDetails({ ...hallway, mode: 'off', activity: 'off', target: null }), { status: 'Off', target: '—', tone: '' });
  assert.equal(climateDetails({ ...hallway, activity: null, target: 0 }).target, '0°');
  assert.equal(climateDetails({ ...hallway, activity: null }).status, 'Cool');
});

test('missing, stale, unknown and invalid details never invent an active system or target', () => {
  assert.deepEqual(climateDetails(hallway, true), { status: 'Unavailable', target: '—', tone: '' });
  for (const mode of ['unknown', 'unavailable']) assert.deepEqual(climateDetails({ ...hallway, mode }), { status: 'Unavailable', target: '—', tone: '' });
  const old = parseClimate([{ id: 'climate.old', name: 'Old', temperature: 70 }])[0];
  assert.deepEqual(climateDetails(old), { status: 'Mode —', target: '—', tone: '' });
  assert.equal(climateDetails({ ...hallway, mode: 'heat_cooI', activity: 'constructor' }).status, 'Mode —');
  assert.equal(climateDetails({ ...hallway, mode: 'heat_cool', targetLow: 76, targetHigh: 68 }).target, '—');
  for (const patch of [{ mode: 3 }, { activity: {} }, { target: '74' }, { targetLow: NaN }, { targetHigh: Infinity }]) {
    assert.throws(() => parseClimate([{ ...hallway, ...patch }]));
  }
});

test('post-command refresh waits for an older read then fetches new state', async () => {
  const f = fixture(); await f.start();
  let release;
  f.next(() => new Promise(resolve => { release = resolve; }));
  const earlier = f.App.climate.refresh();
  const after = f.App.climate.refresh(true);
  f.next(async () => ({ ok: true, json: async () => [{ ...hallway, target: 75 }], headers: new Map([['X-Climate-Updated', String(Date.now())]]) }));
  release({ ok: true, json: async () => [hallway], headers: new Map([['X-Climate-Updated', String(Date.now())]]) });
  await Promise.all([earlier, after]);
  assert.equal(f.requests.length, 3);
  assert.equal(f.App.climate.devices[0].target, 75);
});
