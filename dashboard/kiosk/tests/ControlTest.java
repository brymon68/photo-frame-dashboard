package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Tests real request validation and serialized HTTP service writes without a network. */
public class ControlTest {
  static int checks, requests, posts, status = 200;
  static String state, posted, address;
  static Fake last;
  static class Fake extends HttpURLConnection {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    Fake(URL url) { super(url); last = this; requests++; }
    public OutputStream getOutputStream() { return out; }
    public int getResponseCode() {
      if ("POST".equals(getRequestMethod())) { posts++; posted = out.toString(); address = getURL().toString(); }
      return status;
    }
    public InputStream getInputStream() { return new ByteArrayInputStream(state.getBytes(StandardCharsets.UTF_8)); }
    public void connect() {} public void disconnect() {} public boolean usingProxy() { return false; }
  }
  static void check(boolean ok, String message) { checks++; if (!ok) throw new AssertionError(message); }
  static JSONObject json(String s) throws JSONException { return new JSONObject(s); }
  static JSONObject climate(String mode, int features) throws JSONException {
    return json("{\"entity_id\":\"climate.room\",\"state\":\"" + mode + "\",\"attributes\":{\"supported_features\":" + features
        + ",\"min_temp\":50,\"max_temp\":90,\"target_temp_step\":0.5,\"temperature\":70,\"hvac_modes\":[\"heat\",\"cool\",\"heat_cool\",\"off\"]}}");
  }
  static JSONObject command(String values) throws JSONException {
    return json("{\"entity\":\"climate.room\",\"action\":\"set_temperature\"," + values + "}");
  }
  static void rejects(JSONObject command, JSONObject current) throws Exception {
    boolean rejected = false;
    try { HomeAssistantControl.payload(command, current); } catch (IllegalArgumentException | JSONException expected) { rejected = true; }
    check(rejected, "Invalid or stale command rejected: " + command);
  }
  static WebResourceRequest request(String method, String origin, String command) {
    return new WebResourceRequest() {
      public Uri getUrl() { return Uri.parse("https://appassets.androidplatform.net/dashboard/home-assistant/command"); }
      public String getMethod() { return method; }
      public Map<String, String> getRequestHeaders() {
        Map<String,String> h = new HashMap<>(); h.put("origin", origin); h.put("x-homehq-command", command); return h;
      }
    };
  }
  public static void main(String[] args) throws Exception {
    for (String id : new String[] {"light.lamp", "switch.kitchen_lights", "switch.light_porch"}) {
      check(HomeAssistantControl.allowed(id, "turn_on") && HomeAssistantControl.allowed(id, "turn_off"), "Lighting allowlist");
      check(!HomeAssistantControl.allowed(id, "toggle"), "No ambiguous toggle writes");
    }
    for (String id : new String[] {"switch.fan", "switch.light_led", "switch.lightning", "lock.door", "light.room/../lock", "light.room,light.other"}) {
      check(!HomeAssistantControl.allowed(id, "turn_on"), "Non-light or injected target blocked");
    }
    JSONObject heat = climate("heat", 1);
    check(HomeAssistantControl.payload(command("\"mode\":\"heat\",\"target\":70.5"), heat).getDouble("temperature") == 70.5, "Scalar temperature");
    rejects(command("\"mode\":\"cool\",\"target\":70"), heat);
    rejects(command("\"mode\":\"heat\",\"target\":49"), heat);
    rejects(command("\"mode\":\"heat\",\"target\":91"), heat);
    rejects(command("\"mode\":\"heat\",\"target\":70.25"), heat);
    rejects(command("\"mode\":\"heat\",\"target\":70,\"targetLow\":65"), heat);
    rejects(command("\"mode\":\"off\",\"target\":70"), climate("off", 1));
    rejects(command("\"mode\":\"heat\",\"target\":70"), climate("heat", 0));
    rejects(command("\"mode\":\"heat\",\"target\":70"), climate("unavailable", 1));
    JSONObject range = climate("heat_cool", 3);
    JSONObject both = HomeAssistantControl.payload(command("\"mode\":\"heat_cool\",\"targetLow\":65,\"targetHigh\":75"), range);
    check(both.getDouble("target_temp_low") == 65 && both.getDouble("target_temp_high") == 75, "Both range endpoints");
    rejects(command("\"mode\":\"heat_cool\",\"targetLow\":78,\"targetHigh\":70"), range);
    rejects(command("\"mode\":\"heat_cool\",\"target\":70"), range);
    JSONObject mode = json("{\"entity\":\"climate.room\",\"action\":\"set_hvac_mode\",\"mode\":\"off\"}");
    check(HomeAssistantControl.payload(mode, heat).getString("hvac_mode").equals("off"), "Supported mode");
    mode.put("mode", "auto"); rejects(mode, heat);

    JSONObject dimmer = json("{\"entity_id\":\"light.bedroom\",\"state\":\"off\",\"attributes\":{\"supported_color_modes\":[\"brightness\"]}}");
    JSONObject brightness = json("{\"entity\":\"light.bedroom\",\"action\":\"turn_on\",\"brightness\":50}");
    check(HomeAssistantControl.payload(brightness, dimmer).getInt("brightness_pct") == 50, "Brightness percentage service payload");
    for (double level : new double[] {-1, 0, 100.1, 101, 50.5}) {
      brightness.put("brightness", level); rejects(brightness, dimmer);
    }
    brightness.put("brightness", 100);
    check(HomeAssistantControl.payload(brightness, dimmer).getInt("brightness_pct") == 100, "Full brightness allowed");
    brightness.put("action", "turn_off"); rejects(brightness, dimmer); brightness.put("action", "turn_on");
    dimmer.put("state", "unavailable"); rejects(brightness, dimmer); dimmer.put("state", "on");
    dimmer.put("attributes", json("{\"supported_color_modes\":[\"onoff\"]}")); rejects(brightness, dimmer);
    dimmer.put("entity_id", "switch.room_lights"); brightness.put("entity", "switch.room_lights"); rejects(brightness, dimmer);

    URL.setURLStreamHandlerFactory(protocol -> protocol.equals("http") ? new URLStreamHandler() {
      protected URLConnection openConnection(URL url) { return new Fake(url); }
    } : null);
    Path files = Files.createDirectory(Paths.get(args[0], "controls"));
    Files.write(files.resolve("home-assistant.json"), "{\"url\":\"http://ha.test:8123\",\"token\":\"test-token\"}".getBytes(StandardCharsets.UTF_8));
    HomeAssistantControl control = new HomeAssistantControl(new Context(files.toFile()));
    String origin = "https://appassets.androidplatform.net";
    String light = "{\"entity\":\"switch.room_lights\",\"action\":\"turn_on\"}";
    for (String method : new String[] {"GET", "OPTIONS"}) check(control.request(request(method, origin, light)).status == 403, "Reject unsafe method");
    check(control.request(request("POST", "https://evil.test", light)).status == 403, "Reject cross origin");
    check(control.request(request("POST", null, light)).status == 403, "Reject missing origin");
    check(control.request(request("POST", origin, null)).status == 400, "Reject missing command");
    check(requests == 0, "Rejected browser requests never contact HA");
    state = "{\"entity_id\":\"switch.room_lights\",\"state\":\"off\"}";
    check(control.request(request("POST", origin, light)).status == 200, "Successful command");
    check(requests == 2 && posts == 1, "Revalidate then exactly one service write");
    check(address.endsWith("/api/services/switch/turn_on"), "Correct service domain");
    check(json(posted).getString("entity_id").equals("switch.room_lights"), "Explicit entity target");
    check(last.getRequestProperty("Authorization").equals("Bearer test-token"), "Native authentication");
    check(!last.getInstanceFollowRedirects() && !last.getUseCaches(), "No redirects or cache");
    state = "{\"entity_id\":\"light.bedroom\",\"state\":\"off\",\"attributes\":{\"supported_color_modes\":[\"brightness\"]}}";
    check(control.request(request("POST", origin, "{\"entity\":\"light.bedroom\",\"action\":\"turn_on\",\"brightness\":37}")).status == 200, "Brightness request accepted");
    check(address.endsWith("/api/services/light/turn_on") && json(posted).getInt("brightness_pct") == 37, "Brightness uses real light service");
    state = "{\"entity_id\":\"switch.room_lights\",\"state\":\"unavailable\"}";
    check(control.request(request("POST", origin, light)).status == 409 && posts == 2, "Unavailable device causes no write");
    status = 401;
    check(control.request(request("POST", origin, light)).status == 503 && posts == 2, "Failed authorization causes no write");
    status = 302;
    check(control.request(request("POST", origin, light)).status == 503 && posts == 2, "Redirect causes no write");
    System.out.println("Native control checks passed: " + checks);
  }
}
