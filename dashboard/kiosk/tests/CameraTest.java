package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.*;

/** Camera discovery, credential isolation, signaling allowlists and session cleanup without sockets. */
public class CameraTest {
  static final String ORIGIN = "https://appassets.androidplatform.net";
  static final String ROOT = ORIGIN + "/dashboard/cameras/";
  static final String A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  static int checks, requests, code = 200;
  static String states = "[{\"entity_id\":\"camera.porch\",\"state\":\"idle\",\"attributes\":{\"friendly_name\":\"Porch\",\"access_token\":\"private-camera-token\",\"entity_picture\":\"/private\"}},"
      + "{\"entity_id\":\"camera.lost\",\"state\":\"unavailable\",\"attributes\":{}},{\"entity_id\":\"light.ignore\"}]";
  static String current = "{\"entity_id\":\"camera.porch\",\"state\":\"idle\"}";
  static FakeHttp lastHttp;
  static List<FakeWire> wires = new ArrayList<>();
  static boolean deferredSession, holdAuth, failAuth, unsupported;
  static CountDownLatch waitingAuth;

  static class FakeHttp extends HttpURLConnection {
    boolean disconnected;
    FakeHttp(URL url) { super(url); requests++; lastHttp = this; }
    public int getResponseCode() { return code; }
    public InputStream getInputStream() { return new ByteArrayInputStream(bytes(getURL().getPath().equals("/api/states") ? states : current)); }
    public void connect() {} public boolean usingProxy() { return false; }
    public void disconnect() { disconnected = true; }
  }
  static class FakeWire implements CameraStream.Wire {
    final URI uri; final CameraStream.Receiver receiver;
    final List<JSONObject> sent = new ArrayList<>();
    boolean closed; int subscription;
    FakeWire(URI uri, CameraStream.Receiver receiver) { this.uri = uri; this.receiver = receiver; wires.add(this); }
    public void connect() { receive("{\"type\":\"auth_required\"}"); }
    void receive(String text) { receiver.message(text); }
    public void send(String text) {
      try {
        JSONObject request = new JSONObject(text); sent.add(request);
        String type = request.getString("type");
        if (type.equals("auth")) {
          if (holdAuth) { waitingAuth.countDown(); return; }
          receive("{\"type\":\"" + (failAuth ? "auth_invalid" : "auth_ok") + "\"}"); return;
        }
        int id = request.getInt("id"); String result = "null";
        if (type.equals("camera/capabilities")) result = "{\"frontend_stream_types\":[\"" + (unsupported ? "hls" : "web_rtc") + "\"]}";
        if (type.equals("camera/webrtc/get_client_config")) result = "{\"configuration\":{\"iceServers\":[{\"urls\":[\"stun:stun.test:3478\"]}],\"private_key\":\"omit-this\"},\"dataChannel\":\"dataSendChannel\",\"token\":\"omit-this\"}";
        receive("{\"id\":" + id + ",\"type\":\"result\",\"success\":true,\"result\":" + result + "}");
        if (type.equals("camera/webrtc/offer")) {
          subscription = id;
          if (!deferredSession) session();
          event("{\"type\":\"answer\",\"answer\":\"v=0\\r\\ns=answer\\r\\n\",\"private\":\"omit-this\"}");
        }
      } catch (JSONException invalid) { throw new AssertionError(invalid); }
    }
    void session() { event("{\"type\":\"session\",\"session_id\":\"private-ha-session\"}"); }
    void event(String data) { receive("{\"id\":" + subscription + ",\"type\":\"event\",\"event\":" + data + "}"); }
    JSONObject command(String type) throws JSONException {
      for (JSONObject item : sent) if (item.getString("type").equals(type)) return item;
      return null;
    }
    public void close() { closed = true; receiver.ended(); }
  }
  static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }
  static void check(boolean condition, String message) { checks++; if (!condition) throw new AssertionError(message); }
  static String body(WebResourceResponse response) throws IOException { return new String(CamerasFeed.bounded(response.body, 1024 * 1024), StandardCharsets.UTF_8); }
  static WebResourceRequest request(String method, String route, String signal) {
    Map<String,String> headers = new HashMap<>(); headers.put("Origin", ORIGIN); headers.put("Referer", ORIGIN + "/dashboard/index.html");
    if (signal != null) headers.put("X-HomeHQ-Camera-Signal", signal);
    if (route.equals("stop")) headers.put("X-HomeHQ-Camera-Session", signal);
    return request(method, ROOT + route, headers);
  }
  static WebResourceRequest request(String method, String url, Map<String,String> headers) {
    return new WebResourceRequest() {
      public String getMethod() { return method; } public Uri getUrl() { return Uri.parse(url); }
      public Map<String,String> getRequestHeaders() { return headers; }
    };
  }
  static WebResourceResponse start(CameraStream stream, String id) { return stream.request(request("GET", "start/camera.porch?session=" + id, (String)null)); }
  static WebResourceResponse signal(CameraStream stream, String action, String id, String data) {
    return stream.request(request("POST", action + "/camera.porch?session=" + id, data));
  }
  static WebResourceResponse events(CameraStream stream, String id) { return stream.request(request("GET", "events/camera.porch?session=" + id, (String)null)); }
  static void stop(CameraStream stream, String id) { check(stream.request(request("POST", "stop", id)).status == 200, "Explicit stop accepted"); }
  static CameraStream stream(Context context) { return new CameraStream(context, FakeWire::new); }

  public static void main(String[] args) throws Exception {
    URL.setURLStreamHandlerFactory(protocol -> protocol.equals("http") || protocol.equals("https") ? new URLStreamHandler() {
      protected URLConnection openConnection(URL url) { return new FakeHttp(url); }
    } : null);
    Path files = Files.createDirectory(Paths.get(args[0], "cameras")); Context context = new Context(files.toFile());
    Path config = files.resolve("home-assistant.json");
    CamerasFeed feed = new CamerasFeed(context); Uri list = Uri.parse(ROOT + "devices.json");
    check(feed.request(list).status == 404 && requests == 0, "Unconfigured camera list is local");
    String valid = "{\"url\":\"http://ha.test:8123\",\"token\":\"test-token\"}";
    for (String bad : new String[] {"ftp://ha.test", "http://user@ha.test", "http://ha.test/path", "http://ha.test?x=y", "http://ha.test#frag", "http://ha.test:0"}) {
      Files.write(config, bytes(valid.replace("http://ha.test:8123", bad)));
      check(feed.request(list).status == 404 && requests == 0, "Invalid configuration never reaches network");
    }
    Files.write(config, bytes(valid));
    WebResourceResponse live = feed.request(list); String filtered = body(live); JSONArray cameras = new JSONArray(filtered);
    check(live.status == 200 && cameras.length() == 2, "Only camera entities discovered");
    check(cameras.getJSONObject(0).getString("name").equals("Porch") && cameras.getJSONObject(1).getString("name").equals("lost"), "Camera names/fallback");
    check(cameras.getJSONObject(0).getString("available").equals("true") && cameras.getJSONObject(1).getString("available").equals("false"), "Availability retained");
    check(!filtered.contains("private") && !filtered.contains("test-token") && !filtered.contains("light.ignore"), "Only camera display fields leave native feed");
    check(live.headers.get("Cache-Control").equals("no-store") && live.headers.get("X-Cameras-Stale").equals("false"), "Fresh metadata headers");
    check(Long.parseLong(live.headers.get("X-Cameras-Updated")) > 0, "Camera timestamp");
    check(lastHttp.disconnected && !lastHttp.getInstanceFollowRedirects() && !lastHttp.getUseCaches(), "List closes connection without redirects or HTTP cache");
    check(lastHttp.getRequestProperty("Authorization").equals("Bearer test-token"), "List credentials native only");
    for (int status : new int[] {302,401,503}) {
      code = status; WebResourceResponse stale = feed.request(list);
      check(stale.status == 200 && stale.headers.get("X-Cameras-Stale").equals("true") && body(stale).equals(filtered), "Failed list refresh retains stale names");
    }
    code = 200; String originalStates = states;
    for (String invalid : new String[] {"{}", states.replace("camera.lost", "camera.porch"), states.replace("camera.porch", "camera.porch/../other")}) {
      states = invalid; WebResourceResponse stale = feed.request(list);
      check(stale.headers.get("X-Cameras-Stale").equals("true") && body(stale).equals(filtered), "Invalid list preserves cache");
    }
    states = originalStates;
    for (String prefix : new String[] {"http://appassets.androidplatform.net", "https://evil.test", "https://appassets.androidplatform.net:444", "https://user@appassets.androidplatform.net"})
      check(feed.request(Uri.parse(prefix + "/dashboard/cameras/devices.json")) == null, "Camera feed requires bundled origin");

    CameraStream stream = stream(context); int before = requests;
    for (String target : new String[] {"light.porch", "camera.porch/other", "camera.porch%3Fprivate", "camera.porch,other"})
      check(stream.request(request("GET", "start/" + target + "?session=" + A, (String)null)).status == 400, "Strict camera entity allowlist");
    for (String query : new String[] {"", "?session=short", "?session=" + A + "&url=http://evil.test"})
      check(stream.request(request("GET", "start/camera.porch" + query, (String)null)).status == 400, "Session query allowlist");
    check(stream.request(request("POST", "start/camera.porch?session=" + A, (String)null)).status == 403, "Start method restriction");
    check(stream.request(request("GET", ROOT + "start/camera.porch?session=" + A, new HashMap<>())).status == 403, "Missing referrer rejected");
    Map<String,String> evil = new HashMap<>(); evil.put("Referer", "https://evil.test/"); evil.put("Origin", "https://evil.test");
    check(stream.request(request("GET", ROOT + "start/camera.porch?session=" + A, evil)).status == 403, "Foreign referrer rejected");
    check(stream.request(request("POST", ROOT + "stop", evil)).status == 403, "Foreign POST rejected");
    check(requests == before && wires.isEmpty(), "Rejected browser requests cause no HA traffic");

    WebResourceResponse started = start(stream, A); String client = body(started); FakeWire wire = wires.get(wires.size()-1);
    check(started.status == 200 && client.contains("stun:stun.test") && client.contains("dataSendChannel"), "Native start supplies needed ICE/data channel config");
    check(!client.contains("omit-this") && !client.contains("test-token"), "Native config filters unrelated fields");
    check(wire.uri.toString().equals("ws://ha.test:8123/api/websocket"), "Fixed configured HA websocket endpoint");
    check(wire.command("auth").getString("access_token").equals("test-token"), "Authentication only on native socket");
    check(lastHttp.getURL().getPath().equals("/api/states/camera.porch") && lastHttp.disconnected, "Fresh exact-camera validation before stream");
    check(started.headers.get("Cache-Control").equals("no-store"), "No signaling cache");
    check(start(stream, A).status == 409, "Duplicate session cannot start twice");
    check(signal(stream, "offer", A, "{\"offer\":\"bad\"}").status == 400, "Non-SDP offer rejected");
    check(signal(stream, "offer", A, "{\"offer\":\"v=0\\r\\ns=browser\\r\\n\",\"entity_id\":\"camera.other\"}").status == 200, "Valid browser offer sent");
    check(wire.command("camera/webrtc/offer").getString("entity_id").equals("camera.porch"), "Caller cannot change native camera target");
    String answer = body(events(stream, A));
    check(answer.contains("answer") && answer.contains("streaming") && !answer.contains("private-ha-session") && !answer.contains("omit-this"), "Only sanitized answer reaches browser");
    check(body(events(stream, A)).contains("\"events\":[]"), "Signaling events drain once");
    String candidate = "{\"candidate\":{\"candidate\":\"candidate:1 1 UDP 1 127.0.0.1 10000 typ host\",\"sdpMid\":\"0\",\"sdpMLineIndex\":0,\"url\":\"ignore-this\"}}";
    check(signal(stream, "candidate", A, candidate).status == 200, "Candidate accepted");
    JSONObject sentCandidate = wire.command("camera/webrtc/candidate");
    check(sentCandidate.getString("session_id").equals("private-ha-session") && !sentCandidate.toString().contains("ignore-this"), "Native session and candidate filtering");
    check(signal(stream, "candidate", A, candidate.replace("candidate:1", "http://evil")).status == 400, "Invalid ICE candidate rejected");
    check(signal(stream, "offer", A, "{\"offer\":\"v=0\"}").status == 400, "Second offer rejected");
    check(feed.request(list).status == 200 && !wire.closed, "Live stream does not block metadata refresh");
    stop(stream, A);
    check(wire.closed && wire.command("unsubscribe_events").getInt("subscription") == wire.subscription, "Explicit close releases HA subscription/socket");
    check(body(events(stream, A)).contains("closed") && start(stream, A).status == 410, "Stopped session cannot restart from delayed start");

    stream = stream(context); stop(stream, A); before = requests;
    check(start(stream, A).status == 410 && requests == before, "Stop-before-start tombstone prevents leaked setup");
    deferredSession = true; check(start(stream, B).status == 200, "New independent session allowed"); wire = wires.get(wires.size()-1);
    check(signal(stream, "offer", B, "{\"offer\":\"v=0\"}").status == 200, "Deferred HA session offer");
    check(signal(stream, "candidate", B, candidate).status == 200 && wire.command("camera/webrtc/candidate") == null, "Candidates wait for HA session event");
    wire.session(); check(wire.command("camera/webrtc/candidate") != null, "Queued candidates flushed after HA session");
    deferredSession = false;
    stream.close(); check(wire.closed && body(events(stream, B)).contains("closed"), "Activity lifecycle closes stream");

    stream = stream(context); check(start(stream,A).status == 200, "First selection starts"); FakeWire first = wires.get(wires.size()-1);
    check(start(stream,B).status == 200 && first.closed, "New selection closes previous socket");
    check(start(stream,A).status == 410, "Superseded session cannot reopen from delayed request");
    wire = wires.get(wires.size()-1); wire.receive("{bad json");
    check(wire.closed && body(events(stream,B)).contains("Camera stream unavailable"), "Malformed signaling fails closed with safe error");
    stream.close();

    for (String value : new String[] {"unavailable", "unknown"}) {
      current = "{\"entity_id\":\"camera.porch\",\"state\":\"" + value + "\"}";
      int sockets = wires.size(); CameraStream failed = stream(context);
      check(start(failed,A).status == 503 && wires.size() == sockets, "Unavailable cameras do not connect"); failed.close();
    }
    current = "{\"entity_id\":\"camera.other\",\"state\":\"idle\"}"; CameraStream mismatched = stream(context);
    check(start(mismatched,A).status == 503, "Mismatched entity response rejected"); mismatched.close();
    current = "{\"entity_id\":\"camera.porch\",\"state\":\"idle\"}";
    code = 302; CameraStream redirected = stream(context); check(start(redirected,A).status == 503 && !lastHttp.getInstanceFollowRedirects(), "Camera state redirects refused"); redirected.close(); code = 200;
    failAuth = true; CameraStream denied = stream(context); check(start(denied,A).status == 503 && wires.get(wires.size()-1).closed, "Failed auth closes native socket"); denied.close(); failAuth = false;
    unsupported = true; CameraStream legacy = stream(context); check(start(legacy,A).status == 503 && wires.get(wires.size()-1).closed, "Non-WebRTC camera fails cleanly"); legacy.close(); unsupported = false;

    holdAuth = true; waitingAuth = new CountDownLatch(1); CameraStream pending = stream(context); WebResourceResponse[] pendingResult = new WebResourceResponse[1];
    Thread worker = new Thread(() -> pendingResult[0] = start(pending,A)); worker.start();
    check(waitingAuth.await(2, TimeUnit.SECONDS), "Async setup reached authentication wait"); stop(pending,A); worker.join(2000);
    check(!worker.isAlive() && pendingResult[0].status == 503 && wires.get(wires.size()-1).closed, "Stop cancels in-flight setup promptly");
    holdAuth = false;
    Files.delete(config); before = requests; CameraStream removed = stream(context);
    check(start(removed,A).status == 503 && requests == before, "Deleted config cannot reuse credentials"); removed.close();
    check(feed.request(list).status == 404, "Removed config disables cached camera feed");
    try (java.util.stream.Stream<Path> paths = Files.list(files)) {
      check(paths.allMatch(path -> path.getFileName().toString().equals("cameras-devices.json")), "No video, tokens or signaling written to disk");
    }
    System.out.println("Native camera checks passed: " + checks);
  }
}
