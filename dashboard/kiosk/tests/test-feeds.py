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
  public final Map<String, String> headers;
  public final InputStream body;
  public WebResourceResponse(String type, String encoding, int status, String reason,
      Map<String, String> headers, InputStream body) {
    this.type = type; this.encoding = encoding; this.status = status;
    this.reason = reason; this.headers = headers; this.body = body;
  }
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
  public JSONObject(String text) throws JSONException {
    try { value = JsonParser.parseString(text).getAsJsonObject(); }
    catch (RuntimeException e) { throw new JSONException("Invalid JSON"); }
  }
  private JSONObject(JsonObject value) { this.value = value; }
  private JsonElement get(String key) throws JSONException {
    if (isNull(key)) throw new JSONException("Missing value");
    return value.get(key);
  }
  public boolean isNull(String key) { return !value.has(key) || value.get(key).isJsonNull(); }
  public JSONObject getJSONObject(String key) throws JSONException { return new JSONObject(get(key).getAsJsonObject()); }
  public JSONArray getJSONArray(String key) throws JSONException { return new JSONArray(get(key).getAsJsonArray()); }
  public String getString(String key) throws JSONException { return get(key).getAsString(); }
  public double getDouble(String key) throws JSONException { return get(key).getAsDouble(); }
}
''',
    'org/json/JSONArray.java': '''
package org.json;
import com.google.gson.JsonArray;
public class JSONArray {
  private final JsonArray value;
  public JSONArray(JsonArray value) { this.value = value; }
  public int length() { return value.size(); }
  public boolean isNull(int index) { return value.get(index).isJsonNull(); }
  public double getDouble(int index) { return value.get(index).getAsDouble(); }
}
''',
    'com/wesbos/homehq/MainActivity.java': '''
package com.wesbos.homehq;
class MainActivity { static final String BUNDLED_HOST = "appassets.androidplatform.net"; }
''',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'src/com/wesbos/homehq')
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
        sources += [args.source_dir / name for name in ('CalendarFeed.java', 'WeatherFeed.java')]
        helper = args.source_dir / 'CachedFeed.java'
        if helper.exists():
            sources.append(helper)
        sources.append(Path(__file__).with_name('FeedTest.java'))
        javac = args.java_home / 'bin/javac' if args.java_home else 'javac'
        java = args.java_home / 'bin/java' if args.java_home else 'java'
        subprocess.run([str(javac), '--release', '8', '-cp', str(args.gson_jar), '-d', str(root), *map(str, sources)], check=True)
        subprocess.run([str(java), '-cp', os.pathsep.join((str(root), str(args.gson_jar))), 'com.wesbos.homehq.FeedTest', str(root)], check=True)


if __name__ == '__main__':
    main()
