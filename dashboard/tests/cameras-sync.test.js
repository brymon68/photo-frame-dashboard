import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseCameras, cameraAvailable, doorbellCamera } from '../js/cameras-feed.js';

const script = readFileSync(new URL('../js/cameras-sync.js', import.meta.url), 'utf8').replace(/^import .*\n/, '');
const porch = { id: 'camera.porch', name: 'Porch', available: true };
function fixture(native = true) {
  const handlers = {}, events = [], timers = [], requests = [];
  let now = 100000;
  class Clock extends Date { static now() { return now; } }
  const App = { on: (name, fn) => { handlers[name] = fn; }, emit: name => events.push(name) };
  let next = async () => ({ ok: true, status: 200, json: async () => [porch], headers: new Map([['X-Cameras-Updated', String(now)]]) });
  vm.runInNewContext(script, { window: { App, addEventListener() {} }, document: { addEventListener() {} },
    location: { origin: native ? 'https://appassets.androidplatform.net' : 'http://localhost' },
    parseCameras, cameraAvailable, doorbellCamera, Date: Clock, AbortController, setTimeout, clearTimeout,
    setInterval: (fn, ms) => timers.push({ fn, ms }), fetch: async (url, options) => { requests.push({ url, options }); return next(); } });
  return { App, events, timers, requests, next: fn => { next = fn; }, advance: ms => { now += ms; }, async start() { handlers.ready(); await new Promise(setImmediate); } };
}

test('discovery accepts named cameras only, strips private fields and uses stable ordering', () => {
  const devices = parseCameras([{ ...porch, access_token: 'secret', stream: 'http://private' },
    { id: 'camera.a', name: '  ', available: false }, { id: 'camera.driveway', name: 'Driveway', available: true }]);
  assert.deepEqual(devices.map(d => d.name), ['a', 'Driveway', 'Porch']);
  assert.deepEqual(devices[2], porch);
  for (const invalid of [{}, [porch, porch], [{ ...porch, available: 'yes' }], [{ ...porch, id: '../camera.porch' }],
    [{ ...porch, id: 'sensor.porch' }], [{ ...porch, name: null }]]) assert.throws(() => parseCameras(invalid));
});

test('doorbell shortcut selects one exact display name regardless of entity ID or list order', () => {
  const nearMatches = [porch,
    { id: 'camera.doorbell', name: 'Driveway', available: true },
    { id: 'camera.front', name: 'Front Doorbell', available: true },
    { id: 'camera.snapshot', name: 'Doorbell Snapshot', available: true }];
  for (const name of ['Doorbell', 'doorbell camera', '  DOORBELL  Camera  ']) {
    const doorbell = { id: 'camera.synthetic_entry', name, available: true };
    assert.equal(doorbellCamera([...nearMatches, doorbell]), doorbell);
    assert.equal(doorbellCamera([doorbell, ...nearMatches]), doorbell);
  }
  assert.equal(doorbellCamera(nearMatches), null);
  assert.equal(doorbellCamera([]), null);
  assert.equal(doorbellCamera([
    { id: 'camera.synthetic_one', name: 'Doorbell', available: true },
    { id: 'camera.synthetic_two', name: 'Doorbell Camera', available: false }
  ]), null);
});

test('discovered doorbell remains subject to camera freshness and availability checks', async () => {
  const f = fixture(), doorbell = { id: 'camera.synthetic_entry', name: 'Doorbell', available: true };
  f.next(async () => ({ ok: true, json: async () => [porch, doorbell], headers: new Map([['X-Cameras-Updated', '100000']]) }));
  await f.start();
  assert.deepEqual(f.App.cameras.doorbell(), doorbell);
  assert.equal(f.App.cameras.canView(f.App.cameras.doorbell()), true);
  f.advance(60001);
  assert.deepEqual(f.App.cameras.doorbell(), doorbell);
  assert.equal(f.App.cameras.canView(f.App.cameras.doorbell()), false);
  f.next(async () => ({ ok: true, json: async () => [{ ...doorbell, available: false }], headers: new Map([['X-Cameras-Updated', '160001']]) }));
  await f.App.cameras.refresh();
  assert.equal(f.App.cameras.doorbell().available, false);
  assert.equal(f.App.cameras.canView(f.App.cameras.doorbell()), false);
  f.next(async () => ({ ok: true, json: async () => [porch], headers: new Map([['X-Cameras-Updated', '160001']]) }));
  await f.App.cameras.refresh();
  assert.equal(f.App.cameras.doorbell(), null);
  assert.equal(f.App.cameras.canView(f.App.cameras.doorbell()), false);
  assert.ok(f.requests.every(request => request.url === './cameras/devices.json'));
});

test('native discovery never opens a camera stream and availability expires after two refresh periods', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.App.cameras.canView(f.App.cameras.devices[0]), true);
  assert.equal(f.timers[0].ms, 30000);
  assert.deepEqual(f.requests.map(r => r.url), ['./cameras/devices.json']);
  assert.equal(f.requests[0].options.headers, undefined);
  f.advance(60001);
  assert.equal(f.App.cameras.canView(porch), false);
});

test('failed and stale discovery keeps names but prevents starting streams, then recovers', async () => {
  const f = fixture(); await f.start();
  for (const reply of [async () => { throw new Error('offline'); }, async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => ({ error: true }) }),
    async () => ({ ok: true, json: async () => [porch], headers: new Map([['X-Cameras-Updated', '100000'], ['X-Cameras-Stale', 'true']]) })]) {
    f.next(reply); await f.App.cameras.refresh();
    assert.equal(f.App.cameras.devices[0].name, 'Porch');
    assert.equal(f.App.cameras.canView(porch), false);
  }
  f.next(async () => ({ ok: true, json: async () => [porch], headers: new Map([['X-Cameras-Updated', '100000']]) }));
  await f.App.cameras.refresh();
  assert.equal(f.App.cameras.canView(porch), true);
});

test('empty and missing setup clear removed cameras; browser previews remain disconnected', async () => {
  const f = fixture(); await f.start();
  f.next(async () => ({ ok: true, json: async () => [], headers: new Map([['X-Cameras-Updated', '100000']]) }));
  await f.App.cameras.refresh();
  assert.equal(f.App.cameras.devices.length, 0);
  assert.equal(f.App.cameras.label(), 'No cameras found in Home Assistant.');
  f.next(async () => ({ ok: false, status: 404 })); await f.App.cameras.refresh();
  assert.equal(f.App.cameras.configured, false);
  const preview = fixture(false); await preview.start();
  assert.equal(preview.requests.length, 0);
  assert.equal(preview.App.cameras.canView(porch), false);
});
