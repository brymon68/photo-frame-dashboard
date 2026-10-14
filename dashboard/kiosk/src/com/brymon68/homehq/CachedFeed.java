package com.brymon68.homehq;

import android.content.Context;
import android.util.AtomicFile;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;

/** Bounded downloads with an atomic disk cache; default transport is HTTPS-only. */
abstract class CachedFeed {
  private final AtomicFile cache;
  private final String name;
  private final int limit;

  CachedFeed(Context context, String filename, String name, int limit) {
    cache = new AtomicFile(new File(context.getFilesDir(), filename));
    this.name = name;
    this.limit = limit;
  }

  abstract String mimeType(int status);
  abstract void validate(byte[] data) throws IOException;

  final synchronized WebResourceResponse fetch(String address, long reuseMillis) {
    long age = System.currentTimeMillis() - cache.getBaseFile().lastModified();
    if (age >= 0 && age < reuseMillis) {
      try { return cached(false); } catch (IOException ignored) { }
    }
    try {
      byte[] data = download(address);
      FileOutputStream output = null;
      try {
        output = cache.startWrite(); output.write(data); cache.finishWrite(output);
      } catch (IOException storageFailure) {
        cache.failWrite(output); // Fresh data is useful even when storage is full.
      }
      return response(mimeType(200), 200, data, false, System.currentTimeMillis());
    } catch (IOException unavailable) {
      // Networking errors can contain a secret URL; never log exception messages.
      try { return cached(true); }
      catch (IOException noCache) { return response(mimeType(503), 503, new byte[0], true, 0); }
    }
  }

  private WebResourceResponse cached(boolean stale) throws IOException {
    try (InputStream input = cache.openRead()) {
      return response(mimeType(200), 200, read(input, limit), stale, cache.getBaseFile().lastModified());
    }
  }

  byte[] download(String address) throws IOException {
    HttpsURLConnection connection = (HttpsURLConnection) new URL(address).openConnection();
    connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
    connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
    connection.setRequestProperty("Accept", mimeType(200));
    connection.setRequestProperty("User-Agent", "HomeHQ-" + name + "/1.0");
    try {
      if (connection.getResponseCode() != 200) throw new IOException(name + " unavailable");
      try (InputStream input = connection.getInputStream()) {
        byte[] data = read(input, limit);
        validate(data); // Reject malformed responses before replacing the cache.
        return data;
      }
    } finally { connection.disconnect(); }
  }

  final byte[] read(InputStream input, int maxBytes) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192]; int size;
    while ((size = input.read(buffer)) != -1) {
      if (output.size() + size > maxBytes) throw new IOException(name + " size limit reached");
      output.write(buffer, 0, size);
    }
    return output.toByteArray();
  }

  final WebResourceResponse response(String type, int status, byte[] data, boolean stale, long updated) {
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff");
    headers.put("X-" + name + "-Stale", Boolean.toString(stale));
    headers.put("X-" + name + "-Updated", Long.toString(updated));
    return new WebResourceResponse(type, "UTF-8", status,
        status == 200 ? "OK" : status == 404 ? "Not Found" : "Service Unavailable",
        headers, new ByteArrayInputStream(data));
  }
}
