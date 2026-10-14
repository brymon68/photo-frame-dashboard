package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashSet;
import java.util.Set;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Read-only Home Assistant transport. Credentials never enter WebView or the APK. */
final class LightsFeed extends CachedFeed {
  private final File config;
  private String token;

  LightsFeed(Context context) {
    super(context, "lights-rooms.json", "Lights", 8 * 1024 * 1024);
    config = new File(context.getFilesDir(), "home-assistant.json");
  }

  synchronized WebResourceResponse request(Uri uri) {
    if (!"https".equals(uri.getScheme()) || !MainActivity.BUNDLED_HOST.equals(uri.getHost())
        || !"/dashboard/lights/rooms.json".equals(uri.getPath())) return null;
    try (InputStream input = new FileInputStream(config)) {
      JSONObject settings = new JSONObject(new String(read(input, 16384), StandardCharsets.UTF_8));
      String base = settings.getString("url");
      Uri server = Uri.parse(base);
      token = settings.getString("token");
      if (!("http".equals(server.getScheme()) || "https".equals(server.getScheme()))
          || server.getHost() == null || server.getUserInfo() != null || server.getQuery() != null
          || server.getFragment() != null || !(server.getPath() == null || server.getPath().isEmpty())
          || !token.matches("[A-Za-z0-9._~-]+")) throw new IOException("Invalid configuration");
      return fetch(base + "/api/template", 0);
    } catch (IOException | JSONException | IllegalArgumentException invalid) {
      return response("application/json", 404, new byte[0], false, 0);
    } finally { token = null; }
  }

  // A template evaluates current state and HA's own entity/device area resolution.
  // Named lighting switches are included, but switch LED indicators and fans are not.
  static final String TEMPLATE =
      "{% set ns = namespace(rooms=[], lights=[]) %}"
      + "{% for a in areas() %}{% set ns.rooms = ns.rooms + [dict(id=a, name=area_name(a))] %}{% endfor %}"
      + "{% for s in states.light | list + states.switch | list %}"
      + "{% if s.domain == 'light' or (s.entity_id is search('(^|[._])lights?(_|$)') "
      + "and not s.entity_id is search('(^|[._])led(_|$)')) %}"
      + "{% set ns.lights = ns.lights + [dict(id=s.entity_id, name=s.name, room=area_id(s.entity_id), state=s.state)] %}"
      + "{% endif %}{% endfor %}{{ dict(rooms=ns.rooms, lights=ns.lights) | to_json }}";

  @Override String mimeType(int status) { return "application/json"; }
  @Override void validate(byte[] data) throws IOException { normalize(data); }

  private byte[] normalize(byte[] data) throws IOException {
    try {
      JSONObject input = new JSONObject(new String(data, StandardCharsets.UTF_8));
      JSONArray rooms = input.getJSONArray("rooms"), lights = input.getJSONArray("lights");
      JSONArray safeRooms = new JSONArray(), safeLights = new JSONArray();
      Set<String> roomIds = new HashSet<>(), lightIds = new HashSet<>();
      for (int i = 0; i < rooms.length(); i++) {
        JSONObject room = rooms.getJSONObject(i);
        String id = room.getString("id");
        if (id.isEmpty() || !roomIds.add(id)) throw new IOException("Invalid room");
        safeRooms.put(new JSONObject().put("id", id).put("name", room.getString("name")));
      }
      for (int i = 0; i < lights.length(); i++) {
        JSONObject light = lights.getJSONObject(i);
        String id = light.getString("id"), state = light.getString("state");
        if (!id.matches("(?:light|switch)\\.[a-z0-9_]+") || !lightIds.add(id)) throw new IOException("Invalid light");
        String room = light.isNull("room") ? null : light.getString("room");
        safeLights.put(new JSONObject().put("id", id).put("name", light.getString("name"))
            .put("room", room != null && roomIds.contains(room) ? room : JSONObject.NULL)
            .put("state", "on".equals(state) || "off".equals(state) ? state : "unavailable"));
      }
      return new JSONObject().put("rooms", safeRooms).put("lights", safeLights).toString().getBytes(StandardCharsets.UTF_8);
    } catch (JSONException invalid) { throw new IOException("Invalid lights data"); }
  }

  @Override byte[] download(String address) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
    connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
    connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
    connection.setRequestProperty("Authorization", "Bearer " + token);
    connection.setRequestProperty("Accept", "application/json");
    connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
    connection.setRequestProperty("User-Agent", "HomeHQ-Lights/1.0");
    try {
      connection.setRequestMethod("POST");
      connection.setDoOutput(true);
      byte[] body = new JSONObject().put("template", TEMPLATE).toString().getBytes(StandardCharsets.UTF_8);
      connection.setFixedLengthStreamingMode(body.length);
      try (OutputStream output = connection.getOutputStream()) { output.write(body); }
      if (connection.getResponseCode() != 200) throw new IOException("Lights unavailable");
      try (InputStream input = connection.getInputStream()) { return normalize(read(input, 8 * 1024 * 1024)); }
    } catch (JSONException invalid) { throw new IOException("Invalid lights request"); }
    finally { connection.disconnect(); }
  }
}
