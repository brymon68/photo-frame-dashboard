// Home: live room lights and climate controls.
import { bindLightSlider } from '../light-slider.js';
import { climateFavorites } from '../climate-favorites.js';
import { createCameraPlayer } from '../camera-player.js';
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
    var slider = light.dimmable, level = status === 'Unavailable' ? 0 : light.level || 0;
    return '<button type="button" class="tile tile--light' + (slider ? ' tile--dimmer' : '') + (status === 'On' ? ' is-on' : '') + '" data-light="' + App.esc(light.id) + '"' +
      (slider ? ' style="--lvl:' + level + '%" role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + level + '" aria-valuetext="' + (status === 'Unavailable' ? status : light.level == null ? 'Brightness unknown' : level + '%') + '"' : ' aria-pressed="' + (status === 'On') + '"') +
      ' aria-label="' + App.esc(light.name) + ' · ' + status + (status !== 'Unavailable' ? ' · tap to turn ' + (status === 'On' ? 'off' : 'on') + (slider ? ' · drag to dim' : '') : '') + '" aria-busy="' + !!pending + '"' +
      (!App.homeControls.canLight(light) || pending ? ' disabled' : '') + '>' +
      (slider ? '<span class="tile-fill"></span>' : '') +
      '<span class="tile-icon">' + App.icon('bulb', 28) + '</span>' +
      '<span class="tile-name">' + App.esc(light.name) + '</span>' +
      '<span class="tile-state">' + (pending ? 'Updating…' : slider && status === 'On' && light.level != null ? light.level + '%' : status) + '</span>' +
      (slider ? '<span class="tile-hint">Drag to dim</span>' : '') + '</button>';
  }

  function rooms() {
    var feed = App.lights;
    if (!feed.rooms.length) return '<div class="room-empty">' + App.esc(feed.label()) + '</div>';
    // Empty HA areas have no Home controls to show.
    var occupied = feed.rooms.filter(function (room) { return feed.lights.some(function (light) { return light.room === room.id; }); });
    if (!occupied.length) return '<div class="room-empty">' + App.esc(feed.label()) + '</div>';
    return occupied.map(function (room) {
      var list = feed.lights.filter(function (light) { return light.room === room.id; });
      return '<section class="room"><div class="room-h"><h3 class="serif">' + App.esc(room.name) + '</h3>' +
        '<span class="label">' + feed.counts(list).label + '</span></div>' +
        (list.length ? '<div class="tiles">' + list.map(lightTile).join('') + '</div>' : '') + '</section>';
    }).join('');
  }

  function climateCard(device, name, favorite) {
    var c = App.climate, details = c.details(device);
    var pending = device && App.homeControls.pending[device.id];
    return '<button type="button" class="climate-card' + (favorite ? ' climate-card--favorite' : '') + (details.tone ? ' is-' + details.tone : '') + '"' +
      (device ? ' data-climate="' + App.esc(device.id) + '"' : '') + ' aria-label="Adjust ' + App.esc(name) + ' temperature" aria-busy="' + !!pending + '"' +
      (!device || !App.homeControls.canClimate(device) || pending ? ' disabled' : '') + '>' +
      '<span class="label label--light">' + App.esc(name) + '</span>' +
      '<span class="num">' + c.temperature(device) + '</span>' +
      '<div class="climate-details"><span class="climate-mode">' + (pending ? 'Updating…' : App.esc(details.status)) + '</span>' +
      '<span class="climate-target"><span>Target</span> <b class="num">' + App.esc(details.target) + '</b></span></div></button>';
  }

  function favorites() {
    return '<div class="hc-favorites-heading"><h3 class="serif">Favorites</h3>' +
      '<div class="hc-camera-shortcuts"><button type="button" class="hc-cameras-button" data-doorbell aria-label="Watch doorbell camera"' +
      (!App.cameras.canView(App.cameras.doorbell()) ? ' disabled' : '') + '>' + App.icon('play', 23) + 'Doorbell</button>' +
      '<button type="button" class="hc-cameras-button" data-cameras>' + App.icon('film', 23) + 'Cameras</button></div></div><div class="hc-favorite-cards">' + climateFavorites(App.climate.devices).map(function (room) {
      return climateCard(room.device, room.name, true);
    }).join('') + '</div>';
  }

  function climate() {
    var c = App.climate;
    if (!c.devices.length) return '<div class="climate-card climate-card--empty"><span class="label label--light">' + c.label() + '</span><span class="num">—</span></div>';
    return c.devices.map(function (device) { return climateCard(device, device.name); }).join('');
  }

  // These explicit demo actions are still used by the hidden demo drawer.
  function changed() { App.emit('data'); }

  var parts = { favorites: favorites, rooms: rooms, climate: climate };
  function paint(names) {
    if (!V.el) return;
    (names || Object.keys(parts)).forEach(function (name) {
      if (name === 'rooms' && V.dragging) return;
      var el = V.el.querySelector('.hc-' + name), scroll = name === 'rooms' ? el.scrollTop : 0;
      el.innerHTML = parts[name]();
      if (name === 'rooms') {
        el.scrollTop = scroll;
        App.$$('[data-light]', el).forEach(function (tile) {
          var light = App.lights.lights.find(function (item) { return item.id === tile.dataset.light; });
          if (!light.dimmable) return;
          bindLightSlider(tile, light, App.homeControls, {
            start: function () { V.dragging = true; V.suppress = null; },
            end: function (suppressClick) {
              V.dragging = false;
              if (suppressClick) V.suppress = { id: light.id, until: Date.now() + 800 };
              // Let a normal tap dispatch before replacing its button.
              setTimeout(function () { paint(['rooms']); }, 0);
            }
          });
        });
      }
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

  var cameraDialog = null;
  function openCameras(initialCamera) {
    var selected = null, player = null, content = null, panel = null, closeDialog = null;
    function stopPlayer() { if (player) { player.stop(); player = null; } }
    function available() {
      var device = selected && App.cameras.devices.find(function (camera) { return camera.id === selected.id; });
      return App.cameras.canView(device);
    }
    function gallery() {
      stopPlayer(); selected = null;
      panel.classList.remove('sheet--camera-viewer');
      var feed = App.cameras;
      content.innerHTML = '<div class="camera-gallery-heading"><div><div class="label">Home</div><h2 class="serif sheet-h">Cameras</h2></div>' +
        '<button type="button" class="camera-refresh" data-camera-refresh' + (!feed.configured ? ' disabled' : '') + '>Refresh</button></div>' +
        '<p class="sheet-p">Select a camera to start streaming.</p>' +
        (feed.devices.length ? '<div class="camera-grid">' + feed.devices.map(function (camera) {
          var ready = feed.canView(camera);
          return '<button type="button" class="camera-tile" data-camera="' + App.esc(camera.id) + '"' + (!ready ? ' disabled' : '') +
            ' aria-label="' + App.esc(camera.name) + ' · ' + feed.status(camera) + '">' +
            '<span class="camera-tile-art">' + App.icon('film', 46) + (ready ? '<span class="camera-tile-play">' + App.icon('play', 22) + '</span>' : '') + '</span>' +
            '<span class="camera-tile-name">' + App.esc(camera.name) + '</span><span class="camera-tile-state">' + feed.status(camera) + '</span></button>';
        }).join('') + '</div>' : '<div class="camera-empty" role="status">' + App.esc(feed.label()) + '</div>');
    }
    function viewer(camera) {
      stopPlayer(); selected = camera;
      panel.classList.add('sheet--camera-viewer');
      content.innerHTML = '<div class="camera-viewer-heading"><button type="button" class="camera-back" data-camera-back>' + App.icon('left', 24) + 'Cameras</button>' +
        '<h2 class="serif">' + App.esc(camera.name) + '</h2></div>' +
        '<div class="camera-screen"><video class="camera-stream" muted autoplay playsinline aria-label="' + App.esc(camera.name) + ' camera stream"></video>' +
        '<div class="camera-message" role="status" aria-live="polite"></div></div>' +
        '<div class="camera-viewer-footer"><span class="camera-stream-status" role="status" aria-live="polite"></span>' +
        '<button type="button" class="camera-retry" data-camera-retry hidden>Retry stream</button></div>';
      var media = content.querySelector('.camera-stream'), message = content.querySelector('.camera-message');
      var status = content.querySelector('.camera-stream-status'), retry = content.querySelector('[data-camera-retry]');
      player = createCameraPlayer(media, { onState: function (state, detail) {
        media.hidden = state !== 'streaming';
        message.hidden = state === 'streaming';
        message.textContent = state === 'connecting' ? 'Connecting to camera…' : detail || 'Stream stopped.';
        status.textContent = state === 'streaming' ? 'Streaming · video only' : state === 'connecting' ? 'Connecting…' : 'Stream unavailable';
        status.classList.toggle('is-streaming', state === 'streaming');
        retry.hidden = state !== 'error'; retry.disabled = !available();
      } });
      player.start(camera.id);
    }
    App.sheet('<div class="sheet-pad camera-dialog"></div>', {
      cls: 'sheet--cameras',
      onClose: function () { stopPlayer(); cameraDialog = null; },
      onMount: function (sheet, close) {
        closeDialog = close; panel = sheet; content = sheet.querySelector('.camera-dialog');
        content.addEventListener('click', function (event) {
          var button = event.target.closest('button');
          if (!button || button.disabled) return;
          if (button.hasAttribute('data-camera-back')) { gallery(); return; }
          if (button.hasAttribute('data-camera-refresh')) {
            button.disabled = true; button.textContent = 'Refreshing…';
            App.cameras.refresh(); return;
          }
          if (button.hasAttribute('data-camera-retry')) { if (available()) viewer(selected); return; }
          var camera = App.cameras.devices.find(function (item) { return item.id === button.dataset.camera; });
          if (App.cameras.canView(camera)) viewer(camera);
        });
        if (initialCamera && App.cameras.canView(initialCamera)) viewer(initialCamera);
        else gallery();
      }
    });
    cameraDialog = {
      owner: App.current,
      close: closeDialog,
      refresh: function () {
        if (!selected) gallery();
        else if (!available() && player) player.fail('Camera unavailable. Return to Cameras and refresh.');
        else if (selected) content.querySelector('[data-camera-retry]').disabled = !available();
      }
    };
    App.cameras.refresh();
  }
  App.openDoorbell = function () {
    var camera = App.cameras.doorbell();
    if (App.cameras.canView(camera)) openCameras(camera);
  };
  App.closeCameras = function (owner) {
    if (cameraDialog && (!owner || cameraDialog.owner === owner)) cameraDialog.close();
  };
  App.on('cameras', function () {
    paint(['favorites']);
    if (cameraDialog) cameraDialog.refresh();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && cameraDialog) cameraDialog.close();
  });

  App.on('climate', function () { paint(['favorites', 'climate']); });
  App.on('lights', function () { paint(['rooms']); });

  App.register('control', {
    show: function (el) {
      if (!V.el) {
        V.el = el;
        el.innerHTML = '<div class="hc">' +
          '<section class="hc-favorites" aria-label="Favorites"></section>' +
          '<div class="hc-left"><div class="hc-rooms"></div></div>' +
          '<div class="hc-right"><div class="hc-climate"></div></div>' +
          '</div>';
        el.addEventListener('click', function (event) {
          if (event.target.closest('[data-doorbell]')) { App.openDoorbell(); return; }
          if (event.target.closest('[data-cameras]')) { openCameras(); return; }
          var light = event.target.closest('[data-light]');
          if (light && !light.disabled) {
            if (event.detail !== 0 && V.suppress && V.suppress.id === light.dataset.light && Date.now() < V.suppress.until) return;
            App.homeControls.toggleLight(light.dataset.light); return;
          }
          var climate = event.target.closest('[data-climate]');
          if (climate && !climate.disabled) App.homeControls.openClimate(climate.dataset.climate);
        });
      }
      paint();
    },
    hide: function () { App.closeCameras('control'); }
  });
})();
