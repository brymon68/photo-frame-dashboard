import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

function fixture() {
  const elements = new Map(), standby = [];
  let now = +new Date('2026-10-12T15:18:00-06:00');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  let interval;
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      dataset: {}, style: {}, addEventListener() {},
      classList: { toggle() {}, contains() { return false; } }
    });
    return elements.get(selector);
  }
  const location = { hash: '' }, window = {
    DATA: {}, HomeHQ: { setStandby: value => standby.push(value) },
    innerWidth: 1920, innerHeight: 1080, addEventListener() {}
  };
  vm.runInNewContext(script, {
    window, location, Date: Clock,
    history: { replaceState: (_, __, hash) => { location.hash = hash; } },
    document: {
      querySelector: element, querySelectorAll: () => [], addEventListener() {},
      documentElement: { hasAttribute: () => true }
    },
    setTimeout() {}, clearTimeout() {}, setInterval(fn) { interval = fn; }
  });
  const App = window.App;
  function view(name, minutely = false) {
    const calls = [];
    App.register(name, {
      minutely,
      show: (el, opts) => calls.push({ action: 'show', el, opts }),
      resume: () => calls.push({ action: 'resume' }),
      hide: () => calls.push({ action: 'hide' })
    });
    return calls;
  }
  return {
    App, view, element, standby, advance: ms => { now += ms; },
    start() { view('home'); App.on('mode', App.resetIdle); App.start(); },
    tick(seconds = 1) { for (let i = 0; i < seconds; i++) { now += 1000; interval(); } },
    clock(value) { now = +new Date(value); }
  };
}

test('explicit rerenders refresh cached metadata so the next visit can resume', () => {
  const f = fixture(), calls = f.view('home', true);
  f.App.go('home');
  f.advance(60000);
  f.App.rerender();
  f.App.go('home');
  assert.deepEqual(calls.map(c => c.action), ['show', 'show', 'resume']);
  assert.equal(calls[1].opts.rerender, true);
  assert.equal(calls[1].el, f.element('#view-home'));
});

test('data changes rebuild hidden views once while clean views retain their DOM', () => {
  const f = fixture(), home = f.view('home'), control = f.view('control');
  f.App.go('home');
  f.App.go('control');
  f.App.emit('data');
  f.App.go('home');
  f.App.go('control');
  f.App.go('home');
  assert.deepEqual(home.map(c => c.action), ['show', 'hide', 'show', 'hide', 'resume']);
  assert.deepEqual(control.map(c => c.action), ['show', 'hide', 'resume', 'hide']);
});

test('standby bridge dims only ambient/night and night starts at 9 PM', () => {
  const f = fixture();
  for (const [hour, minute, night] of [[20,59,false],[21,0,true],[23,59,true],[0,0,true],[5,59,true],[6,0,false]]) {
    f.App.setTime(hour, minute);
    assert.equal(f.App.isNight(), night);
  }
  for (const mode of ['ambient', 'day', 'night', 'nightdash']) {
    f.App.setMode(mode);
    assert.equal(f.element('#stage').dataset.mode, mode);
  }
  assert.deepEqual(f.standby, [true, false, true, false]);
});

test('existing standby follows both schedule boundaries without a touch', () => {
  const f = fixture(); f.start();
  f.clock('2026-10-12T20:59:58-06:00'); f.App.setMode('ambient');
  f.tick(); assert.equal(f.App.mode, 'ambient');
  f.tick(); assert.equal(f.App.mode, 'night');
  f.clock('2026-10-13T05:59:58-06:00');
  f.tick(); assert.equal(f.App.mode, 'night');
  f.tick(); assert.equal(f.App.mode, 'ambient');
  assert.ok(f.standby.every(Boolean), 'Schedule changes keep standby brightness');
});

test('night dashboard becomes day at dawn and uses the normal idle timeout', () => {
  const f = fixture(); f.start();
  f.clock('2026-10-13T05:59:59-06:00'); f.App.setMode('nightdash');
  f.tick(); assert.equal(f.App.mode, 'day');
  assert.equal(f.standby.at(-1), false);
  f.tick(119); assert.equal(f.App.mode, 'day');
  f.tick(); assert.equal(f.App.mode, 'ambient');
});

test('night wake still returns after 20 seconds, while active day stays awake', () => {
  const f = fixture(); f.start();
  f.clock('2026-10-12T22:00:00-06:00'); f.App.setMode('nightdash');
  f.tick(19); assert.equal(f.App.mode, 'nightdash');
  f.tick(); assert.equal(f.App.mode, 'night');
  f.clock('2026-10-12T20:59:59-06:00'); f.App.setMode('day');
  f.tick(); assert.equal(f.App.mode, 'day');
  f.tick(118); assert.equal(f.App.mode, 'day');
  f.tick(); assert.equal(f.App.mode, 'night');
});

test('standby recovers when the device clock jumps across the schedule', () => {
  const f = fixture(); f.start();
  f.clock('2026-10-12T23:00:00-06:00'); f.App.setMode('night');
  f.clock('2026-10-13T09:37:00-06:00'); f.tick();
  assert.equal(f.App.mode, 'ambient');
  const transitions = f.standby.length;
  f.tick(60); assert.equal(f.standby.length, transitions);
  f.clock('2026-10-12T23:00:00-06:00'); f.tick();
  assert.equal(f.App.mode, 'night');
});

test('preserves installed standby transitions at nightfall and dawn without interaction', () => {
  const f = fixture(); f.view('home'); f.App.start();
  f.App.setTime(20, 59); f.App.setMode('ambient'); f.tick();
  assert.equal(f.App.mode, 'ambient');
  f.App.setTime(21, 0); f.tick();
  assert.equal(f.App.mode, 'night');
  f.App.setTime(5, 59); f.tick();
  assert.equal(f.App.mode, 'night');
  f.App.setTime(6, 0); f.tick();
  assert.equal(f.App.mode, 'ambient');
  f.App.setMode('nightdash'); f.tick();
  assert.equal(f.App.mode, 'day');
  assert.equal(f.standby.at(-1), false);
});
