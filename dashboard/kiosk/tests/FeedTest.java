package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.util.AtomicFile;
import android.webkit.WebResourceResponse;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.security.cert.Certificate;
import java.util.Arrays;
import javax.net.ssl.HttpsURLConnection;

/** Contract tests; HTTPS is intercepted before any socket can be opened. */
public class FeedTest {
  private static final String ORIGIN = "https://appassets.androidplatform.net/dashboard/";
  private static final String ADDRESS = "https://calendar.google.com/calendar/ical/test/private-test/basic.ics";
  private static final String CALENDAR = "BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR";
  private static final String WEATHER = "{\"timezone\":\"America/Denver\",\"current_units\":{\"temperature_2m\":\"°F\"},"
      + "\"current\":{\"time\":1,\"temperature_2m\":72,\"apparent_temperature\":70,\"relative_humidity_2m\":20,\"is_day\":1,\"weather_code\":0,\"wind_speed_10m\":6},"
      + "\"hourly\":{\"time\":[1],\"temperature_2m\":[72],\"precipitation_probability\":[0],\"weather_code\":[0],\"is_day\":[1]},"
      + "\"daily\":{\"time\":[1],\"temperature_2m_max\":[78],\"temperature_2m_min\":[50]}}";
  private static int requests, checks, code;
  private static byte[] payload;
  private static boolean readFailure;
  private static FakeConnection last;

  private static class FakeConnection extends HttpsURLConnection {
    boolean disconnected;
    FakeConnection(URL url) { super(url); requests++; last = this; }
    @Override public int getResponseCode() { return code; }
    @Override public InputStream getInputStream() throws IOException {
      if (readFailure) throw new IOException("Simulated disconnect");
      return new ByteArrayInputStream(payload);
    }
    @Override public void disconnect() { disconnected = true; }
    @Override public boolean usingProxy() { return false; }
    @Override public void connect() { }
    @Override public String getCipherSuite() { return "TEST"; }
    @Override public Certificate[] getLocalCertificates() { return null; }
    @Override public Certificate[] getServerCertificates() { return null; }
  }

  private static void check(boolean ok, String message) {
    checks++;
    if (!ok) throw new AssertionError(message);
  }
  private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }
  private static void network(int status, String body) { code = status; payload = bytes(body); readFailure = false; }
  private static String body(WebResourceResponse response) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192]; int count;
    while ((count = response.body.read(buffer)) != -1) out.write(buffer, 0, count);
    return new String(out.toByteArray(), StandardCharsets.UTF_8);
  }
  private static void response(WebResourceResponse r, String name, int status, boolean stale, String type, String expected) throws IOException {
    check(r.status == status, name + " HTTP status");
    check(r.type.equals(type) && r.encoding.equals("UTF-8"), name + " content type");
    check(r.reason.equals(status == 200 ? "OK" : status == 404 ? "Not Found" : "Service Unavailable"), name + " reason");
    check(r.headers.get("X-" + name + "-Stale").equals(Boolean.toString(stale)), name + " stale header");
    check(r.headers.get("Cache-Control").equals("no-store") && r.headers.get("X-Content-Type-Options").equals("nosniff"), name + " browser cache headers");
    check(body(r).equals(expected), name + " response body");
  }
  private static void transport(String name, String type) {
    check(last.disconnected, name + " closes connection");
    check(last.getConnectTimeout() == 10000 && last.getReadTimeout() == 15000, name + " timeouts");
    check(!last.getInstanceFollowRedirects() && !last.getUseCaches(), name + " redirects and caches disabled");
    check(last.getRequestProperty("Accept").equals(type), name + " Accept");
    check(last.getRequestProperty("User-Agent").equals("HomeHQ-" + name + "/1.0"), name + " User-Agent");
  }

  public static void main(String[] args) throws Exception {
    URL.setURLStreamHandlerFactory(protocol -> {
      if (protocol.equals("file") || protocol.equals("jar")) return null; // JDK/provider resources.
      return new URLStreamHandler() {
        @Override protected URLConnection openConnection(URL url) {
          if (!protocol.equals("https")) throw new AssertionError("Only HTTPS is allowed");
          return new FakeConnection(url);
        }
      };
    });
    Path files = Files.createDirectory(Paths.get(args[0], "files"));
    Context context = new Context(files.toFile());
    CalendarFeed calendar = new CalendarFeed(context);
    Uri calendarUri = Uri.parse(ORIGIN + "calendar/feed.ics");
    Uri statusUri = Uri.parse(ORIGIN + "calendar/status.json");
    check(calendar.request(Uri.parse("https://example.com/dashboard/calendar/feed.ics")) == null, "Foreign origin is untouched");
    check(calendar.request(Uri.parse(ORIGIN.replace("https:", "http:") + "calendar/feed.ics")) == null, "HTTP origin is untouched");
    response(calendar.request(statusUri), "Calendar", 200, false, "application/json", "{\"configured\":false}");
    response(calendar.request(calendarUri), "Calendar", 404, false, "text/plain", "");
    check(requests == 0, "Unconfigured calendar makes no network requests");
    Path address = files.resolve("calendar-url.txt");
    for (String bad : new String[] { ADDRESS.replace("https:", "http:"), ADDRESS.replace("calendar.google.com", "example.com"),
        ADDRESS.replace("calendar.google.com", "user@calendar.google.com"), ADDRESS.replace("calendar.google.com", "calendar.google.com:443"),
        ADDRESS + "?query=1", ADDRESS + "#fragment", ADDRESS.replace(".ics", ".txt") }) {
      Files.write(address, bytes(bad));
      response(calendar.request(calendarUri), "Calendar", 404, false, "text/plain", "");
    }
    Files.write(address, bytes(ADDRESS));
    response(calendar.request(statusUri), "Calendar", 200, false, "application/json", "{\"configured\":true}");
    response(calendar.request(Uri.parse(ORIGIN + "calendar/missing")), "Calendar", 404, false, "text/plain", "");

    network(200, CALENDAR);
    long before = System.currentTimeMillis();
    WebResourceResponse fresh = calendar.request(calendarUri);
    check(Long.parseLong(fresh.headers.get("X-Calendar-Updated")) >= before, "Fresh calendar timestamp");
    response(fresh, "Calendar", 200, false, "text/calendar", CALENDAR);
    transport("Calendar", "text/calendar");
    Path cache = files.resolve("calendar-feed.ics");
    check(Arrays.equals(Files.readAllBytes(cache), bytes(CALENDAR)), "Fresh calendar persisted");
    int prior = requests;
    response(calendar.request(calendarUri), "Calendar", 200, false, "text/calendar", CALENDAR);
    check(requests == prior + 1, "Calendar never reuses a fresh cache without fetching");
    long saved = cache.toFile().lastModified();
    calendar = new CalendarFeed(context);
    for (int failure : new int[] { 503, 302, 200 }) {
      network(failure, "BEGIN:VCALENDAR");
      WebResourceResponse stale = calendar.request(calendarUri);
      response(stale, "Calendar", 200, true, "text/calendar", CALENDAR);
      check(Long.parseLong(stale.headers.get("X-Calendar-Updated")) == saved, "Persisted fallback timestamp");
      check(Arrays.equals(Files.readAllBytes(cache), bytes(CALENDAR)), "Failures preserve last good calendar");
      transport("Calendar", "text/calendar");
    }
    network(200, CALENDAR); readFailure = true;
    response(calendar.request(calendarUri), "Calendar", 200, true, "text/calendar", CALENDAR);
    readFailure = false; payload = new byte[8 * 1024 * 1024 + 1];
    response(calendar.request(calendarUri), "Calendar", 200, true, "text/calendar", CALENDAR);
    Files.delete(cache); network(503, "");
    WebResourceResponse unavailable = calendar.request(calendarUri);
    response(unavailable, "Calendar", 503, true, "text/plain", "");
    check(unavailable.headers.get("X-Calendar-Updated").equals("0"), "No-cache timestamp is zero");
    AtomicFile.failWrites = true; network(200, CALENDAR);
    response(calendar.request(calendarUri), "Calendar", 200, false, "text/calendar", CALENDAR);
    check(!Files.exists(cache), "Full disk still returns fresh data");
    AtomicFile.failWrites = false;

    WeatherFeed weather = new WeatherFeed(context);
    Uri weatherUri = Uri.parse(ORIGIN + "weather/forecast.json");
    check(weather.request(Uri.parse("https://example.com/dashboard/weather/forecast.json")) == null, "Weather origin restriction");
    network(200, WEATHER);
    response(weather.request(weatherUri), "Weather", 200, false, "application/json", WEATHER);
    transport("Weather", "application/json");
    cache = files.resolve("weather-forecast.json");
    weather = new WeatherFeed(context); prior = requests;
    network(503, "");
    response(weather.request(weatherUri), "Weather", 200, false, "application/json", WEATHER);
    check(requests == prior, "Weather reuses recent disk cache across instances");
    saved = System.currentTimeMillis() - 61000;
    Files.setLastModifiedTime(cache, FileTime.fromMillis(saved));
    WebResourceResponse stale = weather.request(weatherUri);
    response(stale, "Weather", 200, true, "application/json", WEATHER);
    check(Long.parseLong(stale.headers.get("X-Weather-Updated")) == saved, "Weather stale timestamp");
    check(requests == prior + 1, "Weather retries after reuse window");
    for (String invalid : new String[] { "{", "{}", WEATHER.replace("°F", "°C"), WEATHER.replace("America/Denver", "UTC"),
        WEATHER.replace("\"temperature_2m\":72", "\"temperature_2m\":null"), WEATHER.replace("\"time\":[1]", "\"time\":[]") }) {
      network(200, invalid);
      response(weather.request(weatherUri), "Weather", 200, true, "application/json", WEATHER);
      check(Arrays.equals(Files.readAllBytes(cache), bytes(WEATHER)), "Malformed weather preserves cache");
    }
    payload = new byte[512 * 1024 + 1];
    response(weather.request(weatherUri), "Weather", 200, true, "application/json", WEATHER);
    Files.setLastModifiedTime(cache, FileTime.fromMillis(System.currentTimeMillis() + 120000));
    network(503, ""); prior = requests;
    response(weather.request(weatherUri), "Weather", 200, true, "application/json", WEATHER);
    check(requests == prior + 1, "Future cache timestamps do not suppress a fetch after clock reset");
    Files.delete(cache);
    response(weather.request(weatherUri), "Weather", 503, true, "application/json", "");
    AtomicFile.failWrites = true; network(200, WEATHER);
    response(weather.request(weatherUri), "Weather", 200, false, "application/json", WEATHER);
    check(!Files.exists(cache), "Weather returns fresh data on a full disk");
    System.out.println("Native feed contracts passed (" + checks + " assertions; fake HTTPS only)");
  }
}
