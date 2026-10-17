import test from 'node:test';
import assert from 'node:assert/strict';
import { climateFavorites } from '../js/climate-favorites.js';

test('favorite rooms retain their order and resolve their own climate devices', () => {
  const devices = [
    { id: 'climate.other', name: 'Bedroom' },
    { id: 'climate.hall', name: 'Hallway' },
    { id: 'climate.joseph', name: 'Joseph Bedroom' },
    { id: 'climate.amelie', name: 'Amelie Bedroom' }
  ];
  assert.deepEqual(climateFavorites(devices).map(room => [room.name, room.device.id]), [
    ["Amelie's Bedroom", 'climate.amelie'], ["Joseph's Bedroom", 'climate.joseph'], ['Hallway', 'climate.hall']
  ]);
  devices[3].name = ' Amélie’s  Bedroom ';
  assert.equal(climateFavorites(devices)[0].device, devices[3]);
});

test('missing and ambiguous favorite names never point a control at another room', () => {
  assert.ok(climateFavorites([{ id: 'climate.other', name: 'Bedroom' }]).every(room => !room.device));
  const favorites = climateFavorites([
    { id: 'climate.a', name: 'Amelie Bedroom' }, { id: 'climate.b', name: "Amelie's Bedroom" },
    { id: 'climate.c', name: 'Joseph Bedroom Guest' }, { id: 'climate.d', name: 'Upstairs Hallway' }
  ]);
  assert.ok(favorites.every(room => !room.device));
});
