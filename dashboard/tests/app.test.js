import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

function fixture() {
  const elements = new Map(), standby = [];
  let now = +new Date('2026-10-12T15:18:00-06:00');
  class Clock extends Date { static now() { return now; } }
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, { dataset: {}, classList: { toggle() {} } });
    return elements.get(selector);
  }
  const location = { hash: '' }, window = { DATA: {}, HomeHQ: { setStandby: value => standby.push(value) } };
  vm.runInNewContext(script, {
    window, location, Date: Clock,
    history: { replaceState: (_, __, hash) => { location.hash = hash; } },
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    setTimeout() {}, clearTimeout() {}
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
  return { App, view, element, standby, advance: ms => { now += ms; } };
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
