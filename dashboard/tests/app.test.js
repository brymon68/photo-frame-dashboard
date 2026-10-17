import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

function fixture() {
  const elements = new Map(), standby = [], standbyCalls = [], listeners = {};
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
    DATA: {}, HomeHQ: { setStandby: (value, night) => { standby.push(value); standbyCalls.push({ standby: value, night }); } },
    innerWidth: 1920, innerHeight: 1080, addEventListener() {}
  };
  vm.runInNewContext(script, {
    window, location, Date: Clock,
    history: { replaceState: (_, __, hash) => { location.hash = hash; } },
    document: {
      querySelector: element, querySelectorAll: () => [], addEventListener(name, fn) { listeners[name] = fn; },
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
    App, view, element, standby, standbyCalls, listeners, advance: ms => { now += ms; },
    start() { view('home'); App.start(); },
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

test('replacing or closing a sheet releases its resources exactly once', () => {
  const f = fixture(), layer = f.element('#sheetLayer'), closed = [];
  let open = false;
  layer.classList = { add() { open = true; }, remove() { open = false; }, contains() { return open; } };
  layer.querySelector = () => ({ addEventListener() {} });
  layer.querySelectorAll = () => [];
  f.App.icon = () => '';
  f.App.sheet('first', { onClose() { closed.push('first'); } });
  f.App.sheet('second', { onClose() { closed.push('second'); } });
  assert.deepEqual(closed, ['first']);
  f.App.closeSheet(); f.App.closeSheet();
  assert.deepEqual(closed, ['first', 'second']);
  assert.equal(layer.innerHTML, '');
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

test('idle dims the current view without navigation, rerendering or closing a panel', () => {
  for (const name of ['home', 'calendar', 'shopping', 'control', 'agents']) {
    const f = fixture(); f.start(); const calls = f.view(name); f.App.go(name);
    let closed = false; f.App.closeSheet = () => { closed = true; };
    f.App.resetIdle(); f.tick(119);
    assert.equal(f.App.mode, 'day');
    f.tick(); assert.equal(f.App.mode, 'dim');
    assert.equal(f.App.current, name); assert.equal(closed, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(f.standby, [true]);
    f.tick(200); assert.deepEqual(f.standby, [true]);
  }
});

test('touch, keyboard and wheel restore brightness while retaining the view', () => {
  for (const input of ['pointerdown', 'keydown', 'wheel']) {
    const f = fixture(); f.start(); f.view('control'); f.App.go('control');
    f.App.resetIdle(); f.tick(120);
    f.listeners[input]({ pointerId: 1 });
    assert.equal(f.App.mode, 'day'); assert.equal(f.App.current, 'control');
    assert.deepEqual(f.standby, [true, false]);
  }
});

test('dimming waits until a held touch ends, including cancellation', () => {
  for (const end of ['pointerup', 'pointercancel']) {
    const f = fixture(); f.start();
    f.listeners.pointerdown({ pointerId: 7 }); f.tick(180);
    assert.equal(f.App.mode, 'day');
    f.listeners[end]({ pointerId: 7 });
    f.tick(119); assert.equal(f.App.mode, 'day');
    f.tick(); assert.equal(f.App.mode, 'dim');
  }
});

test('nightfall, dawn and clock corrections never replace the normal dashboard', () => {
  const f = fixture(); f.start(); f.view('control'); f.App.go('control');
  f.App.resetIdle(); f.tick(120);
  for (const time of ['2026-10-12T21:00:00-06:00', '2026-10-13T06:00:00-06:00', '2026-10-13T23:00:00-06:00']) {
    f.clock(time); f.tick(); assert.equal(f.App.mode, 'dim'); assert.equal(f.App.current, 'control');
  }
  f.App.resetIdle(); f.tick(119); assert.equal(f.App.mode, 'day');
  f.tick(); assert.equal(f.App.mode, 'dim');
});

test('entering idle chooses the daytime or overnight brightness and touch restores normal brightness', () => {
  for (const [time, night] of [
    ['2026-10-12T12:00:00-06:00', false],
    ['2026-10-12T22:00:00-06:00', true],
    ['2026-10-13T04:00:00-06:00', true],
    ['2026-10-13T05:00:00-06:00', false]
  ]) {
    const f = fixture(); f.start();
    const calls = f.view('control'); f.App.go('control');
    f.clock(time); f.App.resetIdle(); f.tick(120);
    assert.equal(f.App.mode, 'dim');
    assert.deepEqual(f.standbyCalls, [{ standby: true, night }]);
    f.listeners.pointerdown({ pointerId: 7 });
    assert.equal(f.App.mode, 'day');
    assert.deepEqual(f.standby, [true, false]);
    assert.deepEqual(f.standbyCalls, [{ standby: true, night }, { standby: false, night: false }]);
    assert.equal(f.App.current, 'control');
    assert.equal(calls.length, 1);
  }
});

test('idle brightness changes exactly at 21:00 and 05:00 without rebuilding views or closing panels', () => {
  for (const [time, beforeNight, afterNight] of [
    ['2026-10-12T20:57:59-06:00', false, true],
    ['2026-10-13T04:57:59-06:00', true, false]
  ]) {
    const f = fixture(); f.start();
    const calls = f.view('control'), modes = [];
    f.App.go('control'); f.App.on('mode', mode => modes.push(mode));
    let closed = 0; f.App.closeSheet = () => { closed++; };
    f.clock(time); f.App.resetIdle(); f.tick(120);
    assert.equal(f.App.now().getMinutes(), 59);
    assert.equal(f.App.now().getSeconds(), 59);
    assert.deepEqual(f.standbyCalls, [{ standby: true, night: beforeNight }]);
    f.tick();
    assert.deepEqual(f.standbyCalls, [
      { standby: true, night: beforeNight }, { standby: true, night: afterNight }
    ]);
    f.tick(60);
    assert.equal(f.standbyCalls.length, 2);
    assert.equal(f.App.mode, 'dim');
    assert.equal(f.App.current, 'control');
    assert.equal(calls.length, 1);
    assert.equal(closed, 0);
    assert.deepEqual(modes, ['dim']);
  }
});

test('active dashboard keeps normal brightness through both schedule boundaries', () => {
  for (const time of ['2026-10-12T20:59:59-06:00', '2026-10-13T04:59:59-06:00']) {
    const f = fixture(); f.start();
    const calls = f.view('control'), modes = [];
    f.App.go('control'); f.App.on('mode', mode => modes.push(mode));
    f.clock(time); f.App.resetIdle(); f.tick();
    assert.equal(f.App.mode, 'day');
    assert.equal(f.App.current, 'control');
    assert.equal(calls.length, 1);
    assert.deepEqual(modes, []);
    assert.deepEqual(f.standby, []);
  }
});

test('manual dimming also follows the clock schedule before the idle timeout', () => {
  const f = fixture(); f.start();
  const calls = f.view('control'), modes = [];
  f.App.go('control'); f.App.setTime(20, 59); f.App.resetIdle();
  f.App.on('mode', mode => modes.push(mode));
  f.App.setMode('dim');
  const renders = calls.length;
  assert.deepEqual(f.standbyCalls, [{ standby: true, night: false }]);
  f.tick(60);
  assert.deepEqual(f.standbyCalls, [{ standby: true, night: false }, { standby: true, night: true }]);
  assert.equal(f.App.mode, 'dim');
  assert.equal(f.App.current, 'control');
  assert.equal(calls.length, renders);
  assert.deepEqual(modes, ['dim']);
});
