// Open-Meteo forecast for Albuquerque, NM. Epoch times avoid DST/midnight ambiguity.
export const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=35.0844&longitude=-106.6504' +
  '&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m' +
  '&hourly=temperature_2m,precipitation_probability,weather_code,is_day' +
  '&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&wind_speed_unit=mph' +
  '&timezone=America%2FDenver&timeformat=unixtime&forecast_days=3';

const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', hour12: true });
export function weatherDay(time) { return dateFormat.format(new Date(time)); }
export function weatherHour(time) { return hourFormat.format(new Date(time)).replace(' AM', 'a').replace(' PM', 'p'); }

export function condition(code, day) {
  if (code === 0) return { icon: day ? 'sun' : 'moon', label: day ? 'Sunny' : 'Clear' };
  if (code === 1 || code === 2) return { icon: 'partly', label: 'Partly cloudy' };
  if (code === 3) return { icon: 'cloud', label: 'Overcast' };
  if (code === 45 || code === 48) return { icon: 'fog', label: 'Fog' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { icon: 'snow', label: 'Snow' };
  if ([95, 96, 99].includes(code)) return { icon: 'storm', label: 'Thunderstorms' };
  if ([56, 57, 66, 67].includes(code)) return { icon: 'rain', label: 'Freezing rain' };
  if ([51, 53, 55].includes(code)) return { icon: 'rain', label: 'Drizzle' };
  if ([61, 63, 65, 80, 81, 82].includes(code)) return { icon: 'rain', label: 'Rain' };
  return { icon: 'cloud', label: 'Cloudy' };
}

function number(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Incomplete weather data');
  return value;
}
export function parseWeather(data) {
  if (data?.current_units?.temperature_2m !== '°F' || data?.timezone !== 'America/Denver') throw new Error('Unexpected weather units or timezone');
  const c = data.current, h = data.hourly, d = data.daily;
  const now = {
    time: number(c.time) * 1000, temp: Math.round(number(c.temperature_2m)),
    feels: Math.round(number(c.apparent_temperature)), humidity: Math.round(number(c.relative_humidity_2m)),
    wind: Math.round(number(c.wind_speed_10m)), ...condition(number(c.weather_code), number(c.is_day))
  };
  if (!h?.time?.length || !d?.time?.length) throw new Error('Missing forecast');
  const hours = h.time.map((time, i) => ({
    time: number(time) * 1000, t: Math.round(number(h.temperature_2m[i])),
    p: number(h.precipitation_probability[i]), ...condition(number(h.weather_code[i]), number(h.is_day[i]))
  }));
  if (hours.some((hour, i) => i && hour.time <= hours[i - 1].time)) throw new Error('Unordered forecast');
  const days = d.time.map((time, i) => ({ time: number(time) * 1000,
    hi: Math.round(number(d.temperature_2m_max[i])), lo: Math.round(number(d.temperature_2m_min[i])) }));
  return { now, hours, days };
}

export function hourlyWeather(forecast, now, count) {
  if (!forecast) return [];
  const start = Math.floor(+now / 3600000) * 3600000;
  return forecast.hours.filter(h => h.time >= start).slice(0, count).map((h, i) => ({
    ...h, c: h.icon, label: i === 0 && h.time === start ? 'Now' : weatherHour(h.time)
  }));
}
export function currentWeather(forecast, now) {
  if (!forecast) return { temp: '—', cond: 'cloud', label: 'Loading weather', hi: '—', lo: '—', summary: '', advice: '' };
  const current = forecast.now, day = forecast.days.find(d => weatherDay(d.time) === weatherDay(+now));
  const hours = hourlyWeather(forecast, now, 12), nextRain = hours.find(h => h.p >= 50);
  return { temp: current.temp, cond: current.icon, label: current.label,
    hi: day ? day.hi : '—', lo: day ? day.lo : '—',
    summary: 'Feels like ' + current.feels + '°F',
    advice: 'Wind ' + current.wind + ' mph · Humidity ' + current.humidity + '%' +
      (nextRain ? ' · ' + Math.round(nextRain.p) + '% precipitation ' + (nextRain.label === 'Now' ? 'now' : 'at ' + nextRain.label) : '') };
}
