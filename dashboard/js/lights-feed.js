// Room/light state fields from the native Home Assistant feed.
export function parseLights(data) {
  if (!data || !Array.isArray(data.rooms) || !Array.isArray(data.lights)) throw new Error('Invalid lights data');
  const roomIds = new Set(), lightIds = new Set();
  const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const rooms = data.rooms.map(room => {
    if (!room || typeof room.id !== 'string' || !room.id || roomIds.has(room.id)
        || typeof room.name !== 'string') throw new Error('Invalid room');
    roomIds.add(room.id);
    return { id: room.id, name: room.name.trim() || room.id };
  }).sort(byName);
  const lights = data.lights.map(light => {
    if (!light || typeof light.id !== 'string' || !/^(light|switch)\.[a-z0-9_]+$/.test(light.id)
        || lightIds.has(light.id) || typeof light.name !== 'string'
        || !(light.room === null || typeof light.room === 'string')
        || !['on', 'off', 'unknown', 'unavailable'].includes(light.state)) throw new Error('Invalid light');
    lightIds.add(light.id);
    if (light.level != null && (!Number.isInteger(light.level) || light.level < 0 || light.level > 100)) throw new Error('Invalid light level');
    return { id: light.id, name: light.name.trim() || light.id.split('.')[1],
      room: roomIds.has(light.room) ? light.room : null,
      dimmable: light.id.startsWith('light.') && light.dimmable === true,
      level: light.state === 'off' ? 0 : light.level ?? null,
      state: light.state === 'on' || light.state === 'off' ? light.state : 'unavailable' };
  }).sort(byName);
  if (lights.some(light => light.room === null)) rooms.push({ id: null, name: 'Unassigned' });
  return { rooms, lights };
}

export function lightStatus(light, stale) {
  return !light || stale || light.state === 'unavailable' ? 'Unavailable' : light.state === 'on' ? 'On' : 'Off';
}

export function lightCounts(lights, stale) {
  const on = lights.filter(light => lightStatus(light, stale) === 'On');
  const unavailable = lights.filter(light => lightStatus(light, stale) === 'Unavailable').length;
  return { on: on.length, rooms: new Set(on.map(light => light.room)).size, unavailable,
    label: !lights.length ? 'No lights' : (on.length ? on.length + ' on' : unavailable ? '' : 'All off')
      + (unavailable ? (on.length ? ' · ' : '') + unavailable + ' unavailable' : '') };
}
