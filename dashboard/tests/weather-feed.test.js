import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeather, currentWeather, hourlyWeather, condition } from '../js/weather-feed.js';

export function fixtureData() {
  const first = +new Date('2026-10-12T23:00:00-06:00') / 1000;
  return { timezone: 'America/Denver', current_units: { temperature_2m: '°F' },
    current: { time: first, temperature_2m: 63.4, apparent_temperature: 61.2, relative_humidity_2m: 24, wind_speed_10m: 5.6, weather_code: 0, is_day: 0 },
    hourly: { time: Array.from({ length: 8 }, (_, i) => first + i * 3600), temperature_2m: [63, 60, 58, 56, 54, 52, 50, 49], precipitation_probability: [0, 0, 20, 70, 0, 0, 0, 0], weather_code: [0, 0, 3, 61, 3, 2, 1, 0], is_day: [0, 0, 0, 0, 0, 0, 0, 1] },
    daily: { time: [+new Date('2026-10-12T00:00:00-06:00') / 1000, +new Date('2026-10-13T00:00:00-06:00') / 1000], temperature_2m_max: [78.1, 74.3], temperature_2m_min: [50.1, 48.2] }
  };
}

test('weather stays in Fahrenheit and upcoming hours cross midnight into the next date', () => {
  const forecast = parseWeather(fixtureData()), now = new Date('2026-10-12T23:30:00-06:00');
  const hours = hourlyWeather(forecast, now, 7);
  assert.equal(hours.length, 7);
  assert.deepEqual(hours.slice(0, 3).map(h => [h.label, h.t]), [['Now', 63], ['12a', 60], ['1a', 58]]);
  assert.equal(currentWeather(forecast, now).temp, 63);
  assert.equal(currentWeather(forecast, now).hi, 78);
  assert.equal(currentWeather(forecast, new Date('2026-10-13T00:01:00-06:00')).hi, 74);
  assert.match(currentWeather(forecast, now).advice, /70% precipitation at 2a/);
  assert.deepEqual(hourlyWeather(forecast, new Date('2026-10-15'), 7), []);
});

test('incomplete or wrong-unit responses are rejected, including null temperatures', () => {
  for (const change of [d => { d.current.temperature_2m = null; }, d => { d.hourly.temperature_2m.pop(); }, d => { d.daily.temperature_2m_max = []; }, d => { d.current_units.temperature_2m = '°C'; }, d => { d.hourly.time[1] = d.hourly.time[0]; }]) {
    const data = fixtureData(); change(data); assert.throws(() => parseWeather(data));
  }
  assert.equal(currentWeather(null, new Date()).temp, '—');
});

test('conditions distinguish night, snow, fog, freezing rain and thunderstorms', () => {
  assert.equal(condition(0, 0).icon, 'moon');
  assert.equal(condition(0, 1).icon, 'sun');
  assert.equal(condition(75, 1).icon, 'snow');
  assert.equal(condition(45, 1).label, 'Fog');
  assert.equal(condition(67, 1).label, 'Freezing rain');
  assert.equal(condition(99, 1).label, 'Thunderstorms');
});
