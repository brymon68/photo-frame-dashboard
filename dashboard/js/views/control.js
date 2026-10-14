// Home: live room lights and climate controls.
(function () {
  'use strict';
  var D = window.DATA;
  var V = { el: null, pending: {}, camAge: 4 };

  function dev(id) { return D.devices.find(function (d) { return d.id === id; }); }

  // Optimistic device update: flip immediately, confirm (or revert) shortly after.
  App.setDevice = function (id, patch, opts) {
    var d = dev(id), before = {};
    Object.keys(patch).forEach(function (k) { before[k] = d[k]; d[k] = patch[k]; });
    V.pending[id] = true;
    changed([id]);
    setTimeout(function () {
      delete V.pending[id];
      if (d.flaky && !(opts && opts.silent)) {
        Object.keys(before).forEach(function (k) { d[k] = before[k]; });
        App.toast('Couldn’t reach <b>' + d.name + '</b> · it may be offline', { tone: 'error', icon: 'bolt' });
        changed([id]);
      } else changed();
    }, d.flaky ? 2600 : 600);
  };

  function lightTile(light) {
    var status = App.lights.status(light), pending = App.homeControls.pending[light.id];
    return '<button type="button" class="tile tile--light' + (status === 'On' ? ' is-on' : '') + '" data-light="' + App.esc(light.id) + '"' +
      ' aria-label="' + App.esc(light.name) + ' · ' + status + (status !== 'Unavailable' ? ' · tap to turn ' + (status === 'On' ? 'off' : 'on') : '') + '" aria-pressed="' + (status === 'On') + '" aria-busy="' + !!pending + '"' +
      (!App.homeControls.canLight(light) || pending ? ' disabled' : '') + '>' +
      '<span class="tile-icon">' + App.icon('bulb', 28) + '</span>' +
      '<span class="tile-name">' + App.esc(light.name) + '</span>' +
      '<span class="tile-state">' + (pending ? 'Updating…' : status) + '</span></button>';
  }

  function rooms() {
    var feed = App.lights;
    if (!feed.rooms.length) return '<div class="room-empty">' + App.esc(feed.label()) + '</div>';
    // Keep rooms containing lights in view ahead of empty areas.
    var occupied = feed.rooms.filter(function (room) { return feed.lights.some(function (light) { return light.room === room.id; }); });
    var empty = feed.rooms.filter(function (room) { return occupied.indexOf(room) < 0; });
    return occupied.concat(empty).map(function (room) {
      var list = feed.lights.filter(function (light) { return light.room === room.id; });
      return '<section class="room"><div class="room-h"><h3 class="serif">' + App.esc(room.name) + '</h3>' +
        '<span class="label">' + feed.counts(list).label + '</span></div>' +
        (list.length ? '<div class="tiles">' + list.map(lightTile).join('') + '</div>' : '') + '</section>';
    }).join('');
  }

  function climate() {
    var c = App.climate;
    if (!c.devices.length) return '<div class="climate-card climate-card--empty"><span class="label label--light">' + c.label() + '</span><span class="num">—</span></div>';
    return c.devices.map(function (device) {
      var details = c.details(device);
      var pending = App.homeControls.pending[device.id];
      return '<button type="button" class="climate-card' + (details.tone ? ' is-' + details.tone : '') + '" data-climate="' + App.esc(device.id) + '" aria-label="Adjust ' + App.esc(device.name) + ' temperature" aria-busy="' + !!pending + '"' +
        (!App.homeControls.canClimate(device) || pending ? ' disabled' : '') + '>' +
        '<span class="label label--light">' + App.esc(device.name) + '</span>' +
        '<span class="num">' + c.temperature(device) + '</span>' +
        '<div class="climate-details"><span class="climate-mode">' + (pending ? 'Updating…' : App.esc(details.status)) + '</span>' +
        '<span class="climate-target"><span>Target</span> <b class="num">' + App.esc(details.target) + '</b></span></div></button>';
    }).join('');
  }

  // These explicit demo actions are still used by the hidden demo drawer.
  function changed() { App.emit('data'); }

  var parts = { rooms: rooms, climate: climate };
  function paint(names) {
    if (!V.el) return;
    (names || Object.keys(parts)).forEach(function (name) {
      var el = V.el.querySelector('.hc-' + name), scroll = name === 'rooms' ? el.scrollTop : 0;
      el.innerHTML = parts[name]();
      if (name === 'rooms') el.scrollTop = scroll;
    });
  }

  // Slide-to-confirm for the garage
  App.openGarageSheet = function () {
    var g = dev('g-door'), opening = g.state === 'closed';
    App.sheet('<div class="sheet-pad"><div class="label">Garage door · currently ' + g.state + '</div><h2 class="serif sheet-h">' + (opening ? 'Open' : 'Close') + ' the garage?</h2>' +
      '<p class="sheet-p">' + (opening ? 'Make sure the driveway is clear.' : 'The door will stop and reverse if anything is in the way.') + '</p>' +
      '<div class="slide-confirm"><span class="sc-label">Slide to ' + (opening ? 'open' : 'close') + ' →</span><span class="sc-fill"></span><span class="sc-knob">' + App.icon('garage', 30) + '</span></div></div>', {
      onMount: function (s, close) {
        var track = s.querySelector('.slide-confirm'), knob = s.querySelector('.sc-knob'), fill = s.querySelector('.sc-fill');
        var sx = null, max, x = null, limit;
        function reset() {
          sx = null; x = null;
          knob.style.transform = ''; fill.style.width = '';
        }
        knob.addEventListener('pointerdown', function (e) {
          reset();
          sx = e.clientX; max = track.getBoundingClientRect().width - knob.getBoundingClientRect().width - 8;
          knob.setPointerCapture(e.pointerId);
        });
        knob.addEventListener('pointermove', function (e) {
          if (sx == null) return;
          var k = App.$('#stage').getBoundingClientRect().height / 800;
          limit = max / k;
          x = Math.max(0, Math.min(limit, (e.clientX - sx) / k));
          knob.style.transform = 'translateX(' + x + 'px)';
          fill.style.width = (x + 76) + 'px';
        });
        knob.addEventListener('pointerup', function () {
          if (sx == null) return;
          sx = null;

          if (x !== null && x >= limit - 6) {
            close();
            g.state = opening ? 'opening' : 'closing';
            changed(['g-door']);
            setTimeout(function () { g.state = opening ? 'open' : 'closed'; changed(['g-door']); App.toast('Garage ' + g.state, { icon: 'garage', ms: 2500 }); }, 4000);
          } else reset();
        });
        knob.addEventListener('pointercancel', reset);
      }
    });
  };

  App.cameraSheet = function (c) {
    App.sheet('<div class="cam-big"><img src="' + App.img(c.seed, 1200, 750) + '" alt=""><div class="cam-big-bar"><span class="tk-live"><i></i>' + c.name + '</span><span class="label label--light">Snapshot · ' + V.camAge + 's ago</span></div></div>', { cls: 'sheet--cam' });
  };

  App.on('climate', function () { paint(['climate']); });
  App.on('lights', function () { paint(['rooms']); });

  App.register('control', {
    show: function (el) {
      if (!V.el) {
        V.el = el;
        el.innerHTML = '<div class="hc">' +
          '<div class="hc-left"><div class="hc-rooms"></div></div>' +
          '<div class="hc-right"><div class="hc-climate"></div></div>' +
          '</div>';
        el.addEventListener('click', function (event) {
          var light = event.target.closest('[data-light]');
          if (light && !light.disabled) { App.homeControls.toggleLight(light.dataset.light); return; }
          var climate = event.target.closest('[data-climate]');
          if (climate && !climate.disabled) App.homeControls.openClimate(climate.dataset.climate);
        });
      }
      paint();
    }
  });
})();
