package com.wesbos.homehq;

import android.content.Context;
import android.net.Uri;
import android.util.AtomicFile;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;

/** Private, read-only Google iCal transport for the bundled dashboard only. */
final class CalendarFeed {
  private static final int MAX_BYTES = 8 * 1024 * 1024;
  private final File address;
  private final AtomicFile cache;

  CalendarFeed(Context context) {
    address = new File(context.getFilesDir(), "calendar-url.txt");
    cache = new AtomicFile(new File(context.getFilesDir(), "calendar-feed.ics"));
  }

  WebResourceResponse request(Uri uri) {
    String path = uri.getPath();
    if (!"https".equals(uri.getScheme()) || !MainActivity.BUNDLED_HOST.equals(uri.getHost())
        || path == null || !path.startsWith("/dashboard/calendar/")) return null;
    String url = readAddress();
    if ("/dashboard/calendar/status.json".equals(path)) {
      return response("application/json", 200,
          ("{\"configured\":" + (url != null) + "}").getBytes(java.nio.charset.StandardCharsets.UTF_8), false, 0);
    }
    if (!"/dashboard/calendar/feed.ics".equals(path) || url == null) {
      return response("text/plain", 404, new byte[0], false, 0);
    }
    return fetch(url);
  }

  private synchronized WebResourceResponse fetch(String url) {
    try {
      byte[] data = download(url);
      FileOutputStream output = null;
      try {
        output = cache.startWrite();
        output.write(data);
        cache.finishWrite(output);
      } catch (IOException storageFailure) {
        cache.failWrite(output);
        // Fresh data is still useful if persistent storage is temporarily full.
      }
      return response("text/calendar", 200, data, false, System.currentTimeMillis());
    } catch (IOException unavailable) {
      // Never log exception messages: networking errors can contain the secret URL.
      try (InputStream input = cache.openRead()) {
        return response("text/calendar", 200, read(input, MAX_BYTES), true, cache.getBaseFile().lastModified());
      } catch (IOException noCache) {
        return response("text/plain", 503, new byte[0], true, 0);
      }
    }
  }

  private String readAddress() {
    try (InputStream input = new FileInputStream(address)) {
      String value = new String(read(input, 4096), java.nio.charset.StandardCharsets.UTF_8).trim();
      Uri uri = Uri.parse(value);
      String path = uri.getPath();
      if ("https".equals(uri.getScheme()) && "calendar.google.com".equals(uri.getHost())
          && uri.getUserInfo() == null && uri.getPort() == -1 && uri.getQuery() == null
          && uri.getFragment() == null && path != null && path.startsWith("/calendar/ical/")
          && path.endsWith(".ics") && !value.contains("\n") && !value.contains("\r")) return value;
    } catch (IOException ignored) { }
    return null;
  }

  private static byte[] download(String address) throws IOException {
    HttpsURLConnection connection = (HttpsURLConnection) new URL(address).openConnection();
    connection.setConnectTimeout(10000);
    connection.setReadTimeout(15000);
    connection.setInstanceFollowRedirects(false);
    connection.setUseCaches(false);
    connection.setRequestProperty("Accept", "text/calendar");
    connection.setRequestProperty("User-Agent", "HomeHQ-Calendar/1.0");
    try {
      if (connection.getResponseCode() != 200) throw new IOException("Calendar unavailable");
      try (InputStream input = connection.getInputStream()) {
        byte[] data = read(input, MAX_BYTES);
        String calendar = new String(data, java.nio.charset.StandardCharsets.UTF_8).trim();
        if (!calendar.startsWith("BEGIN:VCALENDAR") || !calendar.endsWith("END:VCALENDAR")) {
          throw new IOException("Incomplete calendar");
        }
        return data;
      }
    } finally { connection.disconnect(); }
  }

  private static byte[] read(InputStream input, int limit) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int size;
    while ((size = input.read(buffer)) != -1) {
      if (output.size() + size > limit) throw new IOException("Calendar size limit reached");
      output.write(buffer, 0, size);
    }
    return output.toByteArray();
  }

  private static WebResourceResponse response(String type, int status, byte[] data, boolean stale, long updated) {
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store");
    headers.put("X-Content-Type-Options", "nosniff");
    headers.put("X-Calendar-Stale", Boolean.toString(stale));
    headers.put("X-Calendar-Updated", Long.toString(updated));
    return new WebResourceResponse(type, "UTF-8", status,
        status == 200 ? "OK" : status == 404 ? "Not Found" : "Service Unavailable",
        headers, new ByteArrayInputStream(data));
  }
}
