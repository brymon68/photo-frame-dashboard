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
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    @Override public OutputStream getOutputStream() { return output; }
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

  private static String availability(long updated, long rangeStart, long rangeEnd, String busy) {
    return "{\"id\":\"work\",\"name\":\" Cyber \",\"color\":\"#2d5bff\","
        + "\"revision\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\","
        + "\"updated\":" + updated + ",\"rangeStart\":" + rangeStart + ",\"rangeEnd\":" + rangeEnd + ",\"busy\":" + busy + "}";
  }

  public static void main(String[] args) throws Exception {
    URL.setURLStreamHandlerFactory(protocol -> {
      if (protocol.equals("file") || protocol.equals("jar")) return null; // JDK/provider resources.
      return new URLStreamHandler() {
        @Override protected URLConnection openConnection(URL url) {
          if (!protocol.equals("https") && !protocol.equals("http")) throw new AssertionError("Only HTTP(S) is allowed");
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
    response(calendar.request(statusUri), "Calendar", 200, false, "application/json", "{\"configured\":false,\"sources\":[]}");
    response(calendar.request(calendarUri), "Calendar", 404, false, "text/plain", "");
    check(requests == 0, "Unconfigured calendar makes no network requests");
    Path address = files.resolve("calendar-url.txt");
    for (String bad : new String[] { ADDRESS.replace("https:", "http:"), ADDRESS.replace("calendar.google.com", "example.com"),
        ADDRESS.replace("calendar.google.com", "user@calendar.google.com"), ADDRESS.replace("calendar.google.com", "calendar.google.com:443"),
        ADDRESS + "?query=1", ADDRESS + "#fragment", ADDRESS.replace(".ics", ".txt"), "https://[invalid", ADDRESS + "\nsecond-line" }) {
      Files.write(address, bytes(bad));
      response(calendar.request(calendarUri), "Calendar", 404, false, "text/plain", "");
    }
    Files.write(address, bytes(ADDRESS));
    String familyStatus = body(calendar.request(statusUri));
    org.json.JSONObject calendarStatus = new org.json.JSONObject(familyStatus);
    org.json.JSONArray calendarSources = calendarStatus.getJSONArray("sources");
    check(calendarStatus.getString("configured").equals("true") && calendarSources.length() == 1, "Legacy Family calendar is configured");
    check(calendarSources.getJSONObject(0).getString("id").equals("family")
        && calendarSources.getJSONObject(0).getString("name").equals("Family")
        && calendarSources.getJSONObject(0).getString("color").equals("#111111"), "Legacy Family display identity is stable");
    check(calendarSources.getJSONObject(0).getString("revision").matches("[a-f0-9]{64}"), "Calendar revision is opaque");
    check(!familyStatus.contains(ADDRESS) && !familyStatus.contains("private-test"), "Status never contains private calendar addresses");
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

    Path sourceConfig = files.resolve("calendar-sources.json");
    String personalAddress = ADDRESS.replace("/test/", "/personal/");
    String personalCalendar = CALENDAR.replace("VERSION:2.0", "VERSION:2.0\nX-WR-CALNAME:Personal");
    String source = "{\"id\":\"personal\",\"name\":\"  Bryce  Calendar  \",\"color\":\"#2d5bff\",\"url\":\"" + personalAddress + "\"}";
    Files.write(sourceConfig, bytes("[" + source + "]"));
    String multipleStatus = body(calendar.request(statusUri));
    calendarSources = new org.json.JSONObject(multipleStatus).getJSONArray("sources");
    check(calendarSources.length() == 2, "Family and personal calendars are both configured");
    org.json.JSONObject personalSource = calendarSources.getJSONObject(1);
    check(personalSource.getString("id").equals("personal") && personalSource.getString("name").equals("Bryce Calendar")
        && personalSource.getString("color").equals("#2D5BFF"), "Additional display metadata is sanitized");
    check(!multipleStatus.contains("calendar.google.com") && !multipleStatus.contains("private-test"), "Multiple-source status omits URLs");
    String personalRevision = personalSource.getString("revision");
    Uri personalUri = Uri.parse(ORIGIN + "calendar/personal.ics");
    network(200, CALENDAR);
    response(calendar.request(Uri.parse(ORIGIN + "calendar/family.ics")), "Calendar", 200, false, "text/calendar", CALENDAR);
    check(last.getURL().toString().equals(ADDRESS), "Family alias uses the original address");
    network(200, personalCalendar);
    response(calendar.request(personalUri), "Calendar", 200, false, "text/calendar", personalCalendar);
    check(last.getURL().toString().equals(personalAddress), "Personal route uses only the selected address");
    Path personalCache = files.resolve("calendar-personal-" + personalRevision + ".ics");
    check(Arrays.equals(Files.readAllBytes(personalCache), bytes(personalCalendar)), "Personal feed has an independent persisted cache");
    check(Arrays.equals(Files.readAllBytes(files.resolve("calendar-feed.ics")), bytes(CALENDAR)), "Personal fetch preserves legacy Family cache");
    calendar = new CalendarFeed(context); network(503, "");
    response(calendar.request(personalUri), "Calendar", 200, true, "text/calendar", personalCalendar);
    response(calendar.request(calendarUri), "Calendar", 200, true, "text/calendar", CALENDAR);
    Files.write(sourceConfig, bytes("[" + source.replace("/personal/", "/replacement/") + "]"));
    String replacementRevision = new org.json.JSONObject(body(calendar.request(statusUri))).getJSONArray("sources")
        .getJSONObject(1).getString("revision");
    check(!replacementRevision.equals(personalRevision), "Changed source address changes the browser cache revision");
    response(calendar.request(personalUri), "Calendar", 503, true, "text/plain", "");
    check(Arrays.equals(Files.readAllBytes(personalCache), bytes(personalCalendar)), "Changed address never reuses another calendar's cached events");

    for (String invalid : new String[] { "{", "{}", "[" + source + "," + source + "]",
        "[" + source.replace("personal\"", "family\"") + "]",
        "[" + source.replace("personal\"", "feed\"") + "]",
        "[" + source.replace("personal\"", "../private\"") + "]",
        "[" + source.replace("personal\"", "Personal\"") + "]",
        "[" + source.replace("#2d5bff", "red") + "]",
        "[" + source.replace("  Bryce  Calendar  ", " ") + "]",
        "[" + source.replace("  Bryce  Calendar  ", "12345678901234567890123456789012345678901") + "]",
        "[" + source.replace("https://calendar.google.com", "https://example.com") + "]",
        "[" + source.replace("https://calendar.google.com", "http://calendar.google.com") + "]" }) {
      Files.write(sourceConfig, bytes(invalid)); prior = requests;
      response(calendar.request(statusUri), "Calendar", 200, false, "application/json", familyStatus);
      response(calendar.request(personalUri), "Calendar", 404, false, "text/plain", "");
      check(requests == prior, "Invalid additional configuration neither fetches nor breaks Family metadata");
    }
    StringBuilder manySources = new StringBuilder("[");
    for (int index = 0; index < 8; index++) {
      if (index > 0) manySources.append(',');
      manySources.append(source.replace("personal\"", "personal-" + index + "\""));
    }
    manySources.append(']');
    Files.write(sourceConfig, bytes(manySources.toString()));
    response(calendar.request(statusUri), "Calendar", 200, false, "application/json", familyStatus);
    Files.write(sourceConfig, new byte[40 * 1024 + 1]);
    response(calendar.request(statusUri), "Calendar", 200, false, "application/json", familyStatus);
    Files.write(sourceConfig, bytes("[" + source + "]"));
    Files.delete(address);
    calendarSources = new org.json.JSONObject(body(calendar.request(statusUri))).getJSONArray("sources");
    check(calendarSources.length() == 1 && calendarSources.getJSONObject(0).getString("id").equals("personal"), "An additional calendar works without a Family address");
    prior = requests;
    response(calendar.request(calendarUri), "Calendar", 404, false, "text/plain", "");
    check(requests == prior, "Missing Family cannot use another source or its old cache");
    Files.write(sourceConfig, bytes("[]"));
    response(calendar.request(statusUri), "Calendar", 200, false, "application/json", "{\"configured\":false,\"sources\":[]}");
    response(calendar.request(personalUri), "Calendar", 404, false, "text/plain", "");
    check(requests == prior, "Removing a source stops fetching and hides its old cache");
    Files.delete(sourceConfig);

    Path availabilityFile = files.resolve("calendar-availability.json");
    Uri availabilityUri = Uri.parse(ORIGIN + "calendar/work.ics");
    long rangeStart = java.time.Instant.parse("2026-10-17T08:00:00Z").toEpochMilli();
    long rangeEnd = rangeStart + 24 * 60 * 60 * 1000;
    long importedAt = System.currentTimeMillis() - 60000;
    String busyInterval = "{\"start\":" + (rangeStart + 3600000) + ",\"end\":" + (rangeStart + 7200000)
        + ",\"title\":\"Private meeting\",\"description\":\"Private details\"}";
    String snapshot = availability(importedAt, rangeStart, rangeEnd, "[" + busyInterval + "]");
    Files.write(availabilityFile, bytes(snapshot));
    prior = requests;
    String availabilityStatus = body(calendar.request(statusUri));
    org.json.JSONObject workSource = new org.json.JSONObject(availabilityStatus).getJSONArray("sources").getJSONObject(0);
    check(workSource.getString("id").equals("work") && workSource.getString("name").equals("Cyber")
        && workSource.getString("color").equals("#2D5BFF") && workSource.getString("kind").equals("availability"), "Availability source exposes sanitized display metadata");
    check(workSource.getDouble("rangeStart") == rangeStart && workSource.getDouble("rangeEnd") == rangeEnd, "Availability source exposes its coverage window");
    check(!availabilityStatus.contains("Private") && !availabilityStatus.contains("busy"), "Availability metadata omits private interval details");
    WebResourceResponse imported = calendar.request(availabilityUri);
    check(imported.status == 200 && imported.type.equals("text/calendar"), "Availability produces an iCal feed");
    check(imported.headers.get("X-Calendar-Updated").equals(Long.toString(importedAt))
        && imported.headers.get("X-Calendar-Stale").equals("false"), "Freshness uses the snapshot import timestamp");
    check(imported.headers.get("X-Calendar-Revision").equals(workSource.getString("revision"))
        && imported.headers.get("X-Calendar-Range-Start").equals(Long.toString(rangeStart))
        && imported.headers.get("X-Calendar-Range-End").equals(Long.toString(rangeEnd)), "Availability feed binds identity and coverage to its payload");
    String busyCalendar = body(imported);
    check(busyCalendar.startsWith("BEGIN:VCALENDAR\r\n") && busyCalendar.endsWith("END:VCALENDAR\r\n"), "Availability has a complete iCal envelope");
    check(busyCalendar.contains("DTSTART:20261017T090000Z\r\nDTEND:20261017T100000Z\r\nSUMMARY:Busy\r\n"), "Availability emits UTC Busy intervals only");
    check(!busyCalendar.contains("Private") && !busyCalendar.contains("Cyber") && !busyCalendar.contains("calendar.google.com"), "Availability never emits event details or addresses");
    String busyUid = busyCalendar.split("UID:")[1].split("\r\n")[0];
    check(busyUid.matches("[a-f0-9]{64}@homehq"), "Availability UID is opaque and stable");
    calendar = new CalendarFeed(context);
    response(calendar.request(availabilityUri), "Calendar", 200, false, "text/calendar", busyCalendar);
    check(requests == prior, "Availability survives restart without any network request");
    long oldImport = System.currentTimeMillis() - 31 * 60 * 1000;
    Files.write(availabilityFile, bytes(availability(oldImport, rangeStart, rangeEnd, "[" + busyInterval + "]")));
    WebResourceResponse staleImport = calendar.request(availabilityUri);
    check(staleImport.headers.get("X-Calendar-Stale").equals("true")
        && staleImport.headers.get("X-Calendar-Updated").equals(Long.toString(oldImport)), "Old snapshot stays usable with its original stale timestamp");
    check(body(staleImport).contains("UID:" + busyUid + "\r\n"), "Refreshing a snapshot keeps the same busy interval UID");
    long futureImport = System.currentTimeMillis() + 6 * 60 * 1000;
    Files.write(availabilityFile, bytes(availability(futureImport, rangeStart, rangeEnd, "[" + busyInterval + "]")));
    WebResourceResponse futureAvailability = calendar.request(availabilityUri);
    check(futureAvailability.headers.get("X-Calendar-Stale").equals("true")
        && futureAvailability.headers.get("X-Calendar-Updated").equals(Long.toString(futureImport)), "Materially future import timestamp is stale and never rewritten");
    body(futureAvailability);
    Files.write(availabilityFile, bytes(availability(importedAt, rangeStart, rangeEnd, "[]")));
    String emptyCalendar = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Home HQ//Availability//EN\r\nEND:VCALENDAR\r\n";
    response(calendar.request(availabilityUri), "Calendar", 200, false, "text/calendar", emptyCalendar);
    check(new org.json.JSONObject(body(calendar.request(statusUri))).getJSONArray("sources").length() == 1, "Empty busy intervals still represent a configured snapshot");
    Files.write(availabilityFile, bytes(availability(importedAt, rangeStart, rangeEnd, "[" + busyInterval + "," + busyInterval + "]")));
    response(calendar.request(availabilityUri), "Calendar", 200, false, "text/calendar", busyCalendar);
    String shortInterval = "[{\"start\":" + (rangeStart + 1) + ",\"end\":" + (rangeStart + 2) + "}]";
    Files.write(availabilityFile, bytes(availability(importedAt, rangeStart, rangeEnd, shortInterval)));
    check(body(calendar.request(availabilityUri)).contains("DTSTART:20261017T080000Z\r\nDTEND:20261017T080001Z"), "Subsecond intervals round outward to a nonempty iCal interval");
    Files.write(availabilityFile, bytes(snapshot));
    org.json.JSONObject beforeRollover = new org.json.JSONObject(body(calendar.request(statusUri))).getJSONArray("sources").getJSONObject(0);
    long shiftedStart = rangeStart + 24 * 60 * 60 * 1000;
    long shiftedEnd = rangeEnd + 24 * 60 * 60 * 1000;
    String shiftedInterval = "[{\"start\":" + (shiftedStart + 3600000) + ",\"end\":" + (shiftedStart + 7200000) + "}]";
    Files.write(availabilityFile, bytes(availability(importedAt + 1, shiftedStart, shiftedEnd, shiftedInterval)));
    WebResourceResponse rolled = calendar.request(availabilityUri);
    check(beforeRollover.getDouble("rangeStart") == rangeStart
        && rolled.headers.get("X-Calendar-Range-Start").equals(Long.toString(shiftedStart))
        && rolled.headers.get("X-Calendar-Range-End").equals(Long.toString(shiftedEnd))
        && rolled.headers.get("X-Calendar-Updated").equals(Long.toString(importedAt + 1)), "Snapshot rollover returns payload coverage independently of earlier status");
    check(body(rolled).contains("DTSTART:20261018T090000Z\r\nDTEND:20261018T100000Z"), "Rollover coverage and intervals describe the same snapshot");

    Files.write(address, bytes(ADDRESS));
    Files.write(sourceConfig, bytes("[" + source + "]"));
    Files.write(availabilityFile, bytes(snapshot));
    calendarSources = new org.json.JSONObject(body(calendar.request(statusUri))).getJSONArray("sources");
    check(calendarSources.length() == 3 && calendarSources.getJSONObject(0).getString("id").equals("family")
        && calendarSources.getJSONObject(1).getString("id").equals("personal")
        && calendarSources.getJSONObject(2).getString("id").equals("work"), "Availability appends after all existing calendars");
    Files.write(availabilityFile, bytes(snapshot.replace("\"id\":\"work\"", "\"id\":\"personal\"")));
    calendarSources = new org.json.JSONObject(body(calendar.request(statusUri))).getJSONArray("sources");
    check(calendarSources.length() == 2 && calendarSources.getJSONObject(1).isNull("kind"), "Availability cannot replace a configured source with the same ID");
    response(calendar.request(availabilityUri), "Calendar", 404, false, "text/plain", "");
    Files.delete(sourceConfig);
    for (String invalid : new String[] { "{", "[]", snapshot.replace("\"work\"", "\"family\""),
        snapshot.replace("\"work\"", "\"feed\""), snapshot.replace("\"work\"", "\"../work\""),
        snapshot.replace(" Cyber ", " "), snapshot.replace("#2d5bff", "blue"),
        snapshot.replace("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "revision"),
        snapshot.replace("\"updated\":" + importedAt, "\"updated\":-1"),
        snapshot.replace("\"updated\":" + importedAt, "\"updated\":1.5"),
        snapshot.replace("\"updated\":" + importedAt, "\"updated\":\"" + importedAt + "\""),
        snapshot.replace("\"updated\":" + importedAt, "\"updated\":1e999"),
        snapshot.replace("\"updated\":" + importedAt, "\"updated\":253402300799001"),
        availability(importedAt, rangeStart, rangeStart, "[]"),
        availability(importedAt, rangeStart, rangeStart + 366L * 24 * 60 * 60 * 1000 + 1, "[]"),
        availability(importedAt, rangeStart, rangeEnd, "{}"),
        availability(importedAt, rangeStart, rangeEnd, "[{\"start\":" + (rangeStart - 1) + ",\"end\":" + rangeEnd + "}]"),
        availability(importedAt, rangeStart, rangeEnd, "[{\"start\":" + rangeStart + ",\"end\":" + (rangeEnd + 1) + "}]"),
        availability(importedAt, rangeStart, rangeEnd, "[{\"start\":" + rangeEnd + ",\"end\":" + rangeStart + "}]"),
        availability(importedAt, rangeStart, rangeEnd, "[{\"start\":" + rangeStart + ",\"end\":" + rangeStart + "}]") }) {
      Files.write(availabilityFile, bytes(invalid));
      response(calendar.request(statusUri), "Calendar", 200, false, "application/json", familyStatus);
      response(calendar.request(availabilityUri), "Calendar", 404, false, "text/plain", "");
    }
    StringBuilder manyIntervals = new StringBuilder("[");
    for (int index = 0; index < 5001; index++) {
      if (index > 0) manyIntervals.append(',');
      manyIntervals.append("{\"start\":").append(rangeStart).append(",\"end\":").append(rangeEnd).append('}');
    }
    manyIntervals.append(']');
    Files.write(availabilityFile, bytes(availability(importedAt, rangeStart, rangeEnd, manyIntervals.toString())));
    response(calendar.request(availabilityUri), "Calendar", 404, false, "text/plain", "");
    Files.write(availabilityFile, new byte[512 * 1024 + 1]);
    response(calendar.request(availabilityUri), "Calendar", 404, false, "text/plain", "");
    check(requests == prior, "All availability reads and validation failures remain offline");
    Files.delete(availabilityFile);

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
    AtomicFile.failWrites = false;
    ClimateFeed climate = new ClimateFeed(context);
    Uri climateUri = Uri.parse(ORIGIN + "climate/devices.json");
    check(climate.request(Uri.parse("https://example.com/dashboard/climate/devices.json")) == null, "Climate origin restriction");
    check(climate.request(Uri.parse(ORIGIN.replace("https:", "http:") + "climate/devices.json")) == null, "Climate HTTPS origin restriction");
    response(climate.request(climateUri), "Climate", 404, false, "application/json", "");
    Path config = files.resolve("home-assistant.json");
    Files.write(config, bytes("{\"url\":\"http://ha.test:8123\",\"token\":\"test-token\"}"));
    String climateStates = "[{\"entity_id\":\"light.ignore\"},{\"entity_id\":\"climate.hallway\",\"state\":\"cool\","
        + "\"attributes\":{\"friendly_name\":\"Hallway\",\"current_temperature\":73,\"temperature\":74,\"hvac_action\":\"idle\",\"private_note\":\"ignore-this\"}},"
        + "{\"entity_id\":\"climate.bedroom\",\"state\":\"unavailable\",\"attributes\":{\"current_temperature\":66,\"temperature\":78,\"hvac_action\":\"heating\"}},{\"entity_id\":\"climate.range\",\"state\":\"heat_cool\",\"attributes\":{\"target_temp_low\":68,\"target_temp_high\":76}}]";
    network(200, climateStates);
    WebResourceResponse liveClimate = climate.request(climateUri);
    String filtered = body(liveClimate);
    check(liveClimate.status == 200, "Climate live response");
    org.json.JSONArray devices = new org.json.JSONArray(filtered);
    check(devices.length() == 3, "All and only climate devices returned");
    check(devices.getJSONObject(0).getDouble("temperature") == 73, "Current temperature, not setpoint");
    check(devices.getJSONObject(0).getString("name").equals("Hallway"), "Friendly name retained");
    check(devices.getJSONObject(0).getString("mode").equals("cool"), "Selected HVAC mode retained");
    check(devices.getJSONObject(0).getString("activity").equals("idle"), "Actual activity retained independently of mode");
    check(devices.getJSONObject(0).getDouble("target") == 74, "Target separate from current temperature");
    check(devices.getJSONObject(0).isNull("targetLow"), "Missing range remains null");
    check(devices.getJSONObject(1).isNull("target") && devices.getJSONObject(1).isNull("activity"), "Unavailable device suppresses old targets and activity");
    check(devices.getJSONObject(2).getDouble("targetLow") == 68 && devices.getJSONObject(2).getDouble("targetHigh") == 76, "Dual targets retained");
    check(devices.getJSONObject(2).isNull("target") && devices.getJSONObject(2).isNull("activity"), "Optional scalar target and action stay null");
    check(devices.getJSONObject(1).isNull("temperature"), "Unavailable device has no invented reading");
    check(devices.getJSONObject(1).getString("name").equals("bedroom"), "Missing name fallback");
    check(!filtered.contains("test-token") && !filtered.contains("light.ignore") && !filtered.contains("ignore-this"), "Only climate display fields leave native transport");
    check(last.getURL().toString().equals("http://ha.test:8123/api/states"), "Only states endpoint requested");
    check(last.getRequestMethod().equals("GET") && last.getRequestProperty("Authorization").equals("Bearer test-token"), "Authenticated GET");
    transport("Climate", "application/json");
    cache = files.resolve("climate-devices.json");
    for (int error : new int[] {401, 302, 503}) {
      network(error, "");
      response(climate.request(climateUri), "Climate", 200, true, "application/json", filtered);
    }
    network(200, "{}");
    response(climate.request(climateUri), "Climate", 200, true, "application/json", filtered);
    network(200, ""); payload = new byte[8 * 1024 * 1024 + 1];
    response(climate.request(climateUri), "Climate", 200, true, "application/json", filtered);
    check(Arrays.equals(Files.readAllBytes(cache), bytes(filtered)), "Invalid climate response preserves cache");
    network(200, "[]");
    response(climate.request(climateUri), "Climate", 200, false, "application/json", "[]");
    check(new String(Files.readAllBytes(cache), StandardCharsets.UTF_8).equals("[]"), "Removed devices disappear");
    Files.delete(config);
    prior = requests;
    response(climate.request(climateUri), "Climate", 404, false, "application/json", "");
    check(requests == prior, "Removed configuration never uses old credentials");
    LightsFeed lights = new LightsFeed(context);
    Uri lightsUri = Uri.parse(ORIGIN + "lights/rooms.json");
    check(lights.request(Uri.parse("https://example.com/dashboard/lights/rooms.json")) == null, "Lights origin restriction");
    check(lights.request(Uri.parse(ORIGIN.replace("https:", "http:") + "lights/rooms.json")) == null, "Lights HTTPS restriction");
    response(lights.request(lightsUri), "Lights", 404, false, "application/json", "");
    Files.write(config, bytes("{\"url\":\"http://ha.test:8123\",\"token\":\"test-token\"}"));
    String roomLights = "{\"rooms\":[{\"id\":\"room\",\"name\":\"Room\"}],\"lights\":["
        + "{\"id\":\"light.lamp\",\"name\":\"Lamp\",\"room\":\"room\",\"state\":\"on\",\"brightness\":128,\"supported_color_modes\":[\"brightness\"],\"private_note\":\"omit-me\"},"
        + "{\"id\":\"switch.ceiling_lights\",\"name\":\"Ceiling\",\"room\":null,\"state\":\"off\"},"
        + "{\"id\":\"light.lost\",\"name\":\"Lost\",\"room\":\"deleted\",\"state\":\"unknown\"}]}";
    network(200, roomLights);
    WebResourceResponse liveLights = lights.request(lightsUri);
    String safeLights = body(liveLights);
    org.json.JSONObject lightData = new org.json.JSONObject(safeLights);
    check(liveLights.status == 200 && lightData.getJSONArray("rooms").length() == 1, "Rooms retained");
    check(lightData.getJSONArray("lights").length() == 3, "Light and lighting switch states retained");
    check(lightData.getJSONArray("lights").getJSONObject(0).getString("room").equals("room"), "Room association retained");
    check(lightData.getJSONArray("lights").getJSONObject(0).getInt("level") == 50, "Brightness normalized to percentage");
    check(lightData.getJSONArray("lights").getJSONObject(0).getString("dimmable").equals("true"), "Brightness capability retained");
    check(lightData.getJSONArray("lights").getJSONObject(1).getInt("level") == 0, "Off displays zero brightness");
    check(lightData.getJSONArray("lights").getJSONObject(1).getString("dimmable").equals("false"), "Switch cannot dim");
    check(lightData.getJSONArray("lights").getJSONObject(2).isNull("level"), "Unknown brightness stays unknown");
    check(lightData.getJSONArray("lights").getJSONObject(2).isNull("room"), "Missing room treated as unassigned");
    check(lightData.getJSONArray("lights").getJSONObject(2).getString("state").equals("unavailable"), "Unknown is not off");
    check(!safeLights.contains("omit-me") && !safeLights.contains("test-token"), "Only display fields leave native feed");
    check(last.getURL().getPath().equals("/api/template") && last.getRequestMethod().equals("POST"), "Read-only template endpoint");
    check(last.getRequestProperty("Authorization").equals("Bearer test-token"), "Lights native authentication");
    check(new org.json.JSONObject(new String(last.output.toByteArray(), StandardCharsets.UTF_8)).getString("template").equals(LightsFeed.TEMPLATE), "Fixed template, no WebView commands");
    transport("Lights", "application/json");
    cache = files.resolve("lights-rooms.json");
    for (int status : new int[] {401, 302, 503}) {
      network(status, "");
      response(lights.request(lightsUri), "Lights", 200, true, "application/json", safeLights);
    }
    for (String invalid : new String[] {"{}", "{", roomLights.replace("light.lamp", "sensor.lamp"),
        roomLights.replace("light.lost", "light.lamp")}) {
      network(200, invalid);
      response(lights.request(lightsUri), "Lights", 200, true, "application/json", safeLights);
    }
    payload = new byte[8 * 1024 * 1024 + 1];
    response(lights.request(lightsUri), "Lights", 200, true, "application/json", safeLights);
    check(Arrays.equals(Files.readAllBytes(cache), bytes(safeLights)), "Invalid lights never replace cache");
    network(200, "{\"rooms\":[],\"lights\":[]}");
    response(lights.request(lightsUri), "Lights", 200, false, "application/json", "{\"rooms\":[],\"lights\":[]}");
    Files.delete(cache); network(503, "");
    response(lights.request(lightsUri), "Lights", 503, true, "application/json", "");
    AtomicFile.failWrites = true; network(200, roomLights);
    response(lights.request(lightsUri), "Lights", 200, false, "application/json", safeLights);
    check(!Files.exists(cache), "Lights work when storage is full");
    AtomicFile.failWrites = false;
    Files.delete(config); prior = requests;
    response(lights.request(lightsUri), "Lights", 404, false, "application/json", "");
    check(requests == prior, "Lights configuration removal clears credentials");
    System.out.println("Native feed contracts passed (" + checks + " assertions; fake HTTP(S) only)");
  }
}
