import { parseCalendar, expandCalendar } from './calendar-feed.js';

const App = window.App, D = window.DATA;
const KEY = 'hq-google-calendar-v1';
const INTERVAL = 5 * 60 * 1000;
const AVAILABILITY_MAX_AGE = 30 * 60 * 1000;
const ENDPOINT = './calendar/';
let rangeStart, rangeEnd, viewedRange, busy = false, clockDay = 0, refreshAfterClockChange = false, configurationError = false;
const calendars = new Map();
const state = App.calendar = { readOnly: false, updated: 0, stale: false, error: false, sources: [] };

function paint() {
  App.emit('data');
  App.rerender();
}

function windowAround(date) {
  return { start: App.addDays(App.dayStart(date), -62), end: App.addDays(App.dayStart(date), 400) };
}

function profile(source) {
  if (!source || typeof source.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(source.id) || source.id === 'feed') return null;
  if (source.revision !== undefined && (typeof source.revision !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(source.revision))) return null;
  const name = typeof source.name === 'string' ? source.name.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 40) : '';
  const color = typeof source.color === 'string' && /^#[0-9a-f]{6}$/i.test(source.color) ? source.color.toUpperCase() : source.id === 'family' ? '#111111' : '#2D5BFF';
  const channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  const linear = channels.map(channel => channel / 255 <= 0.04045 ? channel / 255 / 12.92 : Math.pow((channel / 255 + 0.055) / 1.055, 2.4));
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const kind = source.kind === 'availability' ? 'availability' : undefined;
  const covered = kind && Number.isSafeInteger(source.rangeStart) && Number.isSafeInteger(source.rangeEnd) && source.rangeStart > 0 && source.rangeEnd > source.rangeStart && source.rangeEnd <= 8640000000000000;
  return {
    id: source.id, name: name || (source.id === 'family' ? 'Family' : 'Calendar'), color, rgb: channels.join(' '), ink: luminance > 0.179 ? '#111111' : '#FFFFFF', revision: source.revision,
    kind, rangeStart: covered ? source.rangeStart : undefined, rangeEnd: covered ? source.rangeEnd : undefined
  };
}

function cacheKey(id) {
  return id === 'family' ? KEY : KEY + '-' + id;
}

function summarize() {
  const updated = state.sources.map(source => source.updated).filter(value => value > 0);
  state.updated = updated.length ? Math.min(...updated) : 0;
  state.stale = state.sources.some(source => source.stale || expired(source));
  state.error = configurationError || state.sources.some(source => source.error);
}

function expired(source) {
  return source.kind === 'availability' && source.updated > 0 && +App.now() - source.updated > AVAILABILITY_MAX_AGE;
}

function dateRange(date, days = 1) {
  if (!Number.isInteger(days) || days < 1 || days > 366) return null;
  const start = App.dayStart(date), end = App.addDays(start, days);
  return Number.isFinite(+start) && Number.isFinite(+end) ? { start, end } : null;
}

function covers(source, range) {
  return !!range && source.rangeStart <= +range.start && source.rangeEnd >= +range.end;
}

function responseCoverage(source, response) {
  const revision = response.headers.get('X-Calendar-Revision');
  const first = response.headers.get('X-Calendar-Range-Start');
  const last = response.headers.get('X-Calendar-Range-End');
  if (source.kind !== 'availability') {
    if (revision || first || last) throw new Error('Calendar source changed');
    return null;
  }
  if (!revision || revision !== source.revision || !/^\d{1,16}$/.test(first || '') || !/^\d{1,16}$/.test(last || '')) throw new Error('Unbound availability snapshot');
  const coverage = profile(Object.assign({}, source, { rangeStart: Number(first), rangeEnd: Number(last) }));
  if (!coverage || coverage.rangeStart === undefined || coverage.rangeEnd === undefined) throw new Error('Invalid availability coverage');
  return { rangeStart: coverage.rangeStart, rangeEnd: coverage.rangeEnd };
}

state.available = function (id, date, days = 1) {
  if (!state.readOnly) return true;
  const source = state.sources.find(candidate => candidate.id === id);
  const range = dateRange(date, days);
  if (!source || !range || configurationError || !source.updated || source.stale || source.error || expired(source)) return false;
  return source.kind !== 'availability' || covers(source, range);
};

function combine() {
  D.events = state.sources.flatMap(source => calendars.get(source.id).events).sort((first, second) => first.start - second.start || second.end - first.end);
}

function expand(parsed, source, start, end) {
  return expandCalendar(parsed, start, end, [source.id]).map(event => Object.assign(event, { id: source.id + ':' + event.id, calendarId: source.id }));
}

function apply(source, text, updated, stale) {
  const parsed = parseCalendar(text);
  const range = rangeStart ? { start: rangeStart, end: rangeEnd } : windowAround(App.now());
  const events = expand(parsed, source, range.start, range.end);
  rangeStart = range.start; rangeEnd = range.end;
  calendars.set(source.id, { parsed, text, events });
  source.updated = updated; source.stale = stale; source.error = false;
}

function configure(status) {
  if (status.configured && status.sources !== undefined && !Array.isArray(status.sources)) throw new Error('Invalid calendar configuration');
  const incoming = status.configured ? status.sources === undefined ? [D.family] : status.sources : [];
  const previous = new Map(state.sources.map(source => [source.id, source]));
  const ids = new Set();
  const sources = [];
  let changed = false;
  for (const candidate of incoming.slice(0, 9)) {
    const source = profile(candidate);
    if (!source || ids.has(source.id)) continue;
    ids.add(source.id);
    const old = previous.get(source.id);
    if (old && old.revision === source.revision) {
      const boundCoverage = old.kind === 'availability' && source.kind === 'availability' && old.updated
        ? { rangeStart: old.rangeStart, rangeEnd: old.rangeEnd } : {};
      sources.push(Object.assign(old, source, boundCoverage));
    } else {
      sources.push(Object.assign(source, { updated: 0, stale: false, error: false }));
      calendars.set(source.id, { parsed: null, text: '', events: [] });
      changed = true;
      try {
        const saved = JSON.parse(localStorage.getItem(cacheKey(source.id)));
        const sameRevision = saved && (saved.revision === source.revision || (source.id === 'family' && saved.revision === undefined));
        if (sameRevision && saved.text && Number.isFinite(saved.updated) && saved.updated > 0) apply(source, saved.text, saved.updated, true);
      } catch (e) {}
    }
  }
  for (const id of calendars.keys()) {
    if (!ids.has(id)) { calendars.delete(id); changed = true; }
  }
  state.sources = sources;
  D.people = sources; D.ALL = sources.map(source => source.id);
  if (changed) combine();
  summarize();
}

function applyRange(start, end) {
  for (const source of state.sources) {
    const calendar = calendars.get(source.id);
    if (!calendar.parsed) continue;
    try { calendar.events = expand(calendar.parsed, source, start, end); }
    catch (e) { source.error = true; source.stale = !!source.updated; }
  }
  rangeStart = start; rangeEnd = end;
  combine(); summarize();
}

state.cover = function (date, days = 1) {
  viewedRange = dateRange(date, days);
  if (!viewedRange) return;
  if (!rangeStart || (date >= rangeStart && App.addDays(date, 42) < rangeEnd)) return;
  const range = windowAround(date);
  const start = new Date(Math.min(+rangeStart, +range.start));
  const end = new Date(Math.max(+rangeEnd, +range.end));
  applyRange(start, end);
};

function updateLabel() {
  if (!state.sources.length && state.readOnly) return configurationError ? 'Calendar unavailable · retrying' : 'No calendars configured';
  const affected = state.sources.filter(source => source.error || source.stale || expired(source) || !source.updated);
  if (state.sources.length > 1 && affected.length) return affected.map(source => source.name + (source.updated ? ' saved' : source.error ? ' unavailable' : ' loading')).join(' · ') + ' · retrying';
  if (configurationError) return 'Calendar settings unavailable · retrying';
  if (!state.updated) return state.error ? 'Calendar unavailable · retrying' : 'Loading calendar…';
  const d = new Date(state.updated);
  const when = App.sameDay(d, App.now()) ? App.fmt.time(d) : App.fmt.monthShort(d) + ' ' + d.getDate() + ', ' + App.fmt.time(d);
  return (state.stale || state.error || affected.length ? 'Saved calendar · ' : 'Updated ') + when;
}

state.label = function () {
  const coverage = state.sources.filter(source => source.kind === 'availability').map(source => {
    if (source.rangeStart === undefined || source.rangeEnd === undefined) return source.name + ' coverage unavailable';
    const first = new Date(source.rangeStart), last = new Date(source.rangeEnd - 1);
    const end = App.fmt.monthShort(last) + ' ' + last.getDate();
    if (!covers(source, viewedRange || dateRange(App.now()))) {
      return source.name + ' unavailable for displayed dates (' + App.fmt.monthShort(first) + ' ' + first.getDate() + '–' + end + ' only)';
    }
    return source.name + ' busy times through ' + end;
  });
  return [updateLabel(), ...coverage].join(' · ');
};

state.refresh = async function () {
  if (!state.readOnly || busy) return;
  busy = true;
  try {
    try {
      const response = await fetch(ENDPOINT + 'status.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Calendar settings unavailable');
      configure(await response.json());
      configurationError = false;
    } catch (e) { configurationError = true; }
    let changed = false;
    await Promise.all(state.sources.map(async source => {
      try {
        const response = await fetch(ENDPOINT + (source.id === 'family' ? 'feed' : source.id) + '.ics', { cache: 'no-store' });
        if (!response.ok) throw new Error('Calendar unavailable');
        const coverage = responseCoverage(source, response);
        const text = await response.text();
        const updated = Number(response.headers.get('X-Calendar-Updated'));
        if (!Number.isFinite(updated) || updated <= 0) throw new Error('Missing update time');
        const stale = response.headers.get('X-Calendar-Stale') === 'true';
        const calendar = calendars.get(source.id);
        if (text !== calendar.text || !calendar.parsed) { apply(source, text, updated, stale); changed = true; }
        else { source.updated = updated; source.stale = stale; source.error = false; }
        if (coverage) Object.assign(source, coverage);
        try { localStorage.setItem(cacheKey(source.id), JSON.stringify({ text, updated, revision: source.revision })); } catch (e) {}
      } catch (e) { source.error = true; source.stale = !!source.updated; }
    }));
    if (changed) combine();
  }
  finally {
    summarize(); busy = false; paint();
    if (refreshAfterClockChange) { refreshAfterClockChange = false; state.refresh(); }
  }
};

App.on('minute', function (now) {
  if (!state.readOnly) return;
  summarize();
  const day = +App.dayStart(now);
  if (day === clockDay) return;
  clockDay = day;
  // Some frames boot with a reset clock, then jump forward after network time sync.
  // Rebuild the date window from cached data immediately, even while offline.
  if (rangeStart) {
    const range = windowAround(now);
    applyRange(range.start, range.end);
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
    if (!response.ok) return;
    const status = await response.json();
    if (!status.configured) return;
    state.readOnly = true;
    D.devices.forEach(function (device) {
      if (device.id === 'u-maya') device.name = 'Bedroom Lamp';
      if (device.id === 'u-otto') device.name = 'Nightlight';
    });
    clockDay = +App.dayStart(App.now());
    D.events = []; D.busyExtras = []; App.calMode = 'normal';
    try { configure(status); }
    catch (e) { configurationError = true; summarize(); }
    paint();
    state.refresh();
    setInterval(state.refresh, INTERVAL);
    window.addEventListener('online', state.refresh);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) state.refresh(); });
  } catch (e) { /* Ordinary hosted previews retain their sample calendar. */ }
});
