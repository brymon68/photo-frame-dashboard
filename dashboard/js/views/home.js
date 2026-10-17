// Home / Today: the glanceable overview. Never scrolls.
import { climateFavorites } from '../climate-favorites.js';
(function () {
  'use strict';
  var D = window.DATA, V = {};

  function unavailable(source, date) {
    return App.calendar && App.calendar.readOnly && source && source.kind === 'availability' && !App.calendar.available(source.id, date);
  }

  function clock() {
    var n = App.now();
    return '<div class="h-time num">' + App.fmt.time(n, false) + '<span class="h-ampm">' + App.fmt.ampm(n) + '</span></div>' +
      '<div class="h-date"><b>' + App.fmt.day(n) + '</b> ' + App.fmt.month(n) + ' ' + n.getDate() + '</div>';
  }

  function weather() {
    var w = App.weatherNow();
    var hours = App.hourly(7);
    var tmin = Math.min.apply(null, hours.map(function (h) { return h.t; }));
    var tmax = Math.max.apply(null, hours.map(function (h) { return h.t; }));
    return '<div class="h-wx-top">' +
      '<span class="h-wx-icon">' + App.icon(w.cond, 60) + '</span>' +
      '<span class="h-wx-temp num">' + w.temp + '°<small>F</small></span>' +
      '<span class="h-wx-meta"><b>' + w.label + '</b><span>H ' + w.hi + '°  L ' + w.lo + '°</span></span>' +
      '<div class="h-wx-source"><b>Albuquerque, NM</b><span>' + App.esc(App.weather.label()) + '</span>' +
      '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather by Open-Meteo ↗</a></div></div>' +
      '<div class="h-wx-say"><b>' + App.esc(w.summary) + '</b>' + (w.advice ? ' · ' + App.esc(w.advice) : '') + '</div>' +
      '<div class="h-wx-hours">' + hours.map(function (h) {
        var lift = tmax === tmin ? 0 : Math.round((h.t - tmin) / (tmax - tmin) * 8);
        return '<div class="h-hr' + (h.p >= 50 ? ' is-wet' : '') + '"><span class="h-hr-l">' + h.label + '</span>' +
          '<span class="h-hr-i" style="transform:translateY(' + -lift + 'px)">' + App.icon(h.c, 22) + '</span><b>' + h.t + '°</b></div>';
      }).join('') + '</div>';
  }

  function hero() {
    var e = App.nextEvent(), now = App.now();
    if (!e) {
      if (App.calendar && App.calendar.readOnly && !App.calendar.updated) {
        return '<div class="h-hero h-hero--empty" data-go="calendar"><div class="label label--light">Google Calendar</div>' +
          '<div class="h-hero-title serif">' + (App.calendar.error ? 'Calendar unavailable.<br><i>Trying again soon.</i>' : 'Loading your calendar…') + '</div></div>';
      }
      if (D.people.some(function (source) { return unavailable(source, now); })) {
        return '<div class="h-hero h-hero--empty" data-go="calendar"><div class="label label--light">Calendar availability</div>' +
          '<div class="h-hero-title serif">Some calendar times unavailable.<br><i>Check Calendar for details.</i></div></div>';
      }
      var tomorrow = App.timedOn(App.addDays(now, 1))[0];
      return '<div class="h-hero h-hero--empty" data-go="calendar">' +
        '<div class="label label--light">Rest of today</div>' +
        '<div class="h-hero-title serif">Nothing else scheduled.<br><i>Enjoy the quiet.</i></div>' +
        (tomorrow ? '<div class="h-hero-meta">Tomorrow starts with <b>' + App.esc(tomorrow.title) + '</b> at ' + App.fmt.time(tomorrow.start) + (tomorrow.calendarId ? ' · ' + App.esc(App.person(tomorrow.calendarId).name) : '') + (unavailable(App.person(tomorrow.calendarId), tomorrow.start) ? ' · Saved busy time' : '') + '</div>' : '') +
        '</div>';
    }
    var p = App.evColor(e);
    var mins = (e.start - now) / 60000;
    var leave = (App.leaveBy(e) - now) / 60000;
    var who = e.people.map(function (id) { return App.person(id).name; });
    var whoText = e.calendarId ? App.person(e.calendarId).name : App.isFamily(e) ? (App.calendar && App.calendar.readOnly ? 'Family' : 'Everyone') : who.join(' + ');
    var savedBusy = unavailable(App.person(e.calendarId), e.start);
    var big = mins < 100
      ? '<div class="h-hero-count num">' + Math.round(mins) + '<small>min</small></div>'
      : '<div class="h-hero-count num">' + App.fmt.time(e.start, false) + '<small>' + App.fmt.ampm(e.start) + '</small></div>';
    var leavePill = '';
    if (e.travel) {
      leavePill = leave <= 0
        ? '<span class="pill pill--alert"><i class="pulse"></i>Leave now</span>'
        : '<span class="pill' + (leave <= 15 ? ' pill--soon' : '') + '">' + App.icon('car', 20) + 'Leave in ' + App.fmt.mins(leave) + '</span>';
    }
    return '<button class="h-hero" style="' + App.pstyle(p) + '" data-ev="' + e.id + '">' +
      '<div class="h-hero-main">' +
      '  <div class="label label--on">' + (savedBusy ? 'Saved busy time' : 'Next up') + ' · ' + App.esc(whoText) + '</div>' +
      '  <div class="h-hero-title serif">' + App.esc(e.title) + '</div>' +
      '  <div class="h-hero-meta">' + App.fmt.range(e.start, e.end) + (e.loc ? ' · ' + App.esc(e.loc) : '') + '</div>' +
      '  <div class="h-hero-foot">' + (e.people.length > 1 ? App.dots(e.people, 22) : '') + leavePill + '</div>' +
      '</div>' + big + '</button>';
  }

  function lanes() {
    var now = App.now();
    return D.people.map(function (p) {
      var list = App.timedOn(now, p.id).filter(function (e) { return e.end > now; });
      var shown = list.slice(0, 3), more = list.length - shown.length;
      var missingAvailability = unavailable(p, now);
      return '<div class="h-lane" style="' + App.pstyle(p) + '">' +
        '<div class="h-lane-head">' + App.avatar(p, 30) + '<b>' + App.esc(p.name) + '</b></div>' +
        (missingAvailability && list.length ? '<div class="label">Saved busy times</div>' : '') +
        (list.length ? shown.map(function (e) {
          var cur = e.start <= now;
          return '<button class="h-ev' + (cur ? ' is-now' : '') + '" data-ev="' + e.id + '">' +
            '<span class="h-ev-t">' + (cur ? 'Now' : App.fmt.time(e.start, false)) + '</span>' +
            '<span class="h-ev-n">' + App.esc(e.title) + '</span></button>';
        }).join('') : '<div class="h-free serif">' + (missingAvailability ? '<i>Availability unavailable</i>' : '<i>Free</i> the rest of the day') + '</div>') +
        (more > 0 ? '<button class="h-more" data-go="calendar">+' + more + ' more</button>' : '') +
        '</div>';
    }).join('');
  }

  function shopping() {
    var open = D.groceries.filter(function (g) { return !g.done; });
    var recent = open.slice(-3).reverse();
    return '<div class="label">Shopping</div>' +
      '<div class="h-stat"><span class="num">' + open.length + '</span><small>items to get</small></div>' +
      '<ul class="h-recent">' + recent.map(function (g) {
        return '<li><i></i>' + App.esc(g.name) + '</li>';
      }).join('') + '</ul>';
  }

  function status() {
    var lights = App.lights.summary(), unavailable = App.lights.counts().unavailable;
    var ready = App.cameras.canView(App.cameras.doorbell());
    return '<div class="h-status-heading"><button type="button" class="label h-status-title" data-go="control">Home</button>' +
      '<button type="button" class="h-doorbell" data-doorbell aria-label="' + (ready ? 'Watch doorbell camera' : 'Doorbell camera unavailable') + '"' +
      (!ready ? ' disabled' : '') + '>' + App.icon('play', 20) + 'Doorbell</button></div>' +
      '<button type="button" class="h-status-readings" data-go="control" aria-label="Open Home controls">' +
      '<div class="h-st-row">' + App.icon('bulb', 24) + '<b class="num">' + lights.value + '</b><span>' + (lights.value === '—' ? App.esc(lights.detail) : 'lights on' + (unavailable ? ' · ' + unavailable + ' unavailable' : '')) + '</span></div>' +
      climateFavorites(App.climate.devices).map(function (room, index) {
        return '<div class="h-st-row h-st-temp' + (index < 2 ? ' h-st-temp--bedroom' : '') + '">' + App.icon('thermo', 24) + '<span>' + App.esc(room.name) + '</span>' +
          '<b class="num">' + App.climate.temperature(room.device) + '</b></div>';
      }).join('') + '</button>';
  }

  var parts = { clock: clock, weather: weather, 'hero-slot': hero, lanes: lanes, shop: shopping, status: status };
  function paint(names) {
    if (!V.el || !V.el.firstChild) return;
    if (!names) V.el.querySelector('.h-lanes').style.gridTemplateColumns = 'repeat(' + D.people.length + ', 1fr)';
    (names || Object.keys(parts)).forEach(function (name) {
      V.el.querySelector('.h-' + name).innerHTML = parts[name]();
    });
  }

  App.register('home', {
    show: function (el) {
      V.el = el;
      if (!el.firstChild) {
        el.innerHTML = '<div class="home">' +
          '<div class="h-clock" data-go="calendar"></div>' +
          '<div class="h-weather"></div>' +
          '<div class="h-main"><div class="h-hero-slot"></div><div class="h-lanes" ></div></div>' +
          '<div class="h-side">' +
          '  <button type="button" class="h-shop card" data-go="shopping"></button>' +
          '  <section class="h-status card" aria-label="Home"></section>' +
          '</div></div>';
        el.addEventListener('click', function (e) {
          var doorbell = e.target.closest('[data-doorbell]');
          if (doorbell && !doorbell.disabled) { App.openDoorbell(); return; }
          var ev = e.target.closest('[data-ev]');
          if (ev) { App.eventSheet(App.findEvent(ev.dataset.ev)); return; }
          var g = e.target.closest('[data-go]');
          if (g) App.go(g.dataset.go);
        });
      }
      paint();
    },
    hide: function () { App.closeCameras('home'); }
  });
  // Every minute: just the clock and next-up countdown (cheap, even while hidden). Weather on the hour.
  App.on('minute', function (n) {
    var names = n.getMinutes() === 0 ? ['clock', 'hero-slot', 'weather', 'lanes'] : ['clock', 'hero-slot'];
    if (n.getMinutes() !== 0 && D.people.some(function (source) { return source.kind === 'availability'; })) names.push('lanes');
    paint(names);
  });
  App.on('weather', function () { paint(['weather']); });
  App.on('climate', function () { paint(['status']); });
  App.on('lights', function () { paint(['status']); });
  App.on('cameras', function () { paint(['status']); });
  App.on('data', function () { if (App.current === 'home') paint(); });
})();
