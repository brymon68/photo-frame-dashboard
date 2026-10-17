// Match the requested rooms by their HA display names, never discovery order.
// Keep absent or ambiguous rooms visible without substituting another device.
const rooms = [
  { name: "Amelie's Bedroom", aliases: ['amelie bedroom', 'amelies bedroom'] },
  { name: "Joseph's Bedroom", aliases: ['joseph bedroom', 'josephs bedroom'] },
  { name: 'Hallway', aliases: ['hallway'] }
];

function roomName(name) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/\s+/g, ' ').trim();
}

export function climateFavorites(devices) {
  return rooms.map(room => {
    const matches = devices.filter(device => room.aliases.includes(roomName(device.name)));
    return { name: room.name, device: matches.length === 1 ? matches[0] : undefined };
  });
}
