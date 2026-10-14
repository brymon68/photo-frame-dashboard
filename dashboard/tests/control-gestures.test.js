import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { climateTemperature, climateDetails } from '../js/climate-feed.js';
import { parseLights, lightStatus, lightCounts } from '../js/lights-feed.js';

const script = readFileSync(new URL('../js/views/control.js', import.meta.url), 'utf8');

// Only model the DOM operations used by the control view; exercise its registered
// handlers and rendered tiles without exposing or rewriting private functions.
class Element {
  constructor(width = 200) {
    this.width = width;
    this.dataset = {};
    this.listeners = {};
    this.parts = new Map();
    this.tiles = [];
    this.classes = new Set();
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
      contains: name => this.classes.has(name)
    };
  }
  set innerHTML(html) {
    this.html = html;
    this.tiles = Array.from(html.matchAll(/<button type="button" class="(tile [^"]+)" data-(dev|light)="([^"]+)"/g), match => {
      const tile = new Element(this.width);
      tile.dataset[match[2]] = match[3];
      tile.classes = new Set(match[1].split(' '));
      tile.parts.set('.tile-state', { textContent: '' });
      tile.parentNode = this;
      return tile;
    });
  }
  get firstChild() { return this.tiles[0]; }
  querySelector(selector) {
    const id = selector.match(/^\[data-(dev|light)="([^"]+)"\]$/);
    return id ? this.tiles.find(tile => tile.dataset[id[1]] === id[2]) : this.parts.get(selector) || null;
  }
  querySelectorAll(selector) { return selector === '[data-dev]' ? this.tiles.filter(tile => tile.dataset.dev) : []; }
  replaceChild(next, old) {
    this.tiles.splice(this.tiles.indexOf(old), 1, next);
    next.width = old.width;
    next.parentNode = this;
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  fire(name, props = {}) { (this.listeners[name] || []).forEach(fn => fn({ pointerId: 1, clientX: 0, ...props })); }
  getBoundingClientRect() { return { width: this.width, height: this.height || 800 }; }
  setPointerCapture(id) { this.captured = id; }
}

function fixture(scale = 1) {
  const data = {
    devices: [
      { id: 'light', type: 'light', name: 'Lamp', room: 'room', on: true, level: 40 },
      { id: 'off', type: 'light', name: 'Spare', room: 'room', on: false, level: 0 },
      { id: 'blind', type: 'blind', name: 'Blinds', room: 'room', pos: 50 },
      { id: 'lock', type: 'lock', name: 'Door', room: 'room', locked: true },
      { id: 'g-door', type: 'garage', name: 'Garage', room: 'room', state: 'closed' }
    ],
    rooms: [{ id: 'room', name: 'Room' }], scenes: [], cameras: [],
    climate: { current: 20, set: 21, humidity: 40, mode: 'heat' },
    media: { playing: false, room: 'Room', title: 'Song', artist: 'Artist', seed: 'album' }
  };
  const root = new Element(), stage = new Element(), timers = [], toasts = [];
  stage.height = 800 * scale;
  for (const cls of ['sum', 'scenes', 'rooms', 'climate', 'cams', 'media']) root.parts.set('.hc-' + cls, new Element(200 * scale));
  let view, sheet, now = 10000;
  const handlers = {};
  class Clock extends Date { static now() { return now; } }
  const App = {
    register: (name, registered) => { view = registered; },
    icon: () => '', img: () => '', emit: name => handlers[name]?.(), on: (name, fn) => { handlers[name] = fn; },
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    homeControls: { pending: {}, canLight: d => lightStatus(d) !== 'Unavailable', canClimate: d => d.mode !== 'unavailable', toggleLight: id => toasts.push({ toggle: id }), openClimate: id => toasts.push({ climate: id }) },
    climate: { devices: [], temperature: climateTemperature, details: climateDetails, label: () => 'Connect Home Assistant' },
    $: () => stage, $$: (selector, el) => el.querySelectorAll(selector),
    hold: (el, ms, callbacks) => { el.hold = { ms, ...callbacks }; },
    toast: (html, opts) => toasts.push({ html, ...opts }),
    sheet: (html, opts) => {
      sheet = new Element(200 * scale);
      sheet.innerHTML = html;
      sheet.parts.set('.tiles--sheet', sheet);
      for (const [cls, width] of [['slide-confirm', 400], ['sc-knob', 76], ['sc-fill', 0]]) {
        sheet.parts.set('.' + cls, new Element(width * scale));
      }
      for (const attr of ['alloff', 'lockall']) {
        if (html.includes('data-' + attr)) sheet.parts.set('[data-' + attr + ']', new Element());
      }
      sheet.close = () => { sheet.closed = true; if (opts.onClose) opts.onClose(); };
      if (opts.onMount) opts.onMount(sheet, sheet.close);
    }
  };
  App.lights = {
    ...parseLights({ rooms: [{ id: 'room', name: 'Room' }, { id: 'empty', name: 'Empty' }], lights: [
      { id: 'light.lamp', name: 'Lamp', room: 'room', state: 'on' },
      { id: 'switch.ceiling_lights', name: 'Ceiling', room: 'room', state: 'off' },
      { id: 'light.orphan', name: '<img src=x>', room: null, state: 'unavailable' }
    ] }),
    status: lightStatus, counts: list => lightCounts(list || App.lights.lights),
    summary: () => ({ value: 1, detail: '1 on · 1 unavailable' }), label: () => 'No lights'
  };
  vm.runInNewContext(script, {
    window: { DATA: data }, App, Date: Clock,
    document: { createElement: () => new Element() },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    setInterval() {}, clearInterval() {}
  });
  view.show(root);
  return {
    App, data, root, timers, toasts,
    show: () => view.show(root),
    tile: (id, box = sheet || root.parts.get('.hc-rooms')) => box.querySelector('[data-dev="' + id + '"]'),
    device: id => data.devices.find(d => d.id === id),
    click: (selector, dataset) => root.fire('click', { target: { closest: match => match === selector ? { dataset } : null } }),
    get sheet() { return sheet; },
    advance: ms => { now += ms; }
  };
}

function drag(tile, distance, end = 'pointerup') {
  tile.fire('pointerdown', { clientX: 100 });
  tile.fire('pointermove', { clientX: 100 + distance });
  tile.fire(end);
}

test('Home renders live light buttons and explicit unavailable states', () => {
  const f = fixture(), rooms = f.root.parts.get('.hc-rooms');
  assert.match(rooms.html, /data-light="light.lamp"/);
  assert.match(rooms.html, /data-light="switch.ceiling_lights"/);
  assert.match(rooms.html, />On</);
  assert.match(rooms.html, />Off</);
  assert.match(rooms.html, />Unavailable</);
  assert.match(rooms.html, /Unassigned/);
  assert.match(rooms.html, /No lights/);
  assert.match(rooms.html, /&lt;img/);
  assert.doesNotMatch(rooms.html, /data-dev=|tile-fill|<img/);
  assert.doesNotMatch(f.root.html, /hc-scenes/);
  for (const tile of rooms.tiles) {
    drag(tile, 100);
    tile.fire('click');
    assert.deepEqual(tile.listeners, {});
  }
  f.click('[data-light]', { light: 'light.lamp' });
  assert.equal(f.toasts[0].toggle, 'light.lamp');
  assert.match(rooms.html, /aria-pressed="true"/);
  assert.match(rooms.html, /data-light="light.orphan"[^>]+disabled/);
  assert.equal(f.App.lights.lights.find(l => l.id === 'light.lamp').state, 'on');
});

test('Home only renders live rooms and climate, preserving room scroll across updates', () => {
  const f = fixture(), rooms = f.root.parts.get('.hc-rooms');
  assert.doesNotMatch(f.root.html, /hc-sum|hc-scenes|hc-cams|hc-media/);
  assert.match(f.root.html, /hc-rooms/);
  assert.match(f.root.html, /hc-climate/);
  rooms.scrollTop = 137;
  f.App.lights.lights.find(l => l.id === 'light.lamp').state = 'off';
  f.App.emit('lights');
  assert.doesNotMatch(rooms.html, /is-on/);
  assert.equal(rooms.scrollTop, 137);
  f.show();
  assert.equal(rooms.scrollTop, 137);
});

test('garage requires a completed slide at either display scale', () => {
  for (const scale of [1, 0.5]) {
    const f = fixture(scale);
    f.App.openGarageSheet();
    const knob = f.sheet.querySelector('.sc-knob');
    drag(knob, 100 * scale);
    assert.equal(f.device('g-door').state, 'closed');
    assert.equal(knob.style.transform, '');
    drag(knob, 400 * scale);
    assert.equal(f.sheet.closed, true);
    assert.equal(f.device('g-door').state, 'opening');
    f.timers.find(t => t.ms === 4000).fn();
    assert.equal(f.device('g-door').state, 'open');
    f.App.openGarageSheet();
    drag(f.sheet.querySelector('.sc-knob'), 400 * scale);
    assert.equal(f.device('g-door').state, 'closing');
  }
});

test('cancelling a garage slide clears progress and cannot confirm on the next tap', () => {
  const f = fixture();
  f.App.openGarageSheet();
  const knob = f.sheet.querySelector('.sc-knob'), fill = f.sheet.querySelector('.sc-fill');
  drag(knob, 400, 'pointercancel');
  assert.equal(knob.style.transform, '');
  assert.equal(fill.style.width, '');
  knob.fire('pointerup');
  assert.equal(f.device('g-door').state, 'closed');
  knob.fire('pointerdown');
  knob.fire('pointerup');
  assert.equal(f.device('g-door').state, 'closed');
  drag(knob, 400);
  assert.equal(f.device('g-door').state, 'opening');
});

test('Home renders one climate control per device and escapes names', () => {
  const f = fixture();
  f.App.climate.devices = [
    { id: 'climate.hallway', name: 'Hallway', temperature: 73, mode: 'cool', activity: 'idle', target: 74 },
    { id: 'climate.bedroom', name: '<img src=x onerror=alert(1)>', temperature: null }
  ];
  f.show();
  const html = f.root.parts.get('.hc-climate').html;
  assert.equal((html.match(/data-climate=/g) || []).length, 2);
  assert.match(html, /<button/);
  f.click('[data-climate]', { climate: 'climate.hallway' });
  assert.equal(f.toasts[0].climate, 'climate.hallway');
  assert.match(html, /Hallway/);
  assert.match(html, /73°/);
  assert.match(html, /Cool · Idle/);
  assert.match(html, /Target/);
  assert.match(html, /74°/);
  assert.match(html, /&lt;img/);
  assert.match(html, /—/);
  assert.doesNotMatch(html, /data-temp|data-tmode|Set to|humidity|<img/);
});
