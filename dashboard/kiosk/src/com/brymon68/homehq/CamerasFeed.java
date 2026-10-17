package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Camera names and availability only; access tokens and image URLs stay native. */
final class CamerasFeed extends CachedFeed {
  private final File config;
  private Settings settings;

  CamerasFeed(Context context) {
    super(context, "cameras-devices.json", "Cameras", 8 * 1024 * 1024);
    config = new File(context.getFilesDir(), "home-assistant.json");
  }

  static boolean bundled(Uri uri) {
    return "https".equals(uri.getScheme()) && MainActivity.BUNDLED_HOST.equals(uri.getHost())
        && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null
        && uri.getFragment() == null;
  }

  static boolean cameraId(String id) { return id != null && id.matches("camera\\.[a-z0-9_]+") && id.length() <= 255; }

  synchronized WebResourceResponse request(Uri uri) {
    if (!bundled(uri) || !"/dashboard/cameras/devices.json".equals(uri.getPath())) return null;
    try {
      settings = load(config);
      return fetch(settings.base + "/api/states", 0);
    } catch (IOException invalid) {
      return response("application/json", 404, new byte[0], false, 0);
    } finally { settings = null; }
  }

  static final class Settings {
    final String base, token;
    Settings(String base, String token) { this.base = base; this.token = token; }
  }

  static Settings load(File config) throws IOException {
    try (InputStream input = new FileInputStream(config)) {
      JSONObject values = new JSONObject(new String(bounded(input, 16384), StandardCharsets.UTF_8));
      String base = values.getString("url"), token = values.getString("token");
      Uri server = Uri.parse(base);
      if (!("http".equals(server.getScheme()) || "https".equals(server.getScheme()))
          || server.getHost() == null || server.getUserInfo() != null || server.getQuery() != null
          || server.getFragment() != null || !(server.getPath() == null || server.getPath().isEmpty())
          || server.getPort() < -1 || server.getPort() == 0 || server.getPort() > 65535
          || !token.matches("[A-Za-z0-9._~-]+")) throw new IOException("Invalid configuration");
      return new Settings(base, token);
    } catch (JSONException | IllegalArgumentException invalid) { throw new IOException("Invalid configuration"); }
  }

  static byte[] bounded(InputStream input, int limit) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192]; int count;
    while ((count = input.read(buffer)) != -1) {
      if (output.size() + count > limit) throw new IOException("Response too large");
      output.write(buffer, 0, count);
    }
    return output.toByteArray();
  }

  @Override String mimeType(int status) { return "application/json"; }
  @Override void validate(byte[] data) throws IOException {
    try { new JSONArray(new String(data, StandardCharsets.UTF_8)); }
    catch (JSONException invalid) { throw new IOException("Invalid camera data"); }
  }

  @Override byte[] download(String address) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
    connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
    connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
    connection.setRequestProperty("Authorization", "Bearer " + settings.token);
    connection.setRequestProperty("Accept", "application/json");
    connection.setRequestProperty("User-Agent", "HomeHQ-Cameras/1.0");
    try {
      if (connection.getResponseCode() != 200) throw new IOException("Cameras unavailable");
      try (InputStream input = connection.getInputStream()) {
        JSONArray states = new JSONArray(new String(read(input, 8 * 1024 * 1024), StandardCharsets.UTF_8));
        JSONArray devices = new JSONArray(); Set<String> seen = new HashSet<>();
        for (int i = 0; i < states.length(); i++) {
          JSONObject state = states.getJSONObject(i);
          String id = state.getString("entity_id");
          if (!id.startsWith("camera.")) continue;
          if (!cameraId(id) || !seen.add(id)) throw new IOException("Invalid camera data");
          JSONObject attributes = state.getJSONObject("attributes");
          String value = state.getString("state");
          devices.put(new JSONObject().put("id", id)
              .put("name", attributes.isNull("friendly_name") ? id.substring(7) : attributes.getString("friendly_name"))
              .put("available", !"unavailable".equals(value) && !"unknown".equals(value)));
        }
        return devices.toString().getBytes(StandardCharsets.UTF_8);
      } catch (JSONException invalid) { throw new IOException("Invalid camera data"); }
    } finally { connection.disconnect(); }
  }
}
