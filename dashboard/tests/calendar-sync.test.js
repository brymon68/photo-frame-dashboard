import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseCalendar, expandCalendar } from '../js/calendar-feed.js';

const script = readFileSync(new URL('../js/calendar-sync.js', import.meta.url), 'utf8').replace(/^import .*\n/, '');
const feed = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:actual\nDTSTART:20261013T150000Z\nDTEND:20261013T160000Z\nSUMMARY:Actual event\nEND:VEVENT\nEND:VCALENDAR\n';
const KEY = 'hq-google-calendar-v1';

function fixture({ saved, configured = true, origin = 'https://appassets.androidplatform.net' } = {}) {
  const handlers = {}, timers = [], storage = new Map();
  if (saved) storage.set(KEY, JSON.stringify(saved));
  const dataContext = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../js/data.js', import.meta.url), 'utf8'), dataContext);
  const D = dataContext.window.DATA;
  D.events = [{ id: 'sample' }]; D.busyExtras = [{ id: 'sample-busy' }];
  const App = {
    on: (name, callback) => { handlers[name] = callback; }, emit() {}, rerender() {},
    now: () => new Date('2026-10-12T12:00:00-06:00'),
    dayStart: d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; },
    addDays: (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; },
    sameDay: (a, b) => a.toDateString() === b.toDateString(),
    fmt: { time: d => d.toTimeString(), monthShort: () => 'Oct' }
  };
  let next = async () => ({ ok: true, text: async () => feed, headers: new Map([['X-Calendar-Updated', '1791914400000'], ['X-Calendar-Stale', 'false']]) });
  vm.runInNewContext(script, {
    window: { App, DATA: D, addEventListener() {} }, location: { origin },
    document: { addEventListener() {} }, parseCalendar, expandCalendar, Date,
    setInterval: (fn, ms) => timers.push({ fn, ms }),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    fetch: async url => url.endsWith('status.json') ? { ok: true, json: async () => ({ configured }) } : next()
  });
  return { App, D, storage, timers, start: () => handlers.ready(), minute: date => handlers.minute(date), next: fn => { next = fn; } };
}

test('a configured frame replaces sample events and persists good downloads', async () => {
  const f = fixture();
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.App.calendar.readOnly, true);
  assert.equal(f.D.events.length, 1);
  assert.equal(f.D.events[0].title, 'Actual event');
  assert.equal(f.D.people.length, 1);
  assert.equal(f.D.people[0].name, 'Family');
  assert.equal(f.D.events[0].people.join(','), 'family');
  assert.ok(f.D.devices.every(device => !/Wes|Claudia|Buzzsaw|Skidmark/.test(device.name)));
  assert.equal(f.D.busyExtras.length, 0);
  assert.equal(f.timers[0].ms, 300000);
  assert.equal(JSON.parse(f.storage.get(KEY)).text, feed);
});

test('failed and malformed refreshes preserve the last good calendar', async () => {
  const f = fixture();
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  const snapshot = f.D.events;
  f.next(async () => { throw new Error('Offline'); });
  await f.App.calendar.refresh();
  assert.equal(f.D.events, snapshot);
  assert.equal(f.App.calendar.stale, true);
  assert.equal(f.App.calendar.error, true);
  f.next(async () => ({ ok: true, text: async () => 'incomplete', headers: new Map([['X-Calendar-Updated', '1791914500000']]) }));
  await f.App.calendar.refresh();
  assert.equal(f.D.events, snapshot);
  assert.equal(JSON.parse(f.storage.get(KEY)).text, feed);
});

test('offline startup uses cached events without returning to demo data', async () => {
  const f = fixture({ saved: { text: feed, updated: 1791914400000 } });
  f.next(async () => { throw new Error('Offline'); });
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.D.events[0].title, 'Actual event');
  assert.equal(f.App.calendar.stale, true);
});

test('an offline frame without a cache shows an unavailable calendar, never sample appointments', async () => {
  const f = fixture();
  f.next(async () => ({ ok: false }));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.D.events.length, 0);
  assert.equal(f.App.calendar.updated, 0);
  assert.equal(f.App.calendar.error, true);
});

test('an empty successful calendar removes events that were deleted in Google', async () => {
  const f = fixture();
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  f.next(async () => ({ ok: true, text: async () => 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n',
    headers: new Map([['X-Calendar-Updated', '1791914500000'], ['X-Calendar-Stale', 'false']]) }));
  await f.App.calendar.refresh();
  assert.equal(f.D.events.length, 0);
  assert.equal(f.App.calendar.error, false);
});

test('hosted previews and frames without a feed retain the sample behavior', async () => {
  for (const options of [{ configured: false }, { origin: 'https://example.com' }]) {
    const f = fixture(options);
    await f.start();
    assert.equal(f.App.calendar.readOnly, false);
    assert.equal(f.D.events[0].id, 'sample');
    assert.equal(f.timers.length, 0);
  }
});

test('a reset boot clock recovering through network time immediately rebuilds the real calendar', async () => {
  const f = fixture({ saved: { text: feed, updated: 1791914400000 } });
  f.App.now = () => new Date('2009-01-01T00:00:00-07:00');
  f.next(async () => { throw new Error('Offline'); });
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.D.events.length, 0);
  f.App.now = () => new Date('2026-10-12T12:00:00-06:00');
  f.minute(f.App.now());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.D.events[0].title, 'Actual event');
  assert.equal(f.App.calendar.stale, true);
});
