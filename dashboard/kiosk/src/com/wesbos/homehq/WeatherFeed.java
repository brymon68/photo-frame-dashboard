package com.wesbos.homehq;

import android.content.Context;
import android.net.Uri;
import android.util.AtomicFile;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;
import org.json.JSONException;

/** Fixed, public Albuquerque weather endpoint. No location permission or API key. */
final class WeatherFeed {
  private static final int MAX_BYTES = 512 * 1024;
  // Only coalesce quick reloads; the dashboard schedules the 15-minute refresh.
  private static final long REUSE_MS = 60 * 1000;
  private static final String URL_STRING = "https://api.open-meteo.com/v1/forecast?latitude=35.0844&longitude=-106.6504"
      + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m"
      + "&hourly=temperature_2m,precipitation_probability,weather_code,is_day"
      + "&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&wind_speed_unit=mph"
      + "&timezone=America%2FDenver&timeformat=unixtime&forecast_days=3";
  private final AtomicFile cache;

  WeatherFeed(Context context) {
    cache = new AtomicFile(new File(context.getFilesDir(), "weather-forecast.json"));
  }

  WebResourceResponse request(Uri uri) {
    if (!"https".equals(uri.getScheme()) || !MainActivity.BUNDLED_HOST.equals(uri.getHost())
        || !"/dashboard/weather/forecast.json".equals(uri.getPath())) return null;
    return fetch();
  }

  private synchronized WebResourceResponse fetch() {
    long age = System.currentTimeMillis() - cache.getBaseFile().lastModified();
    if (age >= 0 && age < REUSE_MS) {
      try (InputStream input = cache.openRead()) {
        return response(200, read(input), false, cache.getBaseFile().lastModified());
      } catch (IOException ignored) { }
    }
    try {
      byte[] data = download();
      FileOutputStream output = null;
      try {
        output = cache.startWrite(); output.write(data); cache.finishWrite(output);
      } catch (IOException storageFailure) { cache.failWrite(output); }
      return response(200, data, false, System.currentTimeMillis());
    } catch (IOException unavailable) {
      try (InputStream input = cache.openRead()) {
        return response(200, read(input), true, cache.getBaseFile().lastModified());
      } catch (IOException noCache) { return response(503, new byte[0], true, 0); }
    }
  }

  private static byte[] download() throws IOException {
    HttpsURLConnection connection = (HttpsURLConnection) new URL(URL_STRING).openConnection();
    connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
    connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
    connection.setRequestProperty("Accept", "application/json");
    connection.setRequestProperty("User-Agent", "HomeHQ-Weather/1.0");
    try {
      if (connection.getResponseCode() != 200) throw new IOException("Weather unavailable");
      try (InputStream input = connection.getInputStream()) {
        byte[] data = read(input);
        // Keep the last good cache if the service sends an error or incomplete response.
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
        return data;
      }
    } finally { connection.disconnect(); }
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

  private static byte[] read(InputStream input) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192]; int size;
    while ((size = input.read(buffer)) != -1) {
      if (output.size() + size > MAX_BYTES) throw new IOException("Weather size limit reached");
      output.write(buffer, 0, size);
    }
    return output.toByteArray();
  }

  private static WebResourceResponse response(int status, byte[] data, boolean stale, long updated) {
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff");
    headers.put("X-Weather-Stale", Boolean.toString(stale)); headers.put("X-Weather-Updated", Long.toString(updated));
    return new WebResourceResponse("application/json", "UTF-8", status, status == 200 ? "OK" : "Service Unavailable", headers, new ByteArrayInputStream(data));
  }
}
