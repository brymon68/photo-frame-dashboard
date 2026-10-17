package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/** Narrow service transport for packaged Home controls. Never exposes credentials or raw HA responses. */
final class HomeAssistantControl {
  private final File config;
  HomeAssistantControl(Context context) { config = new File(context.getFilesDir(), "home-assistant.json"); }

  WebResourceResponse request(WebResourceRequest request) {
    Uri uri = request.getUrl();
    if (!"https".equals(uri.getScheme()) || !MainActivity.BUNDLED_HOST.equals(uri.getHost())
        || !"/dashboard/home-assistant/command".equals(uri.getPath())) return null;
    // Custom headers require a CORS preflight from other origins, which this endpoint rejects.
    // POST prevents prefetches/reloads from operating equipment. Command data is in a bounded
    // header because Android's request interception API does not expose the request body.
    if (!"POST".equals(request.getMethod()) || uri.getPort() != -1 || uri.getQuery() != null
        || ! ("https://" + MainActivity.BUNDLED_HOST).equals(header(request, "Origin"))) {
      return reply(403, "forbidden");
    }
    String command = header(request, "X-HomeHQ-Command");
    if (command == null || command.length() > 2048) return reply(400, "invalid");
    try {
      JSONObject input = new JSONObject(command);
      String id = input.getString("entity"), action = input.getString("action");
      if (!allowed(id, action)) return reply(400, "invalid");
      JSONObject settings;
      try (InputStream file = new FileInputStream(config)) { settings = new JSONObject(read(file, 16384)); }
      String base = settings.getString("url"), token = settings.getString("token");
      Uri server = Uri.parse(base);
      if (!("http".equals(server.getScheme()) || "https".equals(server.getScheme()))
          || server.getHost() == null || server.getUserInfo() != null || server.getQuery() != null
          || server.getFragment() != null || !(server.getPath() == null || server.getPath().isEmpty())
          || !token.matches("[A-Za-z0-9._~-]+")) return reply(503, "unavailable");
      // Re-read capabilities immediately before every write; stale UI cannot bypass limits.
      JSONObject state = new JSONObject(http(base + "/api/states/" + id, token, null));
      if (!id.equals(state.getString("entity_id"))) return reply(409, "changed");
      JSONObject body = payload(input, state);
      http(base + "/api/services/" + id.substring(0, id.indexOf('.')) + "/" + action, token, body);
      return reply(200, "sent");
    } catch (IllegalArgumentException | JSONException invalid) { return reply(409, "changed"); }
    catch (IOException unavailable) { return reply(503, "unconfirmed"); }
  }

  private static String header(WebResourceRequest request, String name) {
    for (Map.Entry<String, String> entry : request.getRequestHeaders().entrySet()) {
      if (name.equalsIgnoreCase(entry.getKey())) return entry.getValue();
    }
    return null;
  }

  static boolean allowed(String id, String action) {
    if (id.matches("climate\\.[a-z0-9_]+")) return "set_temperature".equals(action) || "set_hvac_mode".equals(action);
    boolean light = id.matches("light\\.[a-z0-9_]+") || id.matches("switch\\.[a-z0-9_]+")
        && java.util.regex.Pattern.compile("(^|[._])lights?(_|$)").matcher(id).find()
        && !java.util.regex.Pattern.compile("(^|[._])led(_|$)").matcher(id).find();
    return light && ("turn_on".equals(action) || "turn_off".equals(action));
  }

  static JSONObject payload(JSONObject input, JSONObject state) throws JSONException {
    String id = input.getString("entity"), action = input.getString("action"), mode = state.getString("state");
    require(allowed(id, action) && id.equals(state.getString("entity_id")));
    require(!"unavailable".equals(mode) && !"unknown".equals(mode));
    JSONObject body = new JSONObject().put("entity_id", id);
    Set<String> keys = new HashSet<>(Arrays.asList("entity", "action"));
    if ("turn_on".equals(action) || "turn_off".equals(action)) {
      require("on".equals(mode) || "off".equals(mode));
      if (!input.isNull("brightness")) {
        keys.add("brightness");
        require("turn_on".equals(action) && id.startsWith("light.") && supportsBrightness(state.getJSONObject("attributes")));
        double level = input.getDouble("brightness");
        require(Double.isFinite(level) && level == Math.rint(level) && level >= 1 && level <= 100);
        body.put("brightness_pct", (int) level);
      }
    } else {
      JSONObject attrs = state.getJSONObject("attributes");
      if ("set_hvac_mode".equals(action)) {
        keys.add("mode");
        String requested = input.getString("mode");
        require(Arrays.asList("off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only").contains(requested));
        JSONArray modes = attrs.getJSONArray("hvac_modes");
        boolean supported = false;
        for (int i = 0; i < modes.length(); i++) supported |= requested.equals(modes.getString(i));
        require(supported);
        body.put("hvac_mode", requested);
      } else {
        keys.add("mode");
        require(mode.equals(input.getString("mode")) && !Arrays.asList("off", "fan_only", "dry").contains(mode));
        int features = attrs.getInt("supported_features");
        boolean range = (features & 2) != 0 && ("heat_cool".equals(mode) || "auto".equals(mode) && attrs.isNull("temperature"));
        if (range) {
          keys.add("targetLow"); keys.add("targetHigh");
          double low = target(input, attrs, "targetLow"), high = target(input, attrs, "targetHigh");
          require(low <= high);
          body.put("target_temp_low", low).put("target_temp_high", high);
        } else {
          require((features & 1) != 0 && !"heat_cool".equals(mode));
          keys.add("target"); body.put("temperature", target(input, attrs, "target"));
        }
      }
    }
    for (Iterator<String> it = input.keys(); it.hasNext();) require(keys.contains(it.next()));
    return body;
  }

  static boolean supportsBrightness(JSONObject attributes) throws JSONException {
    if (attributes.isNull("supported_color_modes")) return false;
    JSONArray modes = attributes.getJSONArray("supported_color_modes");
    for (int i = 0; i < modes.length(); i++) {
      if (Arrays.asList("brightness", "color_temp", "hs", "xy", "rgb", "rgbw", "rgbww", "white").contains(modes.getString(i))) return true;
    }
    return false;
  }

  private static double target(JSONObject input, JSONObject attrs, String key) throws JSONException {
    double value = input.getDouble(key), min = attrs.getDouble("min_temp"), max = attrs.getDouble("max_temp");
    require(Double.isFinite(value) && Double.isFinite(min) && Double.isFinite(max) && min < max && value >= min && value <= max);
    if (!attrs.isNull("target_temp_step")) {
      double step = attrs.getDouble("target_temp_step");
      require(Double.isFinite(step) && step > 0);
      double ticks = (value - min) / step;
      require(Math.abs(ticks - Math.rint(ticks)) < 0.00001);
    }
    return value;
  }

  private static void require(boolean condition) { if (!condition) throw new IllegalArgumentException("Unsupported command"); }

  private String http(String url, String token, JSONObject body) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setConnectTimeout(5000); connection.setReadTimeout(8000);
    connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
    connection.setRequestProperty("Authorization", "Bearer " + token);
    connection.setRequestProperty("Accept", "application/json");
    try {
      if (body != null) {
        connection.setRequestMethod("POST"); connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
      }
      if (connection.getResponseCode() != 200) throw new IOException("Command unconfirmed");
      if (body != null) return ""; // Service responses may include unrelated entities; discard them.
      try (InputStream in = connection.getInputStream()) { return read(in, 256 * 1024); }
    } finally { connection.disconnect(); }
  }

  private static String read(InputStream input, int limit) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[4096]; int n;
    while ((n = input.read(buffer)) != -1) {
      if (output.size() + n > limit) throw new IOException("Size limit reached");
      output.write(buffer, 0, n);
    }
    return new String(output.toByteArray(), StandardCharsets.UTF_8);
  }

  private WebResourceResponse reply(int status, String code) {
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff");
    String body = "{\"ok\":" + (status == 200) + ",\"code\":\"" + code + "\"}";
    return new WebResourceResponse("application/json", "UTF-8", status, status == 200 ? "OK" : "Command unavailable",
        headers, new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
  }
}
