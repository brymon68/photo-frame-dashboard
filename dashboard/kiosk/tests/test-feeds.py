#!/usr/bin/env python3
"""Exercise native feed contracts on the host; no Android device or network access.

Needs JDK 17 and Gson (included in Android command-line tools). Android IO and
org.json adapters below model only the APIs the feeds use. Pass --source-dir to
run the same contracts against an older checkout before a transport refactor.
"""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile


STUBS = {
    'android/webkit/WebResourceRequest.java': '''
package android.webkit;
import android.net.Uri;
import java.util.Map;
public interface WebResourceRequest {
  Uri getUrl(); String getMethod(); Map<String, String> getRequestHeaders();
}
''',
    'android/content/Context.java': '''
package android.content;
import java.io.File;
public class Context {
  private final File files;
  public Context(File files) { this.files = files; }
  public File getFilesDir() { return files; }
}
''',
    'android/net/Uri.java': '''
package android.net;
import java.net.URI;
public class Uri {
  private final URI value;
  private Uri(String text) { value = URI.create(text); }
  public static Uri parse(String text) { return new Uri(text); }
  public String getScheme() { return value.getScheme(); }
  public String getHost() { return value.getHost(); }
  public String getPath() { return value.getPath(); }
  public String getUserInfo() { return value.getUserInfo(); }
  public int getPort() { return value.getPort(); }
  public String getQuery() { return value.getQuery(); }
  public String getFragment() { return value.getFragment(); }
}
''',
    'android/util/AtomicFile.java': '''
package android.util;
import java.io.*;
import java.nio.file.*;
public class AtomicFile {
  public static boolean failWrites;
  private final File file, pending;
  public AtomicFile(File file) { this.file = file; pending = new File(file + ".new"); }
  public File getBaseFile() { return file; }
  public InputStream openRead() throws IOException { return new FileInputStream(file); }
  public FileOutputStream startWrite() throws IOException {
    if (failWrites) throw new IOException("Simulated full disk");
    return new FileOutputStream(pending);
  }
  public void finishWrite(FileOutputStream stream) throws IOException {
    stream.close(); Files.move(pending.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
  }
  public void failWrite(FileOutputStream stream) {
    try { if (stream != null) stream.close(); } catch (IOException ignored) { }
    pending.delete();
  }
}
''',
    'android/webkit/WebResourceResponse.java': '''
package android.webkit;
import java.io.InputStream;
import java.util.Map;
public class WebResourceResponse {
  public final String type, encoding, reason;
  public final int status;
  public Map<String, String> headers;
  public final InputStream body;
  public WebResourceResponse(String type, String encoding, int status, String reason,
      Map<String, String> headers, InputStream body) {
    this.type = type; this.encoding = encoding; this.status = status;
    this.reason = reason; this.headers = headers; this.body = body;
  }
  public Map<String, String> getResponseHeaders() { return headers; }
  public void setResponseHeaders(Map<String, String> headers) { this.headers = headers; }
}
''',
    'org/json/JSONException.java': '''
package org.json;
public class JSONException extends Exception {
  public JSONException(String message) { super(message); }
}
''',
    'org/json/JSONObject.java': '''
package org.json;
import com.google.gson.*;
public class JSONObject {
  private final JsonObject value;
  public static final Object NULL = null;
  public JSONObject() { value = new JsonObject(); }
  public JSONObject put(String key, Object content) throws JSONException {
    value.add(key, content instanceof JSONObject || content instanceof JSONArray ? JsonParser.parseString(content.toString()) : new Gson().toJsonTree(content)); return this;
  }
  public String toString() { return value.toString(); }
  public static String quote(String value) { return new Gson().toJson(value); }
  public JSONObject(String text) throws JSONException {
    try { value = JsonParser.parseString(text).getAsJsonObject(); }
    catch (RuntimeException e) { throw new JSONException("Invalid JSON"); }
  }
  public JSONObject(JsonObject value) { this.value = value; }
  private JsonElement element(String key) throws JSONException {
    if (isNull(key)) throw new JSONException("Missing value");
    return value.get(key);
  }
  public Object get(String key) throws JSONException {
    JsonElement found = element(key);
    if (found.isJsonObject()) return new JSONObject(found.getAsJsonObject());
    if (found.isJsonArray()) return new JSONArray(found.getAsJsonArray());
    JsonPrimitive primitive = found.getAsJsonPrimitive();
    if (primitive.isNumber()) return primitive.getAsNumber();
    if (primitive.isBoolean()) return primitive.getAsBoolean();
    return primitive.getAsString();
  }
  public boolean isNull(String key) { return !value.has(key) || value.get(key).isJsonNull(); }
  public JSONObject getJSONObject(String key) throws JSONException { return new JSONObject(element(key).getAsJsonObject()); }
  public JSONArray getJSONArray(String key) throws JSONException { return new JSONArray(element(key).getAsJsonArray()); }
  public String getString(String key) throws JSONException { return element(key).getAsString(); }
  public double getDouble(String key) throws JSONException { return element(key).getAsDouble(); }
  public int getInt(String key) throws JSONException { return element(key).getAsInt(); }
  public java.util.Iterator<String> keys() { return value.keySet().iterator(); }
}
''',
    'org/json/JSONArray.java': '''
package org.json;
import com.google.gson.*;
public class JSONArray {
  private final JsonArray value;
  public JSONArray() { value = new JsonArray(); }
  public JSONArray(String text) throws JSONException {
    try { value = JsonParser.parseString(text).getAsJsonArray(); }
    catch (RuntimeException e) { throw new JSONException("Invalid array"); }
  }
  public JSONArray put(JSONObject object) { value.add(JsonParser.parseString(object.toString())); return this; }
  public JSONObject getJSONObject(int index) throws JSONException { return new JSONObject(value.get(index).toString()); }
  public String toString() { return value.toString(); }
  public JSONArray(JsonArray value) { this.value = value; }
  public int length() { return value.size(); }
  public boolean isNull(int index) { return value.get(index).isJsonNull(); }
  public double getDouble(int index) { return value.get(index).getAsDouble(); }
  public String getString(int index) { return value.get(index).getAsString(); }
}
''',
    'com/brymon68/homehq/MainActivity.java': '''
package com.brymon68.homehq;
class MainActivity { static final String BUNDLED_HOST = "appassets.androidplatform.net"; }
''',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'src/com/brymon68/homehq')
    parser.add_argument('--java-home', type=Path, default=os.environ.get('JAVA_HOME'))
    parser.add_argument('--gson-jar', type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='homehq-feed-tests-') as directory:
        root = Path(directory)
        sources = []
        for name, content in STUBS.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
            sources.append(path)
        sources += [args.source_dir / name for name in ('CalendarFeed.java', 'WeatherFeed.java', 'ClimateFeed.java', 'LightsFeed.java', 'HomeAssistantControl.java', 'CamerasFeed.java', 'CameraStream.java')]
        helper = args.source_dir / 'CachedFeed.java'
        if helper.exists():
            sources.append(helper)
        sources.append(Path(__file__).with_name('FeedTest.java'))
        sources.append(Path(__file__).with_name('ControlTest.java'))
        sources.append(Path(__file__).with_name('CameraTest.java'))
        javac = args.java_home / 'bin/javac' if args.java_home else 'javac'
        java = args.java_home / 'bin/java' if args.java_home else 'java'
        library_dir = Path(__file__).resolve().parents[1] / 'lib'
        libraries = [args.gson_jar, *(library_dir / name for name in (
            'Java-WebSocket-1.6.0.jar', 'slf4j-api-2.0.13.jar', 'slf4j-nop-2.0.13.jar'))]
        classpath = os.pathsep.join(map(str, libraries))
        subprocess.run([str(javac), '--release', '8', '-cp', classpath, '-d', str(root), *map(str, sources)], check=True)
        for test in ('FeedTest', 'ControlTest', 'CameraTest'):
            subprocess.run([str(java), '-cp', os.pathsep.join((str(root), classpath)), 'com.brymon68.homehq.' + test, str(root)], check=True)


if __name__ == '__main__':
    main()
