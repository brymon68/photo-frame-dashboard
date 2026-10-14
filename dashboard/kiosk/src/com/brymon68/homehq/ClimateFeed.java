package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Read-only Home Assistant transport. Credentials never enter WebView or the APK. */
final class ClimateFeed extends CachedFeed {
  private final File config;
  private String token;

  ClimateFeed(Context context) {
    super(context, "climate-devices.json", "Climate", 8 * 1024 * 1024);
    config = new File(context.getFilesDir(), "home-assistant.json");
  }

  synchronized WebResourceResponse request(Uri uri) {
    if (!"https".equals(uri.getScheme()) || !MainActivity.BUNDLED_HOST.equals(uri.getHost())
        || !"/dashboard/climate/devices.json".equals(uri.getPath())) return null;
    try (InputStream input = new FileInputStream(config)) {
      JSONObject settings = new JSONObject(new String(read(input, 16384), StandardCharsets.UTF_8));
      String base = settings.getString("url");
      Uri server = Uri.parse(base);
      token = settings.getString("token");
      if (!("http".equals(server.getScheme()) || "https".equals(server.getScheme()))
          || server.getHost() == null || server.getUserInfo() != null || server.getQuery() != null
          || server.getFragment() != null || !(server.getPath() == null || server.getPath().isEmpty())
          || !token.matches("[A-Za-z0-9._~-]+")) throw new IOException("Invalid configuration");
      return fetch(base + "/api/states", 0);
    } catch (IOException | JSONException | IllegalArgumentException invalid) {
      return response("application/json", 404, new byte[0], false, 0);
    } finally { token = null; }
  }

  @Override String mimeType(int status) { return "application/json"; }
  @Override void validate(byte[] data) throws IOException {
    try { new JSONArray(new String(data, StandardCharsets.UTF_8)); }
    catch (JSONException invalid) { throw new IOException("Invalid climate data"); }
  }

  private Object temperature(JSONObject attributes, String key) throws JSONException {
    if (attributes.isNull(key)) return JSONObject.NULL;
    double value = attributes.getDouble(key);
    return Double.isNaN(value) || Double.isInfinite(value) ? JSONObject.NULL : value;
  }

  @Override byte[] download(String address) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
    connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
    connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
    connection.setRequestProperty("Authorization", "Bearer " + token);
    connection.setRequestProperty("Accept", "application/json");
    connection.setRequestProperty("User-Agent", "HomeHQ-Climate/1.0");
    try {
      if (connection.getResponseCode() != 200) throw new IOException("Climate unavailable");
      try (InputStream input = connection.getInputStream()) {
        JSONArray states = new JSONArray(new String(read(input, 8 * 1024 * 1024), StandardCharsets.UTF_8));
        JSONArray devices = new JSONArray();
        for (int i = 0; i < states.length(); i++) {
          JSONObject state = states.getJSONObject(i);
          String id = state.getString("entity_id");
          if (!id.startsWith("climate.")) continue;
          JSONObject attrs = state.getJSONObject("attributes");
          String name = attrs.isNull("friendly_name") ? id.substring(8) : attrs.getString("friendly_name");
          String mode = state.getString("state");
          boolean available = !"unavailable".equals(mode) && !"unknown".equals(mode);
          devices.put(new JSONObject().put("id", id).put("name", name).put("mode", mode)
              .put("activity", available && !attrs.isNull("hvac_action") ? attrs.getString("hvac_action") : JSONObject.NULL)
              .put("temperature", available ? temperature(attrs, "current_temperature") : JSONObject.NULL)
              .put("target", available ? temperature(attrs, "temperature") : JSONObject.NULL)
              .put("targetLow", available ? temperature(attrs, "target_temp_low") : JSONObject.NULL)
              .put("targetHigh", available ? temperature(attrs, "target_temp_high") : JSONObject.NULL)
              .put("min", temperature(attrs, "min_temp")).put("max", temperature(attrs, "max_temp"))
              .put("step", temperature(attrs, "target_temp_step"))
              .put("features", attrs.isNull("supported_features") ? 0 : attrs.getInt("supported_features"))
              .put("modes", attrs.isNull("hvac_modes") ? new JSONArray() : attrs.getJSONArray("hvac_modes")));
        }
        return devices.toString().getBytes(StandardCharsets.UTF_8);
      } catch (JSONException invalid) { throw new IOException("Invalid climate data"); }
    } finally { connection.disconnect(); }
  }
}
