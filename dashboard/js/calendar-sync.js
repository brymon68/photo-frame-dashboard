import { parseCalendar, expandCalendar } from './calendar-feed.js';

const App = window.App, D = window.DATA;
const KEY = 'hq-google-calendar-v1';
const INTERVAL = 5 * 60 * 1000;
const ENDPOINT = './calendar/';
let calendar, rangeStart, rangeEnd, busy = false, text = '', clockDay = 0, refreshAfterClockChange = false;
const state = App.calendar = { readOnly: false, updated: 0, stale: false, error: false, loading: false };

function paint() {
  App.emit('data');
  App.rerender();
}

function windowAround(date) {
  return { start: App.addDays(App.dayStart(date), -62), end: App.addDays(App.dayStart(date), 400) };
}

function apply(source, updated, stale) {
  const parsed = parseCalendar(source);
  const range = rangeStart ? { start: rangeStart, end: rangeEnd } : windowAround(App.now());
  const events = expandCalendar(parsed, range.start, range.end, D.ALL);
  calendar = parsed; text = source; rangeStart = range.start; rangeEnd = range.end;
  D.events = events;
  state.updated = updated; state.stale = stale; state.error = false; state.loading = false;
}

state.cover = function (date) {
  if (!calendar || (date >= rangeStart && App.addDays(date, 42) < rangeEnd)) return;
  const range = windowAround(date);
  const start = new Date(Math.min(+rangeStart, +range.start));
  const end = new Date(Math.max(+rangeEnd, +range.end));
  try {
    const events = expandCalendar(calendar, start, end, D.ALL);
    rangeStart = start; rangeEnd = end; D.events = events;
  } catch (e) { state.error = true; }
};

state.label = function () {
  if (!state.updated) return state.error ? 'Calendar unavailable · retrying' : 'Loading calendar…';
  const d = new Date(state.updated);
  const when = App.sameDay(d, App.now()) ? App.fmt.time(d) : App.fmt.monthShort(d) + ' ' + d.getDate() + ', ' + App.fmt.time(d);
  return (state.stale || state.error ? 'Saved calendar · ' : 'Updated ') + when;
};

state.refresh = async function () {
  if (!state.readOnly || busy) return;
  busy = true;
  try {
    const response = await fetch(ENDPOINT + 'feed.ics', { cache: 'no-store' });
    if (!response.ok) throw new Error('Calendar unavailable');
    const source = await response.text();
    const updated = Number(response.headers.get('X-Calendar-Updated'));
    if (!updated || !Number.isFinite(updated)) throw new Error('Missing update time');
    const stale = response.headers.get('X-Calendar-Stale') === 'true';
    if (source !== text || !calendar) apply(source, updated, stale);
    else { state.updated = updated; state.stale = stale; state.error = false; state.loading = false; }
    try { localStorage.setItem(KEY, JSON.stringify({ text: source, updated })); } catch (e) { /* Native cache also persists. */ }
  } catch (e) { state.error = true; state.stale = !!state.updated; state.loading = false; }
  finally {
    busy = false; paint();
    if (refreshAfterClockChange) { refreshAfterClockChange = false; state.refresh(); }
  }
};

App.on('minute', function (now) {
  if (!state.readOnly) return;
  const day = +App.dayStart(now);
  if (day === clockDay) return;
  clockDay = day;
  // Some frames boot with a reset clock, then jump forward after network time sync.
  // Rebuild the date window from cached data immediately, even while offline.
  if (calendar) {
    try {
      const range = windowAround(now);
      const events = expandCalendar(calendar, range.start, range.end, D.ALL);
      rangeStart = range.start; rangeEnd = range.end; D.events = events;
    } catch (e) { state.error = true; }
  }
  App.emit('time');
  paint();
  if (busy) refreshAfterClockChange = true;
  else state.refresh();
});

App.on('ready', async function () {
  if (location.origin !== 'https://appassets.androidplatform.net') return;
  try {
    const response = await fetch(ENDPOINT + 'status.json', { cache: 'no-store' });
    if (!response.ok || !(await response.json()).configured) return;
    state.readOnly = true; state.loading = true;
    // The installed frame has one shared calendar, with no sample member profiles.
    D.people = [D.family]; D.ALL = [D.family.id];
    D.devices.forEach(function (device) {
      if (device.id === 'u-maya') device.name = 'Bedroom Lamp';
      if (device.id === 'u-otto') device.name = 'Nightlight';
    });
    clockDay = +App.dayStart(App.now());
    D.events = []; D.busyExtras = []; App.calMode = 'normal';
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      if (saved && saved.text && Number.isFinite(saved.updated) && saved.updated > 0) apply(saved.text, saved.updated, true);
    } catch (e) { /* An unusable cache must not prevent a fresh download. */ }
    paint();
    state.refresh();
    setInterval(state.refresh, INTERVAL);
    window.addEventListener('online', state.refresh);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) state.refresh(); });
  } catch (e) { /* Ordinary hosted previews retain their sample calendar. */ }
});
