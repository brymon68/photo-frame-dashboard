// Camera discovery contains public display fields only. Stream URLs and credentials
// stay in the Android bridge and are never accepted from this feed.
export function parseCameras(data) {
  if (!Array.isArray(data)) throw new Error('Invalid camera data');
  const ids = new Set();
  return data.map(camera => {
    if (!camera || typeof camera.id !== 'string' || !/^camera\.[a-z0-9_]+$/.test(camera.id)
        || ids.has(camera.id) || typeof camera.name !== 'string' || typeof camera.available !== 'boolean') {
      throw new Error('Invalid camera');
    }
    ids.add(camera.id);
    return { id: camera.id, name: camera.name.trim() || camera.id.slice(7), available: camera.available };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function cameraAvailable(camera, stale = false) {
  return !!camera && camera.available === true && !stale;
}

// Resolve the shortcut from discovered display names, never a private entity ID.
// Ambiguous names must not silently open a different camera.
export function doorbellCamera(devices) {
  const matches = devices.filter(camera => /^doorbell(?: camera)?$/.test(camera.name.trim().replace(/\s+/g, ' ').toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}
