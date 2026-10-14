import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { climateModeLabel, climateTargets, parseClimate } from '../js/climate-feed.js';
const script = readFileSync(new URL('../js/home-controls.js', import.meta.url), 'utf8').replace(/^import .*\n/, '');
function fixture(native = true) {
  const events = [], calls = [], toasts = [], refreshes = [];
  const light = { id: 'switch.room_lights', state: 'off' };
  let response = async () => { light.state = 'on'; return { ok: true, json: async () => ({ ok: true }) }; };
  const App = {
    emit: name => events.push(name), toast: (message, options) => toasts.push({ message, options }),
    lights: { lights: [light], status: d => d.state === 'unavailable' ? 'Unavailable' : d.state === 'on' ? 'On' : 'Off', refresh: async force => refreshes.push(force) },
    climate: { devices: [], details: d => ({ status: d.mode === 'unavailable' ? 'Unavailable' : 'Heat' }), refresh: async force => refreshes.push(force) }
  };
  vm.runInNewContext(script, { window: { App }, location: { origin: native ? 'https://appassets.androidplatform.net' : 'http://localhost' },
    climateModeLabel, climateTargets, AbortController, setTimeout: (fn, delay) => setTimeout(fn, delay === 1500 ? 0 : delay), clearTimeout,
    fetch: async (url, options) => { calls.push({ url, options }); return response(); } });
  return { App, light, events, calls, toasts, refreshes, respond: fn => { response = fn; } };
}

test('a light tap sends a single explicit service action then refreshes actual state', async () => {
  const f = fixture();
  await f.App.homeControls.toggleLight(f.light.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].options.headers['X-HomeHQ-Command']), { entity: f.light.id, action: 'turn_on' });
  assert.equal(f.light.state, 'on');
  assert.deepEqual(f.refreshes, [true]);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.App.homeControls.pending[f.light.id], undefined);
});

test('double taps are ignored while pending, with no optimistic state mutation', async () => {
  const f = fixture(); let finish;
  f.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.App.homeControls.toggleLight(f.light.id);
  assert.equal(f.App.homeControls.pending[f.light.id], true);
  assert.equal(f.light.state, 'off');
  await f.App.homeControls.toggleLight(f.light.id);
  assert.equal(f.calls.length, 1);
  f.light.state = 'on'; finish({ ok: true, json: async () => ({ ok: true }) });
  await pending;
  assert.equal(f.App.homeControls.pending[f.light.id], undefined);
});

test('unavailable devices and browser previews never issue commands', async () => {
  for (const f of [fixture(false), fixture()]) {
    if (f.App.homeControls.canLight(f.light)) f.light.state = 'unavailable';
    await f.App.homeControls.toggleLight(f.light.id);
    assert.equal(f.calls.length, 0);
  }
});

test('failed or ambiguous writes refresh state, clear pending and do not retry writes', async () => {
  for (const response of [async () => { throw new Error('timeout'); }, async () => ({ ok: false, json: async () => ({ ok: false, code: 'changed' }) })]) {
    const f = fixture(); f.respond(response);
    assert.equal(await f.App.homeControls.toggleLight(f.light.id), false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.light.state, 'off');
    assert.deepEqual(f.refreshes, [true]);
    assert.equal(f.toasts.length, 1);
    assert.equal(f.App.homeControls.pending[f.light.id], undefined);
  }
});

test('accepted but unreported changes stay truthful and refresh again', async () => {
  const f = fixture(); f.respond(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  await f.App.homeControls.toggleLight(f.light.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.light.state, 'off');
  assert.deepEqual(f.refreshes, [true, true]);
  assert.match(f.toasts[0].message, /waiting for the device/);
});

test('capabilities select scalar or dual setpoints and reject malformed capability data', () => {
  const device = { id: 'climate.room', name: 'Room', temperature: 70, mode: 'heat', min: 50, max: 90, features: 3, modes: ['heat', 'off'] };
  assert.deepEqual(climateTargets(device), ['target']);
  assert.deepEqual(climateTargets({ ...device, mode: 'heat_cool' }), ['targetLow', 'targetHigh']);
  assert.deepEqual(climateTargets({ ...device, mode: 'off' }), []);
  assert.deepEqual(climateTargets({ ...device, mode: 'heat_cool', features: 1 }), []);
  assert.deepEqual(climateTargets({ ...device, features: 0 }), []);
  assert.deepEqual(climateTargets({ ...device, min: null }), []);
  assert.deepEqual(parseClimate([device])[0].modes, ['heat', 'off']);
  assert.throws(() => parseClimate([{ ...device, modes: ['bogus'] }]));
  assert.throws(() => parseClimate([{ ...device, features: 1.5 }]));
});
