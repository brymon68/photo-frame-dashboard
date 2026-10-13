package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.json.JSONException;

/** Fixed, public Albuquerque weather endpoint. No location permission or API key. */
final class WeatherFeed extends CachedFeed {
  // Only coalesce quick reloads; the dashboard schedules the 15-minute refresh.
  private static final long REUSE_MS = 60 * 1000;
  private static final String URL_STRING = "https://api.open-meteo.com/v1/forecast?latitude=35.0844&longitude=-106.6504"
      + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m"
      + "&hourly=temperature_2m,precipitation_probability,weather_code,is_day"
      + "&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&wind_speed_unit=mph"
      + "&timezone=America%2FDenver&timeformat=unixtime&forecast_days=3";
  WeatherFeed(Context context) {
    super(context, "weather-forecast.json", "Weather", 512 * 1024);
  }

  WebResourceResponse request(Uri uri) {
    if (!"https".equals(uri.getScheme()) || !MainActivity.BUNDLED_HOST.equals(uri.getHost())
        || !"/dashboard/weather/forecast.json".equals(uri.getPath())) return null;
    return fetch(URL_STRING, REUSE_MS);
  }

  @Override String mimeType(int status) { return "application/json"; }

  @Override void validate(byte[] data) throws IOException {
    try {
      JSONObject json = new JSONObject(new String(data, StandardCharsets.UTF_8));
      if (!"°F".equals(json.getJSONObject("current_units").getString("temperature_2m"))
          || !"America/Denver".equals(json.getString("timezone"))) throw new JSONException("Unexpected units");
      JSONObject current = json.getJSONObject("current");
      for (String key : new String[] {"time", "temperature_2m", "apparent_temperature", "relative_humidity_2m", "is_day", "weather_code", "wind_speed_10m"}) {
        if (current.isNull(key)) throw new JSONException("Missing current weather");
        current.getDouble(key);
      }
      validateArrays(json.getJSONObject("hourly"), new String[] {"time", "temperature_2m", "precipitation_probability", "weather_code", "is_day"});
      validateArrays(json.getJSONObject("daily"), new String[] {"time", "temperature_2m_max", "temperature_2m_min"});
    } catch (JSONException invalid) { throw new IOException("Incomplete weather", invalid); }
  }

  private static void validateArrays(JSONObject object, String[] keys) throws JSONException {
    int count = object.getJSONArray("time").length();
    if (count == 0) throw new JSONException("Empty forecast");
    for (String key : keys) {
      org.json.JSONArray values = object.getJSONArray(key);
      if (values.length() != count) throw new JSONException("Incomplete forecast");
      for (int i = 0; i < count; i++) {
        if (values.isNull(i)) throw new JSONException("Missing forecast value");
        values.getDouble(i);
      }
    }
  }
}
