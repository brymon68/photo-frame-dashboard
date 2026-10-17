import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseCalendar, expandCalendar } from '../js/calendar-feed.js';

const script = readFileSync(new URL('../js/calendar-sync.js', import.meta.url), 'utf8').replace(/^import .*\n/, '');
const feed = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:actual\nDTSTART:20261013T150000Z\nDTEND:20261013T160000Z\nSUMMARY:Actual event\nEND:VEVENT\nEND:VCALENDAR\n';
const KEY = 'hq-google-calendar-v1';

const sources = [
  { id: 'family', name: 'Family', color: '#111111' },
  { id: 'personal', name: 'Bryce', color: '#2D5BFF' }
];

function calendarResponse(text = feed, updated = 1791914400000, stale = false, availability) {
  const headers = new Map([['X-Calendar-Updated', String(updated)], ['X-Calendar-Stale', String(stale)]]);
  if (availability) {
    headers.set('X-Calendar-Revision', availability.revision);
    headers.set('X-Calendar-Range-Start', String(availability.rangeStart));
    headers.set('X-Calendar-Range-End', String(availability.rangeEnd));
  }
  return { ok: true, text: async () => text, headers };
}

function fixture({ saved, savedSources = {}, configured = true, sources, origin = 'https://appassets.androidplatform.net' } = {}) {
  const handlers = {}, timers = [], storage = new Map(), requests = [];
  if (saved) storage.set(KEY, JSON.stringify(saved));
  for (const [id, value] of Object.entries(savedSources)) storage.set(KEY + '-' + id, JSON.stringify(value));
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
  let next = async () => calendarResponse();
  let status = { configured, sources };
  vm.runInNewContext(script, {
    window: { App, DATA: D, addEventListener() {} }, location: { origin },
    document: { addEventListener() {} }, parseCalendar, expandCalendar, Date,
    setInterval: (fn, ms) => timers.push({ fn, ms }),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    fetch: async url => {
      requests.push(url);
      return url.endsWith('status.json') ? { ok: true, json: async () => status } : next(url);
    }
  });
  return { App, D, storage, timers, requests, start: () => handlers.ready(), minute: date => handlers.minute(date), next: fn => { next = fn; }, status: value => { status = value; } };
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
  assert.equal(f.D.events[0].calendarId, 'family');
  assert.match(f.D.events[0].id, /^family:g-/);
  assert.equal(f.D.devices.find(device => device.id === 'u-maya').name, 'Bedroom Lamp');
  assert.equal(f.D.devices.find(device => device.id === 'u-otto').name, 'Nightlight');
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

test('calendar navigation expands cached dates in both directions and keeps them on refresh', async () => {
  const f = fixture();
  const source = feed.replace('END:VCALENDAR',
    'BEGIN:VEVENT\nUID:future\nDTSTART:20281013T150000Z\nDTEND:20281013T160000Z\nSUMMARY:Future event\nEND:VEVENT\n' +
    'BEGIN:VEVENT\nUID:past\nDTSTART:20241013T150000Z\nDTEND:20241013T160000Z\nSUMMARY:Past event\nEND:VEVENT\nEND:VCALENDAR');
  f.next(async () => ({ ok: true, text: async () => source,
    headers: new Map([['X-Calendar-Updated', '1791914400000'], ['X-Calendar-Stale', 'false']]) }));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(f.D.events, event => event.title), ['Actual event']);

  f.App.calendar.cover(new Date('2028-10-12T00:00:00-06:00'));
  assert.deepEqual(Array.from(f.D.events, event => event.title), ['Actual event', 'Future event']);
  f.App.calendar.cover(new Date('2024-10-12T00:00:00-06:00'));
  assert.deepEqual(Array.from(f.D.events, event => event.title), ['Past event', 'Actual event', 'Future event']);

  const snapshot = f.D.events;
  await f.App.calendar.refresh();
  assert.equal(f.D.events, snapshot);
  f.next(async () => ({ ok: true, text: async () => source.replace('Actual event', 'Renamed event'),
    headers: new Map([['X-Calendar-Updated', '1791914500000'], ['X-Calendar-Stale', 'false']]) }));
  await f.App.calendar.refresh();
  assert.deepEqual(Array.from(f.D.events, event => event.title), ['Past event', 'Renamed event', 'Future event']);
});

test('separate sources keep colliding Google identifiers distinct and cache independently', async () => {
  const personalFeed = feed.replace('Actual event', 'Personal event');
  const f = fixture({ sources });
  f.next(async url => calendarResponse(url.endsWith('personal.ics') ? personalFeed : feed));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(f.D.events, event => event.title), ['Actual event', 'Personal event']);
  assert.deepEqual(Array.from(f.D.events, event => event.calendarId), ['family', 'personal']);
  assert.deepEqual(Array.from(f.D.events, event => event.people.join(',')), ['family', 'personal']);
  assert.equal(new Set(f.D.events.map(event => event.id)).size, 2);
  assert.deepEqual(Array.from(f.D.people, person => person.name), ['Family', 'Bryce']);
  assert.deepEqual(Array.from(f.D.ALL), ['family', 'personal']);
  assert.equal(f.App.calendar.sources[1].rgb, '45 91 255');
  assert.equal(f.App.calendar.sources[1].ink, '#FFFFFF');
  assert.equal(JSON.parse(f.storage.get(KEY)).text, feed);
  assert.equal(JSON.parse(f.storage.get(KEY + '-personal')).text, personalFeed);
  assert.ok(f.requests.includes('./calendar/feed.ics'));
  assert.ok(f.requests.includes('./calendar/personal.ics'));
  assert.match(f.App.calendar.label(), /^Updated /);
});

test('a failing source preserves its saved events while the other source refreshes', async () => {
  const f = fixture({ sources });
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  f.next(async url => {
    if (url.endsWith('personal.ics')) throw new Error('Offline');
    return calendarResponse(feed.replace('Actual event', 'Fresh family event'), 1791914500000);
  });
  await f.App.calendar.refresh();
  assert.deepEqual(Array.from(f.D.events, event => event.title), ['Fresh family event', 'Actual event']);
  assert.equal(f.App.calendar.sources[0].stale, false);
  assert.equal(f.App.calendar.sources[0].error, false);
  assert.equal(f.App.calendar.sources[1].stale, true);
  assert.equal(f.App.calendar.sources[1].error, true);
  assert.equal(f.App.calendar.updated, 1791914400000);
  assert.equal(f.App.calendar.error, true);
  assert.equal(f.App.calendar.stale, true);
  assert.equal(f.App.calendar.label(), 'Bryce saved · retrying');
  assert.equal(JSON.parse(f.storage.get(KEY + '-personal')).text, feed);
});

test('an unavailable second calendar never hides a healthy calendar or reports both updated', async () => {
  const f = fixture({ sources });
  f.next(async url => url.endsWith('personal.ics') ? { ok: false } : calendarResponse());
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.D.events.length, 1);
  assert.equal(f.D.events[0].calendarId, 'family');
  assert.equal(f.App.calendar.updated, 1791914400000);
  assert.equal(f.App.calendar.label(), 'Bryce unavailable · retrying');
  f.next(async url => calendarResponse(url.endsWith('personal.ics') ? feed.replace('Actual event', 'Recovered event') : feed));
  await f.App.calendar.refresh();
  assert.equal(f.D.events.length, 2);
  assert.equal(f.App.calendar.error, false);
  assert.match(f.App.calendar.label(), /^Updated /);
});

test('empty and malformed source responses remain isolated', async () => {
  const f = fixture({ sources });
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  f.next(async url => calendarResponse(url.endsWith('personal.ics') ? 'incomplete' : 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n'));
  await f.App.calendar.refresh();
  assert.equal(f.D.events.length, 1);
  assert.equal(f.D.events[0].calendarId, 'personal');
  assert.equal(f.App.calendar.sources[0].error, false);
  assert.equal(f.App.calendar.sources[1].error, true);
});

test('offline startup restores only the configured calendars and source removal clears their events', async () => {
  const f = fixture({
    sources,
    saved: { text: feed, updated: 1791914400000 },
    savedSources: {
      personal: { text: feed.replace('Actual event', 'Saved personal'), updated: 1791914500000 },
      removed: { text: feed.replace('Actual event', 'Removed calendar'), updated: 1791914500000 }
    }
  });
  f.next(async () => { throw new Error('Offline'); });
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(f.D.events, event => event.title), ['Actual event', 'Saved personal']);
  f.status({ configured: true, sources: [sources[0]] });
  await f.App.calendar.refresh();
  assert.deepEqual(Array.from(f.D.events, event => event.title), ['Actual event']);
  assert.deepEqual(Array.from(f.D.ALL), ['family']);
  f.status({ configured: false });
  await f.App.calendar.refresh();
  assert.equal(f.D.events.length, 0);
  assert.equal(f.App.calendar.label(), 'No calendars configured');
  assert.equal(f.App.calendar.readOnly, true);
});

test('source metadata cannot supply fetch URLs or unsafe CSS values', async () => {
  const f = fixture({ sources: [
    sources[0],
    { id: '../external', name: 'Unsafe path', color: '#000000' },
    { id: 'feed', name: 'Reserved', color: '#000000' },
    { id: 'personal', name: '  Bryce\u0000' + 'a'.repeat(50), color: 'red;position:fixed', url: 'https://example.com/private' },
    { id: 'personal', name: 'Duplicate', color: '#FFFFFF' },
    { id: 'bright', name: '', color: '#ffffff' }
  ] });
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(f.D.ALL), ['family', 'personal', 'bright']);
  assert.equal(f.App.calendar.sources[1].name.length, 40);
  assert.equal(f.App.calendar.sources[1].name.includes('\u0000'), false);
  assert.equal(f.App.calendar.sources[1].color, '#2D5BFF');
  assert.equal(f.App.calendar.sources[1].rgb, '45 91 255');
  assert.equal(f.App.calendar.sources[2].name, 'Calendar');
  assert.equal(f.App.calendar.sources[2].ink, '#111111');
  assert.ok(f.requests.every(url => /^\.\/calendar\/(status\.json|feed\.ics|personal\.ics|bright\.ics)$/.test(url)));
});

test('replacing a source revision discards the old calendar even when the replacement is offline', async () => {
  const initial = [sources[0], { ...sources[1], revision: 'first' }];
  const f = fixture({ sources: initial });
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(f.storage.get(KEY + '-personal')).revision, 'first');
  f.status({ configured: true, sources: [sources[0], { ...sources[1], revision: 'second' }] });
  f.next(async url => url.endsWith('personal.ics') ? { ok: false } : calendarResponse());
  await f.App.calendar.refresh();
  assert.equal(f.D.events.length, 1);
  assert.equal(f.D.events[0].calendarId, 'family');
  assert.equal(f.App.calendar.sources[1].updated, 0);
  assert.equal(f.App.calendar.label(), 'Bryce unavailable · retrying');
});

test('legacy Family cache survives migration while mismatched personal revisions do not', async () => {
  const f = fixture({
    sources: sources.map(source => ({ ...source, revision: 'new' })),
    saved: { text: feed, updated: 1791914400000 },
    savedSources: { personal: { text: feed, updated: 1791914400000, revision: 'old' } }
  });
  f.next(async () => { throw new Error('Offline'); });
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.D.events.length, 1);
  assert.equal(f.D.events[0].calendarId, 'family');
});

test('multi-calendar navigation and clock recovery rebuild both recurring sources', async () => {
  const recurring = feed.replace('DTEND:20261013T160000Z', 'DTEND:20261013T160000Z\nRRULE:FREQ=YEARLY;COUNT=3');
  const f = fixture({
    sources,
    saved: { text: recurring, updated: 1791914400000 },
    savedSources: { personal: { text: recurring, updated: 1791914400000 } }
  });
  f.App.now = () => new Date('2009-01-01T00:00:00-07:00');
  f.next(async () => { throw new Error('Offline'); });
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.D.events.length, 0);
  f.App.now = () => new Date('2026-10-12T12:00:00-06:00');
  f.minute(f.App.now());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.D.events.filter(event => event.calendarId === 'family').length, 2);
  assert.equal(f.D.events.filter(event => event.calendarId === 'personal').length, 2);
  f.App.calendar.cover(new Date('2028-10-12T00:00:00-06:00'));
  assert.equal(f.D.events.filter(event => event.calendarId === 'family').length, 3);
  assert.equal(f.D.events.filter(event => event.calendarId === 'personal').length, 3);
});

const work = {
  id: 'work', name: 'Cyber', color: '#2D5BFF', revision: 'work-snapshot', kind: 'availability',
  rangeStart: +new Date('2026-10-12T00:00:00-06:00'), rangeEnd: +new Date('2026-12-15T00:00:00-07:00')
};

test('the availability source remains visible alongside the maximum seven additional iCal sources', async () => {
  const additional = Array.from({ length: 7 }, (_, index) => ({ id: 'extra-' + index, name: 'Extra ' + index, color: '#2D5BFF' }));
  const f = fixture({ sources: [sources[0], ...additional, work] });
  f.next(async url => calendarResponse(feed, +f.App.now(), false, url.endsWith('work.ics') ? work : undefined));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.App.calendar.sources.length, 9);
  assert.equal(f.D.people[8].id, 'work');
  assert.equal(f.D.events.length, 9);
  assert.equal(f.D.events[8].calendarId, 'work');
  assert.equal(f.App.calendar.available('work', f.App.now()), true);
  assert.match(f.App.calendar.label(), /Cyber busy times through /);
});

test('availability snapshots cover whole local days with an exclusive end boundary', async () => {
  const f = fixture({ sources: [sources[0], work] });
  f.App.fmt.monthShort = date => date.toLocaleDateString('en', { month: 'short' });
  f.next(async url => calendarResponse(feed, +f.App.now(), false, url.endsWith('work.ics') ? work : undefined));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.App.calendar.sources[1].kind, 'availability');
  assert.equal(f.App.calendar.sources[1].rangeStart, work.rangeStart);
  assert.equal(f.App.calendar.sources[1].rangeEnd, work.rangeEnd);
  assert.equal(f.App.calendar.available('work', new Date('2026-10-12T15:00:00-06:00')), true);
  assert.equal(f.App.calendar.available('work', new Date('2026-10-11T00:00:00-06:00')), false);
  assert.equal(f.App.calendar.available('work', new Date('2026-12-14T23:59:00-07:00')), true);
  assert.equal(f.App.calendar.available('work', new Date('2026-12-15T00:00:00-07:00')), false);
  assert.equal(f.App.calendar.available('work', new Date('invalid')), false);
  assert.equal(f.App.calendar.available('missing', f.App.now()), false);
  assert.match(f.App.calendar.label(), /Cyber busy times through Dec 14$/);
  f.App.calendar.cover(new Date('2026-12-14T00:00:00-07:00'));
  assert.match(f.App.calendar.label(), /Cyber busy times through Dec 14$/);
  f.App.calendar.cover(new Date('2026-12-14T00:00:00-07:00'), 3);
  assert.match(f.App.calendar.label(), /Cyber unavailable for displayed dates \(Oct 12–Dec 14 only\)$/);
  assert.equal(f.App.calendar.available('work', new Date('2026-12-14T00:00:00-07:00'), 3), false);
  assert.equal(f.App.calendar.available('family', new Date('2026-12-15T00:00:00-07:00')), true);
});

test('an availability snapshot expires after thirty minutes even before the next refresh', async () => {
  const f = fixture({ sources: [sources[0], work] });
  const updated = +f.App.now();
  f.next(async url => calendarResponse(feed, updated, false, url.endsWith('work.ics') ? work : undefined));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  const snapshot = f.D.events;
  f.App.now = () => new Date(updated + 30 * 60 * 1000);
  assert.equal(f.App.calendar.available('work', f.App.now()), true);
  f.App.now = () => new Date(updated + 30 * 60 * 1000 + 1);
  assert.equal(f.App.calendar.available('work', f.App.now()), false);
  assert.equal(f.App.calendar.available('family', f.App.now()), true);
  assert.match(f.App.calendar.label(), /^Cyber saved · retrying/);
  f.minute(f.App.now());
  assert.equal(f.App.calendar.stale, true);
  assert.equal(f.D.events, snapshot);
});

test('availability metadata expands under the same revision without discarding its events', async () => {
  const initial = { ...work, rangeEnd: +new Date('2026-10-14T00:00:00-06:00') };
  const f = fixture({ sources: [sources[0], initial] });
  f.next(async url => calendarResponse(feed, +f.App.now(), false, url.endsWith('work.ics') ? initial : undefined));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  const snapshot = f.D.events;
  const later = new Date('2026-10-15T00:00:00-06:00');
  f.App.calendar.cover(later);
  assert.equal(f.App.calendar.available('work', later), false);
  assert.match(f.App.calendar.label(), /Cyber unavailable for displayed dates/);
  f.status({ configured: true, sources: [sources[0], work] });
  f.next(async url => calendarResponse(feed, +f.App.now(), false, url.endsWith('work.ics') ? work : undefined));
  await f.App.calendar.refresh();
  assert.equal(f.App.calendar.sources[1].rangeEnd, work.rangeEnd);
  assert.equal(f.App.calendar.available('work', later), true);
  assert.equal(f.D.events, snapshot);
  assert.doesNotMatch(f.App.calendar.label(), /unavailable for displayed dates/);
});

test('invalid coverage is never treated as complete availability', async () => {
  const cases = [
    { rangeStart: String(work.rangeStart) }, { rangeEnd: NaN }, { rangeStart: Infinity },
    { rangeStart: -1 }, { rangeEnd: work.rangeStart }, { rangeEnd: work.rangeStart - 1 },
    { rangeEnd: 8640000000000001 }, { rangeStart: work.rangeStart + 0.5 }
  ];
  for (const invalid of cases) {
    const f = fixture({ sources: [sources[0], { ...work, ...invalid }] });
    f.next(async url => url.endsWith('work.ics') ? { ok: false } : calendarResponse(feed, +f.App.now()));
    await f.start(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.App.calendar.sources[1].kind, 'availability');
    assert.equal(f.App.calendar.sources[1].rangeStart, undefined);
    assert.equal(f.App.calendar.sources[1].rangeEnd, undefined);
    assert.equal(f.App.calendar.available('work', f.App.now()), false);
    assert.match(f.App.calendar.label(), /Cyber coverage unavailable$/);
  }
});

test('partial-day coverage and unavailable snapshots cannot claim the day is free', async () => {
  const partial = { ...work, rangeStart: +new Date('2026-10-12T12:00:00-06:00') };
  const f = fixture({ sources: [sources[0], partial] });
  f.next(async url => calendarResponse(feed, +f.App.now(), false, url.endsWith('work.ics') ? partial : undefined));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.App.calendar.available('work', f.App.now()), false);
  assert.equal(f.App.calendar.available('work', new Date('2026-10-13T12:00:00-06:00')), true);
  f.next(async url => calendarResponse(feed, +f.App.now(), url.endsWith('work.ics'), url.endsWith('work.ics') ? partial : undefined));
  await f.App.calendar.refresh();
  assert.equal(f.App.calendar.available('work', new Date('2026-10-13T12:00:00-06:00')), false);
  const snapshot = f.D.events;
  f.next(async url => url.endsWith('work.ics') ? { ok: false } : calendarResponse(feed, +f.App.now()));
  await f.App.calendar.refresh();
  assert.equal(f.App.calendar.available('work', new Date('2026-10-13T12:00:00-06:00')), false);
  assert.equal(f.D.events, snapshot);
  assert.equal(f.App.calendar.available('family', f.App.now()), true);
});

test('coverage metadata is retained only for availability sources and clears when kind changes', async () => {
  const f = fixture({ sources: [sources[0], work] });
  f.next(async url => calendarResponse(feed, +f.App.now(), false, url.endsWith('work.ics') ? work : undefined));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  f.status({ configured: true, sources: [sources[0], { ...work, kind: 'calendar' }] });
  f.next(async () => calendarResponse(feed, +f.App.now()));
  await f.App.calendar.refresh();
  assert.equal(f.App.calendar.sources[1].kind, undefined);
  assert.equal(f.App.calendar.sources[1].rangeStart, undefined);
  assert.equal(f.App.calendar.sources[1].rangeEnd, undefined);
  assert.equal(f.App.calendar.available('work', new Date('2027-01-01T12:00:00-07:00')), true);
  assert.doesNotMatch(f.App.calendar.label(), /busy times/);
  const preview = fixture({ origin: 'https://example.com' });
  await preview.start();
  assert.equal(preview.App.calendar.available('work', preview.App.now()), true);
});

test('snapshot rollover binds displayed coverage to the feed rather than an earlier status response', async () => {
  const shifted = { ...work, rangeStart: +new Date('2026-10-19T00:00:00-06:00'), rangeEnd: +new Date('2026-12-22T00:00:00-07:00') };
  const shiftedFeed = feed.replaceAll('20261013', '20261020');
  const f = fixture({ sources: [sources[0], work] });
  f.next(async url => url.endsWith('work.ics') ? calendarResponse(shiftedFeed, +f.App.now(), false, shifted) : calendarResponse(feed, +f.App.now()));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.App.calendar.sources[1].rangeStart, shifted.rangeStart);
  assert.equal(f.App.calendar.sources[1].rangeEnd, shifted.rangeEnd);
  assert.equal(f.App.calendar.available('work', f.App.now()), false);
  assert.equal(f.App.calendar.available('work', new Date('2026-10-20T00:00:00-06:00')), true);
  assert.equal(f.D.events.find(event => event.calendarId === 'work').start.getDate(), 20);
  assert.match(f.App.calendar.label(), /Cyber unavailable for displayed dates/);
});

test('expanded status coverage is not published while its matching payload is still pending', async () => {
  const initial = { ...work, rangeEnd: +new Date('2026-10-14T00:00:00-06:00') };
  const f = fixture({ sources: [sources[0], initial] });
  f.next(async url => calendarResponse(feed, +f.App.now(), false, url.endsWith('work.ics') ? initial : undefined));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  f.status({ configured: true, sources: [sources[0], work] });
  let finish;
  f.next(async url => url.endsWith('work.ics') ? new Promise(resolve => { finish = resolve; }) : calendarResponse(feed, +f.App.now()));
  const refresh = f.App.calendar.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const later = new Date('2026-10-15T00:00:00-06:00');
  assert.equal(f.App.calendar.sources[1].rangeEnd, initial.rangeEnd);
  assert.equal(f.App.calendar.available('work', later), false);
  finish(calendarResponse(feed, +f.App.now(), false, work));
  await refresh;
  assert.equal(f.App.calendar.sources[1].rangeEnd, work.rangeEnd);
  assert.equal(f.App.calendar.available('work', later), true);
});

test('missing, malformed, and mismatched snapshot binding headers preserve saved data as unavailable', async () => {
  const f = fixture({ sources: [sources[0], work] });
  f.next(async url => calendarResponse(feed, +f.App.now(), false, url.endsWith('work.ics') ? work : undefined));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  const snapshot = f.D.events;
  const saved = f.storage.get(KEY + '-work');
  const invalidHeaders = [
    ['X-Calendar-Revision', null], ['X-Calendar-Revision', 'different-calendar'],
    ['X-Calendar-Range-Start', null], ['X-Calendar-Range-Start', '-1'],
    ['X-Calendar-Range-Start', ' ' + work.rangeStart], ['X-Calendar-Range-Start', String(work.rangeEnd)],
    ['X-Calendar-Range-End', '1.5'], ['X-Calendar-Range-End', '8640000000000001'],
    ['X-Calendar-Range-End', null]
  ];
  for (const [header, value] of invalidHeaders) {
    f.next(async url => {
      const response = calendarResponse(feed.replace('Actual event', 'Untrusted snapshot'), +f.App.now(), false, url.endsWith('work.ics') ? work : undefined);
      if (url.endsWith('work.ics')) value === null ? response.headers.delete(header) : response.headers.set(header, value);
      else return calendarResponse(feed, +f.App.now());
      return response;
    });
    await f.App.calendar.refresh();
    assert.equal(f.D.events, snapshot);
    assert.equal(f.storage.get(KEY + '-work'), saved);
    assert.equal(f.App.calendar.sources[1].error, true);
    assert.equal(f.App.calendar.available('work', f.App.now()), false);
    assert.equal(f.App.calendar.available('family', f.App.now()), true);
  }
  f.next(async url => calendarResponse(feed, +f.App.now(), false, url.endsWith('work.ics') ? work : undefined));
  await f.App.calendar.refresh();
  assert.equal(f.App.calendar.available('work', f.App.now()), true);
  assert.equal(f.App.calendar.sources[1].error, false);
});

test('an iCal source cannot accept a replacement availability payload before its status changes', async () => {
  const f = fixture({ sources: [sources[0], { ...work, kind: undefined }] });
  f.next(async url => calendarResponse(feed, +f.App.now(), false, url.endsWith('work.ics') ? work : undefined));
  await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.D.events.length, 1);
  assert.equal(f.D.events[0].calendarId, 'family');
  assert.equal(f.App.calendar.sources[1].updated, 0);
  assert.equal(f.App.calendar.sources[1].error, true);
  assert.equal(f.App.calendar.available('work', f.App.now()), false);
});
