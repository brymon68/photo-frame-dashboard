import { climateModeLabel, climateTargets } from './climate-feed.js';

const App = window.App;
const native = location.origin === 'https://appassets.androidplatform.net';
const controls = App.homeControls = { pending: Object.create(null) };
controls.canLight = light => native && light && App.lights.status(light) !== 'Unavailable';
controls.canClimate = device => native && device && App.climate.details(device).status !== 'Unavailable'
  && (device.modes.length > 0 || climateTargets(device).length > 0);

// No optimistic equipment state: tiles always show the state reported by HA.
// One in-flight command per entity prevents double taps and out-of-order changes.
controls.send = async function (feed, entity, command, matches) {
  if (!native || controls.pending[entity]) return false;
  controls.pending[entity] = true;
  App.emit(feed);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let sent = false, changed = false;
  try {
    const response = await fetch('./home-assistant/command', {
      method: 'POST', cache: 'no-store', signal: controller.signal,
      headers: { 'X-HomeHQ-Command': JSON.stringify({ entity, ...command }) }
    });
    const result = await response.json();
    sent = response.ok && result.ok === true;
    changed = result.code === 'changed';
  } catch (_) { /* A timed-out write may have succeeded; never automatically repeat it. */ }
  finally { clearTimeout(timeout); }
  try {
    // Wait out any pre-command refresh, then fetch a new authoritative state.
    await App[feed].refresh(true);
    const collection = feed === 'lights' ? 'lights' : 'devices';
    let device = App[feed][collection].find(item => item.id === entity);
    const confirmed = () => device && (feed === 'lights' ? controls.canLight(device) : controls.canClimate(device)) && matches(device);
    if (sent && !confirmed()) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      await App[feed].refresh(true);
      device = App[feed][collection].find(item => item.id === entity);
    }
    if (!sent) App.toast(changed ? 'Device settings changed. Open the control again and retry.'
      : 'Couldn’t confirm the change. Check the current device state before retrying.', { tone: 'error', icon: 'bolt' });
    else if (!confirmed()) App.toast('Request sent · waiting for the device to report the change.', { icon: 'clock', ms: 5000 });
    return sent;
  } finally {
    delete controls.pending[entity];
    App.emit(feed);
  }
};

controls.toggleLight = function (id) {
  const light = App.lights.lights.find(item => item.id === id);
  if (!controls.canLight(light) || controls.pending[id]) return;
  const on = light.state !== 'on';
  return controls.send('lights', id, { action: on ? 'turn_on' : 'turn_off' }, current => current.state === (on ? 'on' : 'off'));
};

controls.openClimate = function (id) {
  const device = App.climate.devices.find(item => item.id === id);
  if (!controls.canClimate(device) || controls.pending[id]) return;
  let mode = device.mode, active = true, saving = false;
  const targets = climateTargets(device), draft = {};
  targets.forEach(key => { draft[key] = device[key]; });
  const step = device.step > 0 ? device.step : 1;
  const labels = { target: 'Target temperature', targetLow: 'Heat below', targetHigh: 'Cool above' };
  const format = value => Number.isFinite(value) ? value + '°' : '—';
  const changed = () => mode !== device.mode || targets.some(key => draft[key] !== device[key]);
  const valid = () => mode !== device.mode || targets.length > 0 && targets.every(key => Number.isFinite(draft[key])
    && draft[key] >= device.min && draft[key] <= device.max)
    && (!targets.includes('targetLow') || draft.targetLow <= draft.targetHigh);
  const html = '<div class="sheet-pad climate-control"><div class="label">Climate</div><h2 class="serif sheet-h">' + App.esc(device.name) + '</h2>' +
    '<p class="sheet-p">Currently <b>' + App.climate.temperature(device) + '</b> · ' + App.esc(App.climate.details(device).status) + '</p>' +
    '<div class="climate-form"></div></div>';
  App.sheet(html, {
    onClose: () => { active = false; },
    onMount: (sheet, close) => {
      const form = sheet.querySelector('.climate-form');
      function render() {
        form.innerHTML = (device.modes.length ? '<div class="label">Mode</div><div class="climate-modes">' + device.modes.map(value =>
          '<button type="button" data-mode="' + value + '" aria-pressed="' + (mode === value) + '"' + (saving ? ' disabled' : '') + '>' + climateModeLabel(value) + '</button>').join('') + '</div>' : '') +
          (mode !== device.mode ? '<p class="sheet-p">Apply this mode to load its temperature settings.</p>' : targets.length ? targets.map(key =>
            '<div class="climate-adjust"><span class="label">' + labels[key] + '</span><div class="climate-stepper">' +
            '<button type="button" data-step="-1" data-target="' + key + '" aria-label="Lower ' + labels[key].toLowerCase() + '"' + (saving || draft[key] <= device.min && draft[key] != null ? ' disabled' : '') + '>−</button>' +
            '<output class="num" aria-live="polite">' + format(draft[key]) + '</output>' +
            '<button type="button" data-step="1" data-target="' + key + '" aria-label="Raise ' + labels[key].toLowerCase() + '"' + (saving || draft[key] >= device.max ? ' disabled' : '') + '>+</button></div></div>').join('') +
            '<p class="climate-limit">' + device.min + '°–' + device.max + '° · ' + step + '° steps</p>' : '<p class="sheet-p">' + (mode === 'off' ? 'Choose a mode to turn this device on.' : 'This mode has no temperature adjustment.') + '</p>') +
          (mode === device.mode && targets.includes('targetLow') && draft.targetLow > draft.targetHigh ? '<p role="alert">The heating target must not exceed the cooling target.</p>' : '') +
          '<button class="climate-apply" data-apply' + (saving || !changed() || !valid() ? ' disabled' : '') + '>' + (saving ? 'Applying…' : 'Apply ' + (mode !== device.mode ? 'mode' : 'temperature')) + '</button>';
      }
      form.addEventListener('click', async event => {
        const button = event.target.closest('button');
        if (!button || button.disabled || saving) return;
        if (button.dataset.mode) { mode = button.dataset.mode; render(); return; }
        if (button.dataset.target) {
          const key = button.dataset.target;
          const current = Number.isFinite(draft[key]) ? draft[key] : Number.isFinite(device.temperature) ? device.temperature : device.min;
          const next = Math.round((current - device.min) / step) + Number(button.dataset.step);
          draft[key] = Math.round(Math.max(device.min, Math.min(device.max, device.min + next * step)) * 1000) / 1000;
          render(); return;
        }
        if (!button.hasAttribute('data-apply') || !changed() || !valid()) return;
        const current = App.climate.devices.find(item => item.id === id);
        if (!controls.canClimate(current) || controls.pending[id]) { App.toast('Device unavailable. Try again when it reconnects.', { tone: 'error' }); return; }
        saving = true; render();
        const command = mode !== device.mode ? { action: 'set_hvac_mode', mode }
          : { action: 'set_temperature', mode, ...draft };
        const sent = await controls.send('climate', id, command, value => command.action === 'set_hvac_mode'
          ? value.mode === mode : value.mode === mode && targets.every(key => Math.abs(value[key] - draft[key]) < 0.01 && value[key] != null));
        if (!active) return;
        saving = false;
        if (sent) close(); else render();
      });
      render();
    }
  });
};
