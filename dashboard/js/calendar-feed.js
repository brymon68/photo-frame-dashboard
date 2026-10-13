import ICAL from 'ical.js';

// Keep Google credentials out of the page. The kiosk supplies only the iCal data.
export function parseCalendar(text) {
  if (!/^BEGIN:VCALENDAR\r?$/m.test(text) || !/^END:VCALENDAR\r?$/m.test(text)) {
    throw new Error('Incomplete calendar');
  }
  const root = new ICAL.Component(ICAL.parse(text));
  if (root.name !== 'vcalendar') throw new Error('Invalid calendar');
  const groups = new Map();
  for (const component of root.getAllSubcomponents('vevent')) {
    const uid = component.getFirstPropertyValue('uid');
    if (!uid) throw new Error('Event without an identifier');
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(component);
  }
  return { root, groups };
}

function asDate(time) {
  if (!time) throw new Error('Event without a date');
  // DATE values and floating times are wall-clock values, not UTC instants.
  if (time.isDate || time.zone === ICAL.Timezone.localTimezone) {
    return new Date(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  }
  return time.toJSDate();
}

export function expandCalendar(calendar, from, to, people) {
  const events = new Map();
  function add(event, start, end, recurrenceId) {
    if (event.component.getFirstPropertyValue('status') === 'CANCELLED') return;
    const a = asDate(start), b = asDate(end);
    if (!Number.isFinite(+a) || !Number.isFinite(+b) || b < a) throw new Error('Invalid event dates');
    if (a >= to || b <= from) return;
    const id = 'g-' + encodeURIComponent(event.uid) + '-' + encodeURIComponent(recurrenceId.toString());
    events.set(id, {
      id, title: event.summary || 'Untitled event', start: a, end: b,
      allDay: start.isDate, people: people.slice(), source: 'google',
      loc: event.location || '', notes: event.description || ''
    });
  }
  for (const components of calendar.groups.values()) {
    const masters = components.filter(c => !c.hasProperty('recurrence-id'));
    const exceptions = components.filter(c => c.hasProperty('recurrence-id'));
    for (const component of masters) {
      if (component.getFirstPropertyValue('status') === 'CANCELLED') continue;
      const event = new ICAL.Event(component, { exceptions, strictExceptions: true });
      if (!event.isRecurring()) {
        add(event, event.startDate, event.endDate, event.startDate);
        continue;
      }
      const iterator = event.iterator();
      let occurrence, count = 0;
      while ((occurrence = iterator.next())) {
        // Fail visibly instead of freezing the kiosk or silently truncating a series.
        if (++count > 100000) throw new Error('Calendar recurrence limit reached');
        if (asDate(occurrence) >= to) break;
        const exception = event.exceptions[occurrence.toString()] ||
          event.exceptions[occurrence.convertToZone(ICAL.Timezone.utcTimezone).toString()];
        // Cancelled instances need not include DTSTART/DTEND.
        if (exception && exception.component.getFirstPropertyValue('status') === 'CANCELLED') continue;
        const detail = event.getOccurrenceDetails(occurrence);
        add(detail.item, detail.startDate, detail.endDate, occurrence);
      }
    }
    // An instance can be moved into the window from a recurrence outside it.
    if (!masters.length || masters.some(c => c.getFirstPropertyValue('status') !== 'CANCELLED')) {
      for (const component of exceptions) {
        if (component.getFirstPropertyValue('status') === 'CANCELLED') continue;
        const event = new ICAL.Event(component, { exceptions: [] });
        add(event, event.startDate, event.endDate, event.recurrenceId);
      }
    }
  }
  return [...events.values()].sort((a, b) => a.start - b.start || b.end - a.end);
}
