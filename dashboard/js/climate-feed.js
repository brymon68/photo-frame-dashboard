// Only these fields cross the native bridge; no credentials or unrelated HA states.
export function parseClimate(data) {
  if (!Array.isArray(data)) throw new Error('Invalid climate data');
  const ids = new Set();
  return data.map(device => {
    if (!device || typeof device.id !== 'string' || !/^climate\.[a-z0-9_]+$/.test(device.id)
        || ids.has(device.id) || typeof device.name !== 'string'
        || !(device.temperature === null || typeof device.temperature === 'number' && Number.isFinite(device.temperature))) {
      throw new Error('Invalid climate device');
    }
    const parsed = { id: device.id, name: device.name.trim() || device.id.slice(8), temperature: device.temperature };
    // Older native caches lack these fields; keep their names without inventing details.
    for (const key of ['mode', 'activity', 'target', 'targetLow', 'targetHigh', 'min', 'max', 'step']) {
      const value = device[key] ?? null;
      if (value !== null && (key === 'mode' || key === 'activity'
        ? typeof value !== 'string' : typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('Invalid climate detail');
      }
      parsed[key] = value;
    }
    parsed.modes = device.modes ?? [];
    parsed.features = device.features ?? 0;
    if (!Array.isArray(parsed.modes) || parsed.modes.some(mode => !modes.has(mode))
        || !Number.isInteger(parsed.features) || parsed.features < 0) throw new Error('Invalid climate capabilities');
    ids.add(device.id);
    return parsed;
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function climateTemperature(device, stale) {
  return !device || stale ? '—' : formatTemperature(device.temperature);
}

function formatTemperature(value) {
  return typeof value !== 'number' || !Number.isFinite(value) ? '—' : String(Math.round(value * 10) / 10) + '°';
}

const modes = new Map([['heat', 'Heat'], ['cool', 'Cool'], ['heat_cool', 'Heat / Cool'],
  ['auto', 'Auto'], ['off', 'Off'], ['dry', 'Dry'], ['fan_only', 'Fan only']]);
export const climateModeLabel = mode => modes.get(mode) || 'Unknown';

export function climateTargets(device) {
  if (!device || !Number.isFinite(device.min) || !Number.isFinite(device.max) || device.min >= device.max
      || ['off', 'unknown', 'unavailable', 'fan_only', 'dry'].includes(device.mode)) return [];
  if ((device.features & 2) && (device.mode === 'heat_cool' || device.mode === 'auto' && device.target == null)) {
    return ['targetLow', 'targetHigh'];
  }
  return device.features & 1 && device.mode !== 'heat_cool' ? ['target'] : [];
}
const activities = new Map([['heating', 'Heating'], ['cooling', 'Cooling'], ['idle', 'Idle'],
  ['off', 'Off'], ['preheating', 'Preheating'], ['drying', 'Drying'], ['fan', 'Fan'], ['defrosting', 'Defrosting']]);

export function climateDetails(device, stale) {
  if (!device || stale || device.mode === 'unavailable' || device.mode === 'unknown') {
    return { status: 'Unavailable', target: '—', tone: '' };
  }
  const mode = modes.get(device.mode), activity = activities.get(device.activity);
  const status = (mode || 'Mode —') + (activity && device.mode !== 'off' ? ' · ' + activity : '');
  const range = Number.isFinite(device.targetLow) && Number.isFinite(device.targetHigh);
  const useRange = range && (device.mode === 'heat_cool' || device.mode === 'auto' || device.target == null);
  const target = useRange ? device.targetLow <= device.targetHigh
    ? formatTemperature(device.targetLow) + '–' + formatTemperature(device.targetHigh) : '—'
    : formatTemperature(device.target);
  const tone = device.mode === 'heat' && device.activity === 'heating' ? 'heating'
    : device.mode === 'cool' && device.activity === 'cooling' ? 'cooling' : '';
  return { status, target, tone };
}
