import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { climateFavorites } from '../js/climate-favorites.js';

class Element {
  constructor() { this.innerHTML = ''; this.parts = new Map(); this.listeners = {}; this.style = {}; }
  get firstChild() { return this.innerHTML ? {} : null; }
  querySelector(selector) {
    if (selector === '.grid-scroll' && !this.innerHTML.includes('grid-scroll')) return null;
    if (!this.parts.has(selector)) this.parts.set(selector, new Element());
    return this.parts.get(selector);
  }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  click(selector, dataset) {
    for (const handler of this.listeners.click || []) handler({ target: { closest: query => query === selector ? { dataset } : null } });
  }
}

function fixture(date = '2026-10-17T10:00:00-06:00') {
  let now = +new Date(date);
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const root = new Element(), home = new Element();
  const window = { ICONS: {}, addEventListener() {} };
  const context = vm.createContext({ window, Date: Clock, document: { addEventListener() {} }, climateFavorites, setTimeout() {}, clearTimeout() {} });
  for (const path of ['data.js', 'app.js']) vm.runInContext(readFileSync(new URL('../js/' + path, import.meta.url), 'utf8'), context);
  const App = context.App = window.App, data = window.DATA;
  const personal = { id: 'personal', name: 'Bryce', color: '#2D5BFF', rgb: '45 91 255', ink: '#FFFFFF' };
  data.people = [data.family, personal]; data.ALL = ['family', 'personal'];
  const today = App.dayStart(App.now()), tomorrow = App.addDays(today, 1);
  const starts = new Date(today), ends = new Date(today);
  starts.setHours(11); ends.setHours(12);
  data.events = data.people.flatMap(source => [{
    id: source.id + ':timed', calendarId: source.id, source: 'google', people: [source.id], title: source.name + ' appointment',
    start: new Date(starts), end: new Date(ends)
  }, {
    id: source.id + ':allday', calendarId: source.id, source: 'google', people: [source.id], title: source.name + ' day', allDay: true,
    start: new Date(today), end: new Date(tomorrow)
  }]);
  const covered = [], coverageWindows = [];
  App.calendar = { readOnly: true, sources: data.people, updated: now, available: () => true,
    cover(date, days) { covered.push(new Date(date)); coverageWindows.push({ date: new Date(date), days }); }, label: () => 'Updated 10:00 AM' };
  App.weatherNow = () => ({ temp: 72, hi: 80, lo: 60, label: 'Clear', summary: 'Clear' });
  App.hourly = () => [];
  App.weather = { label: () => 'Updated' };
  App.lights = { summary: () => ({ value: 0 }), counts: () => ({ unavailable: 0 }) };
  App.cameras = { canView: () => false, doorbell: () => undefined };
  App.climate = { devices: [], temperature: () => '—' };
  let sheet;
  App.sheet = html => { sheet = html; };
  for (const path of ['views/calendar.js', 'views/home.js']) {
    vm.runInContext(readFileSync(new URL('../js/' + path, import.meta.url), 'utf8').replace(/^import .*\n/gm, ''), context);
  }
  return {
    App, data, root, home, covered, coverageWindows,
    calendar: () => App.views.calendar.show(root, {}),
    mode: mode => root.click('[data-mode]', { mode }),
    nav: direction => root.click('[data-nav]', { nav: String(direction) }),
    today: () => root.click('[data-today]', {}),
    selectDay: date => root.click('[data-day]', { day: String(+new Date(date)) }),
    clock: date => { now = +new Date(date); },
    showHome: () => App.views.home.show(home),
    get sheet() { return sheet; }
  };
}

test('connected Today places each calendar in its own lane, including all-day events', () => {
  const fixtureData = fixture();
  fixtureData.calendar();
  const html = fixtureData.root.innerHTML;
  const lanes = [...html.matchAll(/<div class="lane" style="[^"]+">([\s\S]*?)<\/div>/g)].map(match => match[1]);
  assert.equal(lanes.length, 2);
  assert.match(lanes[0], /Family appointment/);
  assert.doesNotMatch(lanes[0], /Bryce appointment/);
  assert.match(lanes[1], /Bryce appointment/);
  assert.doesNotMatch(lanes[1], /Family appointment/);
  assert.match(html, /data-ev="family:allday" style="grid-column:1 \/ span 1/);
  assert.match(html, /data-ev="personal:allday" style="grid-column:2 \/ span 1/);
  assert.equal((html.match(/data-ev="family:timed"/g) || []).length, 1);
  assert.equal((html.match(/data-ev="personal:timed"/g) || []).length, 1);
  assert.match(html, /--calendar-columns:2/);
});

test('combined calendar views identify sources by name and color', () => {
  for (const mode of ['workweek', 'week', 'month']) {
    const fixtureData = fixture('2026-10-16T10:00:00-06:00');
    fixtureData.calendar(); fixtureData.mode(mode);
    const html = fixtureData.root.innerHTML;
    assert.match(html, /class="cal-legend"/);
    assert.match(html, /--c:#111111[^>]+><i><\/i>Family/);
    assert.match(html, /--c:#2D5BFF[^>]+><i><\/i>Bryce/);
    if (mode !== 'month') {
      assert.match(html, /Family · /);
      assert.match(html, /Bryce · /);
    } else {
      assert.match(html, /<i style="--c:#111111/);
      assert.match(html, /<i style="--c:#2D5BFF/);
    }
  }
});

function workweekHeaders(fixtureData) {
  return [...fixtureData.root.innerHTML.matchAll(/<div class="day-head(?: is-today)?"><span class="num">(\d+)<\/span><b>(\w+)<\/b><small>(\w+)<\/small>/g)]
    .map(match => match[2] + ' ' + match[3] + ' ' + match[1]);
}

test('Work Week replaces 3 Day with the selected Monday–Friday, including weekend selections', () => {
  for (const day of [16, 17, 18]) {
    const fixtureData = fixture('2026-10-' + day + 'T10:00:00-06:00');
    fixtureData.calendar(); fixtureData.mode('workweek');
    const html = fixtureData.root.innerHTML;
    assert.match(html, /data-mode="workweek">Work Week<\/button>/);
    assert.doesNotMatch(html, /3 Day|3day/);
    assert.deepEqual(workweekHeaders(fixtureData), ['Mon Oct 12', 'Tue Oct 13', 'Wed Oct 14', 'Thu Oct 15', 'Fri Oct 16']);
    assert.equal((html.match(/class="lane(?: is-today)?"/g) || []).length, 5);
    assert.match(html, /Oct 12 <i>–<\/i> 16/);
    assert.equal(fixtureData.covered.at(-1).getHours(), 0);
    if (day === 16) {
      assert.match(html, /Family appointment|Bryce appointment/);
      assert.match(html, /now-line now-line--4/);
    } else {
      assert.doesNotMatch(html, /Family appointment|Bryce appointment|class="now-line/);
    }
    fixtureData.nav(1);
    assert.deepEqual(workweekHeaders(fixtureData), ['Mon Oct 19', 'Tue Oct 20', 'Wed Oct 21', 'Thu Oct 22', 'Fri Oct 23']);
    fixtureData.nav(-1); fixtureData.nav(-1);
    assert.deepEqual(workweekHeaders(fixtureData), ['Mon Oct 5', 'Tue Oct 6', 'Wed Oct 7', 'Thu Oct 8', 'Fri Oct 9']);
  }
});

test('Work Week normalizes dates from day and month while selected days still open Today mode', () => {
  const fixtureData = fixture();
  fixtureData.calendar(); fixtureData.mode('month'); fixtureData.mode('workweek');
  assert.deepEqual(workweekHeaders(fixtureData), ['Mon Sept 28', 'Tue Sept 29', 'Wed Sept 30', 'Thu Oct 1', 'Fri Oct 2']);
  fixtureData.mode('month'); fixtureData.selectDay('2026-11-05T00:00:00-07:00');
  assert.match(fixtureData.root.innerHTML, /class="cal cal--day /);
  assert.match(fixtureData.root.innerHTML, /Thursday <i>5<\/i>/);
  fixtureData.mode('workweek');
  assert.deepEqual(workweekHeaders(fixtureData), ['Mon Nov 2', 'Tue Nov 3', 'Wed Nov 4', 'Thu Nov 5', 'Fri Nov 6']);
});

test('Work Week Today and clock reset return to the Monday of the current week', () => {
  const fixtureData = fixture();
  fixtureData.calendar(); fixtureData.mode('workweek'); fixtureData.nav(1);
  assert.match(fixtureData.root.innerHTML, /class="btn btn--ghost" data-today/);
  fixtureData.today();
  assert.deepEqual(workweekHeaders(fixtureData), ['Mon Oct 12', 'Tue Oct 13', 'Wed Oct 14', 'Thu Oct 15', 'Fri Oct 16']);
  assert.match(fixtureData.root.innerHTML, /class="btn btn--ghost is-hidden" data-today/);
  fixtureData.clock('2026-11-01T10:00:00-07:00');
  fixtureData.App.emit('time'); fixtureData.calendar();
  assert.deepEqual(workweekHeaders(fixtureData), ['Mon Oct 26', 'Tue Oct 27', 'Wed Oct 28', 'Thu Oct 29', 'Fri Oct 30']);
  assert.match(fixtureData.root.innerHTML, /class="btn btn--ghost is-hidden" data-today/);
});

test('Work Week titles identify both months and years when their date range crosses a boundary', () => {
  for (const scenario of [
    { date: '2026-12-02T10:00:00-07:00', range: /Nov 30 <i>–<\/i> Dec 4/, years: /2026 · Mon–Fri/ },
    { date: '2026-12-31T10:00:00-07:00', range: /Dec 28 <i>–<\/i> Jan 1/, years: /2026–2027 · Mon–Fri/ },
    { date: '2027-01-01T10:00:00-07:00', range: /Dec 28 <i>–<\/i> Jan 1/, years: /2026–2027 · Mon–Fri/ }
  ]) {
    const fixtureData = fixture(scenario.date);
    fixtureData.calendar(); fixtureData.mode('workweek');
    assert.match(fixtureData.root.innerHTML, scenario.range);
    assert.match(fixtureData.root.innerHTML, scenario.years);
  }
});

test('Work Week navigation keeps Monday midnight across both daylight-saving transitions', () => {
  for (const scenario of [
    { date: '2026-03-06T10:00:00-07:00', before: '2026-03-02T00:00:00-07:00', after: '2026-03-09T00:00:00-06:00', hours: 167 },
    { date: '2026-10-30T10:00:00-06:00', before: '2026-10-26T00:00:00-06:00', after: '2026-11-02T00:00:00-07:00', hours: 169 }
  ]) {
    const fixtureData = fixture(scenario.date);
    fixtureData.calendar(); fixtureData.mode('workweek');
    const before = fixtureData.covered.at(-1);
    assert.equal(+before, +new Date(scenario.before));
    fixtureData.nav(1);
    const after = fixtureData.covered.at(-1);
    assert.equal(+after, +new Date(scenario.after));
    assert.equal(after.getDay(), 1);
    assert.equal(after.getHours(), 0);
    assert.equal((after - before) / 3600000, scenario.hours);
    fixtureData.nav(-1);
    assert.equal(+fixtureData.covered.at(-1), +before);
  }
});

test('Work Week clips all-day spans to weekdays with exclusive end dates across DST', () => {
  const fixtureData = fixture('2026-11-04T10:00:00-07:00');
  fixtureData.data.events = [
    { id: 'carry', start: '2026-10-31T00:00:00-06:00', end: '2026-11-04T00:00:00-07:00' },
    { id: 'middle', start: '2026-11-03T00:00:00-07:00', end: '2026-11-05T00:00:00-07:00' },
    { id: 'beyond', start: '2026-11-06T00:00:00-07:00', end: '2026-11-09T00:00:00-07:00' },
    { id: 'whole', start: '2026-10-30T00:00:00-06:00', end: '2026-11-10T00:00:00-07:00' },
    { id: 'before', start: '2026-10-31T00:00:00-06:00', end: '2026-11-02T00:00:00-07:00' },
    { id: 'after', start: '2026-11-07T00:00:00-07:00', end: '2026-11-09T00:00:00-07:00' }
  ].map(event => ({ ...event, start: new Date(event.start), end: new Date(event.end), title: event.id,
    allDay: true, calendarId: 'personal', people: ['personal'] }));
  fixtureData.calendar(); fixtureData.mode('workweek');
  const html = fixtureData.root.innerHTML;
  for (const [id, columns] of [['carry', '1 / 3'], ['middle', '2 / 4'], ['beyond', '5 / 6'], ['whole', '1 / 6']]) {
    assert.ok(html.includes('data-ev="' + id + '" style="grid-column:' + columns + ';--c:#2D5BFF'));
  }
  assert.match(html, /class="ad ad--cont" data-ev="carry"/);
  assert.match(html, /Bryce · middle/);
  assert.doesNotMatch(html, /data-ev="before"|data-ev="after"/);
});

test('Work Week locates the current-time line in each weekday column', () => {
  for (let offset = 0; offset < 5; offset++) {
    const fixtureData = fixture('2026-10-' + (19 + offset) + 'T10:00:00-06:00');
    fixtureData.calendar(); fixtureData.mode('workweek');
    const lines = [...fixtureData.root.innerHTML.matchAll(/class="now-line now-line--(\d)"/g)];
    assert.equal(lines.length, 1);
    assert.equal(Number(lines[0][1]), offset);
    fixtureData.nav(1);
    assert.doesNotMatch(fixtureData.root.innerHTML, /class="now-line/);
  }
});

test('calendar coverage uses the complete visible date range for every mode', () => {
  for (const [mode, start, days] of [
    ['day', '2026-10-17T00:00:00-06:00', 1],
    ['workweek', '2026-10-12T00:00:00-06:00', 5],
    ['week', '2026-10-17T00:00:00-06:00', 7],
    ['month', '2026-09-28T00:00:00-06:00', 42]
  ]) {
    const fixtureData = fixture();
    fixtureData.calendar(); fixtureData.mode(mode);
    const coverage = fixtureData.coverageWindows.at(-1);
    assert.equal(+coverage.date, +new Date(start));
    assert.equal(coverage.days, days);
  }
});

test('Today never claims free time when an availability source lacks usable coverage', () => {
  const fixtureData = fixture();
  fixtureData.data.events = [];
  Object.assign(fixtureData.data.people[1], { name: 'Cyber', kind: 'availability' });
  let available = false;
  fixtureData.App.calendar.available = () => available;
  fixtureData.showHome();
  let hero = fixtureData.home.querySelector('.h-hero-slot').innerHTML;
  let cyberLane = fixtureData.home.querySelector('.h-lanes').innerHTML.split('<div class="h-lane"')[2];
  assert.match(hero, /Some calendar times unavailable/);
  assert.doesNotMatch(hero, /Nothing else scheduled|Enjoy the quiet/);
  assert.match(cyberLane, /Cyber<\/b>/);
  assert.match(cyberLane, /Availability unavailable/);
  assert.doesNotMatch(cyberLane, /<i>Free<\/i>/);
  available = true;
  fixtureData.showHome();
  assert.match(fixtureData.home.querySelector('.h-hero-slot').innerHTML, /Nothing else scheduled/);
  assert.match(fixtureData.home.querySelector('.h-lanes').innerHTML.split('<div class="h-lane"')[2], /<i>Free<\/i>/);
  available = false;
  fixtureData.App.emit('minute', new Date('2026-10-17T10:01:00-06:00'));
  hero = fixtureData.home.querySelector('.h-hero-slot').innerHTML;
  cyberLane = fixtureData.home.querySelector('.h-lanes').innerHTML.split('<div class="h-lane"')[2];
  assert.match(hero, /Some calendar times unavailable/);
  assert.match(cyberLane, /Availability unavailable/);
});

test('Today retains and identifies saved busy times when an availability source is stale', () => {
  const fixtureData = fixture();
  Object.assign(fixtureData.data.people[1], { name: 'Cyber', kind: 'availability' });
  const event = fixtureData.data.events.find(event => event.id === 'personal:timed');
  event.title = 'Busy'; fixtureData.data.events = [event];
  fixtureData.App.calendar.available = () => false;
  fixtureData.showHome();
  const hero = fixtureData.home.querySelector('.h-hero-slot').innerHTML;
  const cyberLane = fixtureData.home.querySelector('.h-lanes').innerHTML.split('<div class="h-lane"')[2];
  assert.match(hero, /Saved busy time · Cyber/);
  assert.match(hero, />Busy<\/div>/);
  assert.match(cyberLane, /Saved busy times/);
  assert.match(cyberLane, /data-ev="personal:timed"/);
  assert.doesNotMatch(cyberLane, /<i>Free<\/i>/);
});

test('empty Calendar and Week days distinguish missing availability from known free time', () => {
  const fixtureData = fixture();
  fixtureData.data.events = [];
  fixtureData.data.people[1].kind = 'availability';
  let available = true;
  fixtureData.App.calendar.available = () => available;
  fixtureData.calendar();
  assert.match(fixtureData.root.innerHTML, /Nothing on the calendar/);
  available = false;
  fixtureData.App.current = 'calendar';
  fixtureData.App.emit('minute', new Date('2026-10-17T10:01:00-06:00'));
  assert.match(fixtureData.root.innerHTML, /Some calendar times unavailable/);
  assert.doesNotMatch(fixtureData.root.innerHTML, /Nothing on the calendar|A rare, quiet day/);
  fixtureData.App.calendar.available = (id, date) => date.getDate() < 20;
  fixtureData.mode('week');
  assert.equal((fixtureData.root.innerHTML.match(/<i>Free<\/i>/g) || []).length, 3);
  assert.equal((fixtureData.root.innerHTML.match(/<i>Unavailable<\/i>/g) || []).length, 4);
});

test('tomorrow’s saved busy time remains qualified when only today has availability coverage', () => {
  const fixtureData = fixture();
  Object.assign(fixtureData.data.people[1], { name: 'Cyber', kind: 'availability' });
  const event = fixtureData.data.events.find(event => event.id === 'personal:timed');
  event.title = 'Busy';
  event.start = new Date('2026-10-18T09:00:00-06:00');
  event.end = new Date('2026-10-18T10:00:00-06:00');
  fixtureData.data.events = [event];
  fixtureData.App.calendar.available = (id, date) => fixtureData.App.sameDay(date, fixtureData.App.now());
  fixtureData.showHome();
  assert.match(fixtureData.home.querySelector('.h-hero-slot').innerHTML, /Tomorrow starts with <b>Busy<\/b> at 9:00 AM · Cyber · Saved busy time/);
});

test('event details show only the originating calendar, including family events', () => {
  const fixtureData = fixture();
  for (const source of fixtureData.data.people) {
    fixtureData.App.eventSheet(fixtureData.data.events.find(event => event.id === source.id + ':timed'));
    assert.match(fixtureData.sheet, new RegExp(source.name + ' calendar ·'));
    assert.equal((fixtureData.sheet.match(/class="chip"/g) || []).length, 1);
    assert.doesNotMatch(fixtureData.sheet, new RegExp(source.id === 'family' ? 'Bryce' : 'Family'));
  }
});

test('Today overview separates source lanes and labels the next event', () => {
  const fixtureData = fixture();
  const personalEvent = fixtureData.data.events.find(event => event.id === 'personal:timed');
  personalEvent.start = new Date('2026-10-17T10:30:00-06:00');
  fixtureData.showHome();
  const lanes = fixtureData.home.querySelector('.h-lanes');
  const hero = fixtureData.home.querySelector('.h-hero-slot').innerHTML;
  assert.equal(lanes.style.gridTemplateColumns, 'repeat(2, 1fr)');
  assert.match(lanes.innerHTML, /Family<\/b>/);
  assert.match(lanes.innerHTML, /Bryce<\/b>/);
  assert.equal((lanes.innerHTML.match(/Family appointment/g) || []).length, 1);
  assert.equal((lanes.innerHTML.match(/Bryce appointment/g) || []).length, 1);
  assert.match(hero, /Next up · Bryce/);
  assert.match(hero, /--c:#2D5BFF/);
});

test('a single personal source never inherits Family classification or color', () => {
  const fixtureData = fixture();
  const personal = fixtureData.data.people[1];
  fixtureData.data.people = [personal]; fixtureData.data.ALL = [personal.id];
  const event = fixtureData.data.events.find(event => event.calendarId === personal.id);
  assert.equal(fixtureData.App.isFamily(event), false);
  assert.equal(fixtureData.App.evColor(event).id, personal.id);
  assert.equal(fixtureData.App.isFamily({ people: [personal.id] }), true);
});

test('quiet Today identifies and escapes the source of tomorrow’s first event', () => {
  for (const name of ['Bryce', 'Bryce <private>']) {
    const fixtureData = fixture();
    fixtureData.data.people[1].name = name;
    const event = fixtureData.data.events.find(event => event.id === 'personal:timed');
    event.start = new Date('2026-10-18T09:00:00-06:00');
    event.end = new Date('2026-10-18T10:00:00-06:00');
    fixtureData.data.events = [event];
    fixtureData.showHome();
    const hero = fixtureData.home.querySelector('.h-hero-slot').innerHTML;
    assert.match(hero, /Nothing else scheduled/);
    assert.ok(hero.includes('Tomorrow starts with <b>Bryce appointment</b> at 9:00 AM · ' + fixtureData.App.esc(name)));
    assert.doesNotMatch(hero, /<private>|· Family/);
  }
});

test('configured family metadata controls its event color and label', () => {
  const fixtureData = fixture();
  const source = { ...fixtureData.data.family, name: 'Family plans', color: '#008800', rgb: '0 136 0' };
  fixtureData.data.people[0] = source;
  fixtureData.App.calendar.sources = fixtureData.data.people;
  const event = fixtureData.data.events.find(event => event.calendarId === 'family');
  assert.equal(fixtureData.App.person('family'), source);
  assert.equal(fixtureData.App.evColor(event), source);
  fixtureData.calendar();
  assert.match(fixtureData.root.innerHTML, /data-ev="family:timed" style="--c:#008800/);
  assert.doesNotMatch(fixtureData.root.innerHTML, /class="ev is-family/);
  fixtureData.App.eventSheet(event);
  assert.match(fixtureData.sheet, /Family plans calendar/);
});

test('calendar source labels escape display names', () => {
  const fixtureData = fixture();
  fixtureData.data.people[1].name = 'Bryce <private>';
  fixtureData.calendar(); fixtureData.showHome();
  fixtureData.App.eventSheet(fixtureData.data.events.find(event => event.calendarId === 'personal'));
  for (const html of [fixtureData.root.innerHTML, fixtureData.home.querySelector('.h-lanes').innerHTML, fixtureData.sheet]) {
    assert.match(html, /Bryce &lt;private&gt;/);
    assert.doesNotMatch(html, /<private>/);
  }
});
