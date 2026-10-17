import test from 'node:test';
import assert from 'node:assert/strict';
import { bindLightSlider } from '../js/light-slider.js';

function fixture(scale = 1, level = 40) {
  const listeners = {}, calls = [], ends = [], styles = {}, attributes = {};
  const light = { id: 'light.bedroom', level }, state = {};
  const tile = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    getBoundingClientRect: () => ({ width: 200 * scale }), setPointerCapture() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: { setProperty: (key, value) => { styles[key] = value; } },
    setAttribute: (key, value) => { attributes[key] = value; }, querySelector: () => state
  };
  const controls = { canDim: () => true, pending: {}, setBrightness: (id, value) => calls.push(value) };
  let starts = 0;
  bindLightSlider(tile, light, controls, { start: () => starts++, end: suppressed => ends.push(suppressed) });
  return { calls, ends, styles, attributes, light, controls, starts: () => starts,
    fire: (name, props = {}) => listeners[name]({ pointerId: 1, button: 0, clientX: 100, clientY: 100, preventDefault() {}, ...props }) };
}

test('scaled horizontal drags preview without mutating state and commit once on release', () => {
  for (const scale of [1, 1.35]) {
    const f = fixture(scale);
    f.fire('pointerdown'); f.fire('pointermove', { clientX: 100 + 80 * scale });
    assert.equal(f.styles['--lvl'], '80%'); assert.equal(f.light.level, 40); assert.deepEqual(f.calls, []);
    f.fire('pointerup'); f.fire('lostpointercapture');
    assert.deepEqual(f.calls, [80]); assert.deepEqual(f.ends, [true]);
  }
});

test('tap, scroll, cancel, and lost capture never send brightness commands', () => {
  for (const action of ['tap', 'scroll', 'pointercancel', 'lostpointercapture']) {
    const f = fixture(); f.fire('pointerdown');
    if (action !== 'tap') f.fire('pointermove', action === 'scroll' ? { clientY: 170 } : { clientX: 180 });
    f.fire(action === 'tap' || action === 'scroll' ? 'pointerup' : action);
    f.fire('pointerup');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.ends, [action !== 'tap']);
  }
});

test('bounds, pointer ownership, unavailable and pending lights are respected', () => {
  for (const [x, expected] of [[-300, 0], [900, 100]]) {
    const f = fixture(); f.fire('pointerdown');
    f.fire('pointermove', { pointerId: 2, clientX: x }); f.fire('pointerup', { pointerId: 2 });
    assert.deepEqual(f.calls, []);
    f.fire('pointermove', { clientX: x }); f.fire('pointerup'); assert.deepEqual(f.calls, [expected]);
  }
  for (const pending of [false, true]) {
    const f = fixture(); if (pending) f.controls.pending[f.light.id] = true; else f.controls.canDim = () => false;
    f.fire('pointerdown'); f.fire('pointermove', { clientX: 180 }); f.fire('pointerup');
    assert.deepEqual(f.calls, []); assert.equal(f.starts(), 0);
  }
});

test('arrow keys adjust brightness and Home/End reach endpoints', () => {
  const f = fixture();
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) f.fire('keydown', { key });
  assert.deepEqual(f.calls, [35, 45, 0, 100]);
});
