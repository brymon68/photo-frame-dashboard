package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Private, read-only Google iCal transport for the bundled dashboard only. */
final class CalendarFeed extends CachedFeed {
  private final Context context;
  private final File address;
  private final File configuration;
  private final File availability;
  private final Map<String, SourceFeed> feeds = new HashMap<>();

  private static final class Source {
    final String id, name, color, url;
    final Availability snapshot;

    Source(String id, String name, String color, String url) {
      this(id, name, color, url, null);
    }

    Source(String id, String name, String color, String url, Availability snapshot) {
      this.id = id; this.name = name; this.color = color; this.url = url; this.snapshot = snapshot;
    }
  }

  private static final class Availability {
    final String revision;
    final long updated, rangeStart, rangeEnd;
    final byte[] calendar;

    Availability(String revision, long updated, long rangeStart, long rangeEnd, byte[] calendar) {
      this.revision = revision; this.updated = updated; this.rangeStart = rangeStart;
      this.rangeEnd = rangeEnd; this.calendar = calendar;
    }
  }

  private static final class SourceFeed extends CachedFeed {
    final String filename;

    SourceFeed(Context context, String filename) {
      super(context, filename, "Calendar", 8 * 1024 * 1024);
      this.filename = filename;
    }

    @Override String mimeType(int status) { return status == 200 ? "text/calendar" : "text/plain"; }
    @Override void validate(byte[] data) throws IOException { validateCalendar(data); }
  }

  CalendarFeed(Context context) {
    super(context, "calendar-feed.ics", "Calendar", 8 * 1024 * 1024);
    this.context = context;
    address = new File(context.getFilesDir(), "calendar-url.txt");
    configuration = new File(context.getFilesDir(), "calendar-sources.json");
    availability = new File(context.getFilesDir(), "calendar-availability.json");
  }

  WebResourceResponse request(Uri uri) {
    String path = uri.getPath();
    if (!"https".equals(uri.getScheme()) || !MainActivity.BUNDLED_HOST.equals(uri.getHost())
        || path == null || !path.startsWith("/dashboard/calendar/")) return null;
    List<Source> sources = readSources();
    if ("/dashboard/calendar/status.json".equals(path)) {
      StringBuilder metadata = new StringBuilder();
      for (Source source : sources) {
        if (metadata.length() > 0) metadata.append(',');
        metadata.append("{\"id\":").append(JSONObject.quote(source.id))
            .append(",\"name\":").append(JSONObject.quote(source.name))
            .append(",\"color\":").append(JSONObject.quote(source.color))
            .append(",\"revision\":").append(JSONObject.quote(source.snapshot == null ? digest(source.url) : source.snapshot.revision));
        if (source.snapshot != null) {
          metadata.append(",\"kind\":\"availability\",\"rangeStart\":").append(source.snapshot.rangeStart)
              .append(",\"rangeEnd\":").append(source.snapshot.rangeEnd);
        }
        metadata.append('}');
      }
      return response("application/json", 200,
          ("{\"configured\":" + !sources.isEmpty() + ",\"sources\":[" + metadata + "]}")
              .getBytes(StandardCharsets.UTF_8), false, 0);
    }
    for (Source source : sources) {
      if (("/dashboard/calendar/" + source.id + ".ics").equals(path)
          || ("family".equals(source.id) && "/dashboard/calendar/feed.ics".equals(path))) {
        if (source.snapshot != null) {
          long age = System.currentTimeMillis() - source.snapshot.updated;
          WebResourceResponse result = response("text/calendar", 200, source.snapshot.calendar,
              age > 30 * 60 * 1000 || age < -5 * 60 * 1000, source.snapshot.updated);
          Map<String, String> headers = new HashMap<>(result.getResponseHeaders());
          headers.put("X-Calendar-Revision", source.snapshot.revision);
          headers.put("X-Calendar-Range-Start", Long.toString(source.snapshot.rangeStart));
          headers.put("X-Calendar-Range-End", Long.toString(source.snapshot.rangeEnd));
          result.setResponseHeaders(headers);
          return result;
        }
        return "family".equals(source.id) ? fetch(source.url, 0) : sourceFeed(source).fetch(source.url, 0);
      }
    }
    return response("text/plain", 404, new byte[0], false, 0);
  }

  private synchronized SourceFeed sourceFeed(Source source) {
    String filename = "calendar-" + source.id + "-" + digest(source.url) + ".ics";
    SourceFeed feed = feeds.get(source.id);
    if (feed == null || !filename.equals(feed.filename)) {
      feed = new SourceFeed(context, filename);
      feeds.put(source.id, feed);
    }
    return feed;
  }

  private static String digest(String value) {
    try {
      byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder result = new StringBuilder();
      for (byte part : hash) result.append(String.format(Locale.US, "%02x", part & 0xff));
      return result.toString();
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 unavailable");
    }
  }

  private List<Source> readSources() {
    List<Source> sources = readUrlSources();
    Source imported = readAvailability();
    if (imported != null) {
      for (Source source : sources) if (source.id.equals(imported.id)) return sources;
      sources.add(imported);
    }
    return sources;
  }

  private Source readAvailability() {
    try (InputStream input = new FileInputStream(availability)) {
      JSONObject document = new JSONObject(new String(read(input, 512 * 1024), StandardCharsets.UTF_8));
      String id = document.getString("id");
      String name = document.getString("name").replaceAll("[\\p{Cntrl}\\u202a-\\u202e\\u2066-\\u2069]", "")
          .replaceAll("\\s+", " ").trim();
      String color = document.getString("color");
      String revision = document.getString("revision");
      if (!id.matches("[a-z][a-z0-9-]{0,31}") || "family".equals(id) || "feed".equals(id)
          || name.isEmpty() || name.length() > 40 || !color.matches("#[0-9a-fA-F]{6}")
          || !revision.matches("[a-f0-9]{64}")) return null;
      long updated = milliseconds(document, "updated");
      long rangeStart = milliseconds(document, "rangeStart");
      long rangeEnd = milliseconds(document, "rangeEnd");
      if (rangeStart >= rangeEnd || rangeEnd - rangeStart > 366L * 24 * 60 * 60 * 1000) return null;
      JSONArray intervals = document.getJSONArray("busy");
      if (intervals.length() > 5000) return null;
      SimpleDateFormat utc = new SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US);
      utc.setTimeZone(TimeZone.getTimeZone("UTC"));
      StringBuilder calendar = new StringBuilder("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Home HQ//Availability//EN\r\n");
      Set<String> identifiers = new HashSet<>();
      for (int index = 0; index < intervals.length(); index++) {
        JSONObject interval = intervals.getJSONObject(index);
        long start = milliseconds(interval, "start");
        long end = milliseconds(interval, "end");
        if (start >= end || start < rangeStart || end > rangeEnd) return null;
        String identifier = digest(id + ":" + revision + ":" + start + ":" + end);
        if (!identifiers.add(identifier)) continue;
        calendar.append("BEGIN:VEVENT\r\nUID:").append(identifier).append("@homehq\r\nDTSTAMP:")
            .append(utc.format(new Date(updated))).append("\r\nDTSTART:").append(utc.format(new Date(start)))
            .append("\r\nDTEND:").append(utc.format(new Date(((end + 999) / 1000) * 1000)))
            .append("\r\nSUMMARY:Busy\r\nEND:VEVENT\r\n");
      }
      calendar.append("END:VCALENDAR\r\n");
      Availability snapshot = new Availability(revision, updated, rangeStart, rangeEnd,
          calendar.toString().getBytes(StandardCharsets.UTF_8));
      return new Source(id, name, color.toUpperCase(Locale.US), null, snapshot);
    } catch (IOException | JSONException | RuntimeException ignored) { }
    return null;
  }

  private static long milliseconds(JSONObject object, String key) throws JSONException {
    Object value = object.get(key);
    if (!(value instanceof Number)) throw new JSONException("Timestamp must be numeric");
    double number = ((Number) value).doubleValue();
    if (Double.isNaN(number) || Double.isInfinite(number) || number != Math.floor(number)
        || number < 0 || number > 253402300799000L) throw new JSONException("Invalid timestamp");
    return (long) number;
  }

  private List<Source> readUrlSources() {
    List<Source> result = new ArrayList<>();
    String family = readAddress();
    if (family != null) result.add(new Source("family", "Family", "#111111", family));
    try (InputStream input = new FileInputStream(configuration)) {
      JSONArray entries = new JSONArray(new String(read(input, 40 * 1024), StandardCharsets.UTF_8));
      if (entries.length() > 7) return result;
      List<Source> additional = new ArrayList<>();
      Set<String> ids = new HashSet<>();
      for (int index = 0; index < entries.length(); index++) {
        JSONObject entry = entries.getJSONObject(index);
        String id = entry.getString("id");
        String name = entry.getString("name").replaceAll("[\\p{Cntrl}\\u202a-\\u202e\\u2066-\\u2069]", "")
            .replaceAll("\\s+", " ").trim();
        String color = entry.getString("color");
        String url = entry.getString("url").trim();
        if (!id.matches("[a-z][a-z0-9-]{0,31}") || "family".equals(id) || "feed".equals(id)
            || !ids.add(id) || name.isEmpty() || name.length() > 40
            || !color.matches("#[0-9a-fA-F]{6}") || !validAddress(url)) return result;
        additional.add(new Source(id, name, color.toUpperCase(Locale.US), url));
      }
      result.addAll(additional);
    } catch (IOException | JSONException | IllegalArgumentException ignored) { }
    return result;
  }

  private String readAddress() {
    try (InputStream input = new FileInputStream(address)) {
      String value = new String(read(input, 4096), StandardCharsets.UTF_8).trim();
      if (validAddress(value)) return value;
    } catch (IOException | IllegalArgumentException ignored) { }
    return null;
  }

  private static boolean validAddress(String value) {
    Uri uri = Uri.parse(value);
    String path = uri.getPath();
    return "https".equals(uri.getScheme()) && "calendar.google.com".equals(uri.getHost())
        && uri.getUserInfo() == null && uri.getPort() == -1 && uri.getQuery() == null
        && uri.getFragment() == null && path != null && path.startsWith("/calendar/ical/")
        && path.endsWith(".ics") && !value.matches("(?s).*[\\p{Cntrl}\\s].*")
        && value.getBytes(StandardCharsets.UTF_8).length <= 4096;
  }

  @Override String mimeType(int status) { return status == 200 ? "text/calendar" : "text/plain"; }

  @Override void validate(byte[] data) throws IOException {
    validateCalendar(data);
  }

  private static void validateCalendar(byte[] data) throws IOException {
    String calendar = new String(data, StandardCharsets.UTF_8).trim();
    if (!calendar.startsWith("BEGIN:VCALENDAR") || !calendar.endsWith("END:VCALENDAR")) {
      throw new IOException("Incomplete calendar");
    }
  }
}
