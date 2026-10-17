// Whole-tile brightness gesture: tap toggles, horizontal drag previews then commits.
// Vertical scrolls, pointer cancellation and lost capture never operate a light.
export function bindLightSlider(tile, light, controls, hooks) {
  let gesture = null;
  tile.addEventListener('pointerdown', event => {
    if (event.button !== 0 || gesture || !controls.canDim(light) || controls.pending[light.id]) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY,
      width: tile.getBoundingClientRect().width, level: light.level, axis: null };
    hooks.start();
    tile.setPointerCapture(event.pointerId);
  });
  tile.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 10) gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (gesture.axis !== 'x') return;
    gesture.level = Math.max(0, Math.min(100, Math.round(light.level + dx / gesture.width * 100)));
    tile.classList.add('is-drag');
    tile.classList.toggle('is-on', gesture.level > 0);
    tile.style.setProperty('--lvl', gesture.level + '%');
    tile.setAttribute('aria-valuenow', gesture.level);
    tile.setAttribute('aria-valuetext', gesture.level + '%');
    tile.querySelector('.tile-state').textContent = gesture.level ? gesture.level + '%' : 'Off';
  });
  function finish(event, cancelled) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const ended = gesture;
    gesture = null;
    tile.classList.remove('is-drag');
    hooks.end(cancelled || !!ended.axis);
    if (!cancelled && ended.axis === 'x') controls.setBrightness(light.id, ended.level);
  }
  tile.addEventListener('pointerup', event => finish(event, false));
  tile.addEventListener('pointercancel', event => finish(event, true));
  tile.addEventListener('lostpointercapture', event => finish(event, true));
  tile.addEventListener('keydown', event => {
    if (!controls.canDim(light) || controls.pending[light.id]) return;
    const levels = { ArrowLeft: light.level - 5, ArrowDown: light.level - 5,
      ArrowRight: light.level + 5, ArrowUp: light.level + 5, Home: 0, End: 100 };
    if (!(event.key in levels)) return;
    event.preventDefault();
    controls.setBrightness(light.id, Math.max(0, Math.min(100, levels[event.key])));
  });
}
