import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendar, expandCalendar } from '../js/calendar-feed.js';

const timezone = `BEGIN:VTIMEZONE
TZID:America/Denver
BEGIN:DAYLIGHT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0700
TZOFFSETTO:-0600
END:DAYLIGHT
BEGIN:STANDARD
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0600
TZOFFSETTO:-0700
END:STANDARD
END:VTIMEZONE`;

function expand(body, start = '2026-10-01', end = '2026-12-01') {
  return expandCalendar(parseCalendar(`BEGIN:VCALENDAR\nVERSION:2.0\n${timezone}\n${body}\nEND:VCALENDAR\n`),
    new Date(start), new Date(end), ['parent', 'child']);
}

test('recurring wall-clock times follow Denver DST, including exclusions and cancellations', () => {
  const events = expand(`BEGIN:VEVENT
UID:weekly
DTSTART;TZID=America/Denver:20261025T090000
DTEND;TZID=America/Denver:20261025T100000
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE;TZID=America/Denver:20261108T090000
SUMMARY:Weekly
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID;TZID=America/Denver:20261115T090000
STATUS:CANCELLED
END:VEVENT`);
  assert.deepEqual(events.map(e => e.start.toISOString()), ['2026-10-25T15:00:00.000Z', '2026-11-01T16:00:00.000Z']);
  assert.ok(events.every(e => e.start.getHours() === 9));
  assert.deepEqual(events[0].people, ['parent', 'child']);
});

test('modified instances belong to their own series, and keep stable identifiers', () => {
  const events = expand(`BEGIN:VEVENT
UID:first
DTSTART:20261012T150000Z
DTEND:20261012T160000Z
RRULE:FREQ=DAILY;COUNT=2
SUMMARY:First
END:VEVENT
BEGIN:VEVENT
UID:second
DTSTART:20261012T150000Z
DTEND:20261012T160000Z
RRULE:FREQ=DAILY;COUNT=2
SUMMARY:Second
END:VEVENT
BEGIN:VEVENT
UID:first
RECURRENCE-ID:20261013T150000Z
DTSTART:20261013T170000Z
DTEND:20261013T180000Z
SUMMARY:Rescheduled
END:VEVENT`);
  assert.equal(events.length, 4);
  assert.equal(events.filter(e => e.title === 'Second').length, 2);
  const moved = events.find(e => e.title === 'Rescheduled');
  assert.equal(moved.start.toISOString(), '2026-10-13T17:00:00.000Z');
  assert.ok(moved.id.includes(encodeURIComponent('2026-10-13T15:00:00Z')));
});

test('instances moved into the requested window are included once', () => {
  const events = expand(`BEGIN:VEVENT
UID:moved
DTSTART:20261205T150000Z
DTEND:20261205T160000Z
RRULE:FREQ=DAILY;COUNT=2
SUMMARY:Outside window
END:VEVENT
BEGIN:VEVENT
UID:moved
RECURRENCE-ID:20261205T150000Z
DTSTART:20261013T170000Z
DTEND:20261013T180000Z
SUMMARY:Inside window
END:VEVENT`);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Inside window');
});

test('all-day end dates stay exclusive across DST and folded, escaped text is preserved', () => {
  const events = expand(`BEGIN:VEVENT
UID:holiday
DTSTART;VALUE=DATE:20261031
DTEND;VALUE=DATE:20261102
SUMMARY:Family\\, weekend with a long
  title
DESCRIPTION:Line one\\nLine two
LOCATION:Home
END:VEVENT`);
  assert.equal(events[0].allDay, true);
  assert.equal(events[0].start.getDate(), 31);
  assert.equal(events[0].end.getDate(), 2);
  assert.equal(events[0].start.getHours(), 0);
  assert.equal(events[0].end.getHours(), 0);
  assert.equal(events[0].title, 'Family, weekend with a long title');
  assert.equal(events[0].notes, 'Line one\nLine two');
  assert.equal(expand(`BEGIN:VEVENT\nUID:one\nDTSTART;VALUE=DATE:20261031\nDTEND;VALUE=DATE:20261102\nEND:VEVENT`, '2026-11-02T00:00:00-07:00').length, 0);
});

test('UTC and floating appointments use the appropriate local display time', () => {
  const events = expand(`BEGIN:VEVENT
UID:utc
DTSTART:20261012T150000Z
DTEND:20261012T160000Z
END:VEVENT
BEGIN:VEVENT
UID:floating
DTSTART:20261012T100000
DURATION:PT30M
END:VEVENT`);
  assert.equal(events[0].start.getHours(), 9);
  assert.equal(events[1].start.getHours(), 10);
  assert.equal(+events[1].end - events[1].start, 30 * 60000);
});

test('empty calendars are valid, incomplete downloads are rejected', () => {
  assert.deepEqual(expand(''), []);
  assert.throws(() => parseCalendar('BEGIN:VCALENDAR\nBEGIN:VEVENT'));
  assert.throws(() => expand('BEGIN:VEVENT\nDTSTART:20261012T150000Z\nEND:VEVENT'));
});
