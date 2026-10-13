import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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
    this.tiles = Array.from(html.matchAll(/<div class="(tile [^"]+)" data-dev="([^"]+)"/g), match => {
      const tile = new Element(this.width);
      tile.dataset.dev = match[2];
      tile.classes = new Set(match[1].split(' '));
      tile.parts.set('.tile-state', { textContent: '' });
      tile.parentNode = this;
      return tile;
    });
  }
  get firstChild() { return this.tiles[0]; }
  querySelector(selector) {
    const id = selector.match(/^\[data-dev="([^"]+)"\]$/);
    return id ? this.tiles.find(tile => tile.dataset.dev === id[1]) : this.parts.get(selector) || null;
  }
  querySelectorAll(selector) { return selector === '[data-dev]' ? this.tiles : []; }
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
  class Clock extends Date { static now() { return now; } }
  const App = {
    register: (name, registered) => { view = registered; },
    icon: () => '', img: () => '', emit() {},
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
  vm.runInNewContext(script, {
    window: { DATA: data }, App, Date: Clock,
    document: { createElement: () => new Element() },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    setInterval() {}, clearInterval() {}
  });
  view.show(root);
  return {
    App, data, root, timers, toasts,
    tile: (id, box = root.parts.get('.hc-rooms')) => box.querySelector('[data-dev="' + id + '"]'),
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

test('light and blind taps toggle, preserving remembered light brightness', () => {
  const f = fixture();
  drag(f.tile('light'), 10); // Ten pixels remains a tap, not a drag.
  assert.equal(f.device('light').on, false);
  assert.equal(f.device('light').level, 40);
  drag(f.tile('light'), 0);
  assert.equal(f.device('light').on, true);
  assert.equal(f.device('light').level, 40);
  drag(f.tile('off'), 0);
  assert.equal(f.device('off').level, 100);
  drag(f.tile('blind'), 0);
  assert.equal(f.device('blind').pos, 0);
  drag(f.tile('blind'), 0);
  assert.equal(f.device('blind').pos, 100);
});

test('horizontal drags use rendered tile width and clamp light and blind levels', () => {
  for (const scale of [1, 0.5]) {
    const f = fixture(scale), tile = f.tile('light');
    tile.fire('pointerdown', { clientX: 100 });
    tile.fire('pointermove', { clientX: 100 + 50 * scale });
    assert.equal(tile.style['--lvl'], '65%');
    assert.equal(tile.querySelector('.tile-state').textContent, '65%');
    assert.equal(tile.classList.contains('is-drag'), true);
    assert.equal(tile.captured, 1);
    tile.fire('pointerup');
    assert.equal(f.device('light').level, 65);
    assert.equal(tile.classList.contains('is-drag'), false);
    drag(f.tile('light'), -500);
    assert.equal(f.device('light').on, false);
    assert.equal(f.device('light').level, 65);
    drag(f.tile('light'), 40 * scale);
    assert.equal(f.device('light').level, 20); // Off lights start at zero.
    drag(f.tile('blind'), 500);
    assert.equal(f.device('blind').pos, 100);
    drag(f.tile('blind'), -500);
    assert.equal(f.device('blind').pos, 0);
  }
});

test('cancelled light drags restore the tile without committing and remain usable', () => {
  const f = fixture(), old = f.tile('light');
  drag(old, 60, 'pointercancel');
  assert.equal(f.device('light').level, 40);
  assert.equal(old.classList.contains('is-drag'), false);
  old.fire('pointerup');
  assert.equal(f.device('light').level, 40);
  assert.notEqual(f.tile('light'), old);
  drag(f.tile('light'), 60);
  assert.equal(f.device('light').level, 70);
});

test('sheet sliders update both copies and bulk light undo restores state', () => {
  const f = fixture();
  f.click('[data-sum]', { sum: 'lights' });
  const oldMain = f.tile('light'), oldSheet = f.tile('light', f.sheet);
  drag(oldSheet, 60);
  assert.equal(f.device('light').level, 70);
  assert.notEqual(f.tile('light'), oldMain);
  assert.notEqual(f.tile('light', f.sheet), oldSheet);
  drag(f.tile('light', f.sheet), -20);
  assert.equal(f.device('light').level, 60);
  f.sheet.querySelector('[data-alloff]').onclick();
  assert.equal(f.device('light').on, false);
  assert.equal(f.sheet.closed, true);
  f.toasts.at(-1).undo();
  assert.equal(f.device('light').on, true);
  assert.equal(f.device('off').on, false);
});

test('locks require the hold callback and ignore the click immediately after unlocking', () => {
  const f = fixture(), tile = f.tile('lock');
  assert.equal(tile.hold.ms, 1000);
  assert.equal(tile.hold.enabled(), true);
  tile.fire('click');
  tile.hold.cancel();
  assert.equal(f.device('lock').locked, true);
  tile.hold.done();
  assert.equal(f.device('lock').locked, false);
  f.tile('lock').fire('click');
  assert.equal(f.device('lock').locked, false);
  f.advance(801);
  assert.equal(f.tile('lock').hold.enabled(), false);
  f.tile('lock').fire('click');
  assert.equal(f.device('lock').locked, true);
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
