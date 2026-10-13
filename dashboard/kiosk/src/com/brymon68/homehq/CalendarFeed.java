package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Private, read-only Google iCal transport for the bundled dashboard only. */
final class CalendarFeed extends CachedFeed {
  private final File address;

  CalendarFeed(Context context) {
    super(context, "calendar-feed.ics", "Calendar", 8 * 1024 * 1024);
    address = new File(context.getFilesDir(), "calendar-url.txt");
  }

  WebResourceResponse request(Uri uri) {
    String path = uri.getPath();
    if (!"https".equals(uri.getScheme()) || !MainActivity.BUNDLED_HOST.equals(uri.getHost())
        || path == null || !path.startsWith("/dashboard/calendar/")) return null;
    String url = readAddress();
    if ("/dashboard/calendar/status.json".equals(path)) {
      return response("application/json", 200,
          ("{\"configured\":" + (url != null) + "}").getBytes(StandardCharsets.UTF_8), false, 0);
    }
    if (!"/dashboard/calendar/feed.ics".equals(path) || url == null) {
      return response("text/plain", 404, new byte[0], false, 0);
    }
    return fetch(url, 0);
  }

  private String readAddress() {
    try (InputStream input = new FileInputStream(address)) {
      String value = new String(read(input, 4096), StandardCharsets.UTF_8).trim();
      Uri uri = Uri.parse(value);
      String path = uri.getPath();
      if ("https".equals(uri.getScheme()) && "calendar.google.com".equals(uri.getHost())
          && uri.getUserInfo() == null && uri.getPort() == -1 && uri.getQuery() == null
          && uri.getFragment() == null && path != null && path.startsWith("/calendar/ical/")
          && path.endsWith(".ics") && !value.contains("\n") && !value.contains("\r")) return value;
    } catch (IOException ignored) { }
    return null;
  }

  @Override String mimeType(int status) { return status == 200 ? "text/calendar" : "text/plain"; }

  @Override void validate(byte[] data) throws IOException {
    String calendar = new String(data, StandardCharsets.UTF_8).trim();
    if (!calendar.startsWith("BEGIN:VCALENDAR") || !calendar.endsWith("END:VCALENDAR")) {
      throw new IOException("Incomplete calendar");
    }
  }
}
