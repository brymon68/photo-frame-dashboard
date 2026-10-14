import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseLights, lightStatus, lightCounts } from '../js/lights-feed.js';

const script = readFileSync(new URL('../js/lights-sync.js', import.meta.url), 'utf8').replace(/^import .*\n/, '');
const data = { rooms: [{ id: 'kitchen', name: 'Kitchen' }], lights: [
  { id: 'light.lamp', name: 'Lamp', room: 'kitchen', state: 'on' },
  { id: 'switch.ceiling_lights', name: 'Ceiling', room: null, state: 'off' }
] };
function fixture(native = true) {
  const handlers = {}, events = [], timers = [], requests = [];
  const App = { on: (name, fn) => { handlers[name] = fn; }, emit: name => events.push(name) };
  const reply = (body = data, stale = false, updated = Date.now()) => ({ ok: true, status: 200, json: async () => body,
    headers: new Map([['X-Lights-Updated', String(updated)], ['X-Lights-Stale', String(stale)]]) });
  let next = async () => reply();
  vm.runInNewContext(script, { window: { App, addEventListener() {} }, document: { addEventListener() {} },
    location: { origin: native ? 'https://appassets.androidplatform.net' : 'http://localhost' },
    parseLights, lightStatus, lightCounts, Date, AbortController, setTimeout, clearTimeout,
    setInterval: (fn, ms) => timers.push({ fn, ms }), fetch: async (url, options) => { requests.push({ url, options }); return next(); } });
  return { App, events, timers, requests, reply, next: fn => { next = fn; }, async start() { handlers.ready(); await new Promise(setImmediate); } };
}

test('rooms retain stable ids, empty rooms and unassigned lights with sorted names', () => {
  const parsed = parseLights({ ...data, rooms: [...data.rooms, { id: 'attic', name: 'Attic' }],
    lights: [...data.lights, { id: 'light.lost', name: 'Lost', room: 'deleted', state: 'unknown' }] });
  assert.deepEqual(parsed.rooms.map(r => r.name), ['Attic', 'Kitchen', 'Unassigned']);
  assert.equal(parsed.lights.find(l => l.id === 'light.lamp').room, 'kitchen');
  assert.equal(parsed.lights.find(l => l.id === 'light.lost').room, null);
  assert.equal(lightStatus(parsed.lights.find(l => l.id === 'light.lost')), 'Unavailable');
  assert.equal(lightCounts(parsed.lights).label, '1 on · 1 unavailable');
  assert.equal(lightCounts(parsed.lights, true).label, '3 unavailable');
  assert.equal(lightCounts([]).label, 'No lights');
  assert.equal(lightCounts([{ state: 'off' }]).label, 'All off');
  for (const invalid of [{}, { rooms: [], lights: null }, { ...data, rooms: [...data.rooms, ...data.rooms] },
    { ...data, lights: [...data.lights, data.lights[0]] },
    ...[{ id: 'sensor.lamp' }, { state: 'banana' }, { room: {} }, { name: 5 }].map(patch => ({ ...data, lights: [{ ...data.lights[0], ...patch }] }))]) {
    assert.throws(() => parseLights(invalid));
  }
});

test('native feed refreshes every 30 seconds without browser credentials or service calls', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.App.lights.status(f.App.lights.lights.find(l => l.id === 'light.lamp')), 'On');
  assert.equal(f.App.lights.summary().value, 1);
  assert.equal(f.timers[0].ms, 30000);
  assert.equal(f.requests[0].url, './lights/rooms.json');
  assert.equal(f.requests[0].options.headers, undefined);
  assert.equal(f.requests[0].options.method, undefined);
  assert.ok(f.events.includes('lights'));
});

test('failed, stale, expired and malformed updates retain names without displaying old states', async () => {
  const f = fixture(); await f.start();
  for (const next of [async () => { throw new Error('offline'); }, async () => ({ ok: false, status: 503 }),
    async () => f.reply({}), async () => f.reply(data, true), async () => f.reply(data, false, 1),
    async () => f.reply(data, false, Date.now() + 120000)]) {
    f.next(next); await f.App.lights.refresh();
    assert.equal(f.App.lights.rooms[0].name, 'Kitchen');
    assert.equal(f.App.lights.status(f.App.lights.lights[0]), 'Unavailable');
    assert.equal(f.App.lights.summary().value, '—');
  }
  f.next(async () => f.reply()); await f.App.lights.refresh();
  assert.equal(f.App.lights.summary().value, 1);
  assert.equal(f.App.lights.error, false);
});

test('successful empty discovery clears old lights and config removal clears rooms', async () => {
  const f = fixture(); await f.start();
  f.next(async () => f.reply({ rooms: data.rooms, lights: [] })); await f.App.lights.refresh();
  assert.equal(f.App.lights.lights.length, 0);
  assert.equal(f.App.lights.rooms.length, 1);
  f.next(async () => ({ status: 404, ok: false })); await f.App.lights.refresh();
  assert.equal(f.App.lights.rooms.length, 0);
  assert.equal(f.App.lights.label(), 'Connect Home Assistant');
  assert.equal(f.App.lights.summary().value, '—');
});

test('browser previews never request private HA data or substitute sample rooms', async () => {
  const f = fixture(false); await f.start();
  assert.equal(f.requests.length, 0);
  assert.equal(f.App.lights.rooms.length, 0);
  assert.equal(f.App.lights.label(), 'Connect Home Assistant');
});
