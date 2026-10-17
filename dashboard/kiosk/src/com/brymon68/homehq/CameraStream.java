package com.brymon68.homehq;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Native HA authentication and bounded WebRTC signaling. Video goes to the browser peer. */
final class CameraStream {
  private static final String ROOT = "/dashboard/cameras/";
  private static final String ORIGIN = "https://" + MainActivity.BUNDLED_HOST;
  private static final int MESSAGE_LIMIT = 256 * 1024;
  private final File config;
  private final WireFactory factory;
  private final Map<String, Long> cancelled = new LinkedHashMap<>();
  private Session active;

  interface Receiver { void message(String text); void ended(); }
  interface Wire { void connect(); void send(String text); void close(); }
  interface WireFactory { Wire create(URI uri, Receiver receiver); }

  CameraStream(Context context) { this(context, SocketWire::new); }
  CameraStream(Context context, WireFactory factory) {
    config = new File(context.getFilesDir(), "home-assistant.json"); this.factory = factory;
  }

  private static final class SocketWire extends WebSocketClient implements Wire {
    private final Receiver receiver;
    SocketWire(URI uri, Receiver receiver) {
      super(uri, new Draft_6455(Collections.emptyList(), MESSAGE_LIMIT), null, 10000);
      this.receiver = receiver;
      setConnectionLostTimeout(20);
    }
    @Override public void onOpen(ServerHandshake handshake) { }
    @Override public void onMessage(String text) { receiver.message(text); }
    @Override public void onMessage(ByteBuffer bytes) { receiver.ended(); }
    @Override public void onClose(int code, String reason, boolean remote) { receiver.ended(); }
    @Override public void onError(Exception error) { receiver.ended(); }
  }

  WebResourceResponse request(WebResourceRequest request) {
    Uri uri = request.getUrl(); String path = uri.getPath();
    if (!CamerasFeed.bundled(uri) || path == null || !path.startsWith(ROOT)
        || path.equals(ROOT + "devices.json")) return null;
    String route = path.substring(ROOT.length());
    try {
      if (route.equals("stop")) {
        if (!post(request)) return response(403, "{}");
        String id = header(request, "X-HomeHQ-Camera-Session");
        if (!sessionId(id) || uri.getQuery() != null) return response(400, "{}");
        stop(id); return response(200, "{}");
      }
      int slash = route.indexOf('/');
      if (slash < 1) return response(404, "{}");
      String action = route.substring(0, slash), entity = route.substring(slash + 1);
      String query = uri.getQuery();
      if (!CamerasFeed.cameraId(entity) || query == null || !query.matches("session=[A-Za-z0-9_-]{16,80}"))
        return response(400, "{}");
      String id = query.substring(8);
      boolean write = action.equals("offer") || action.equals("candidate");
      if (write ? !post(request) : !trustedGet(request)) return response(403, "{}");
      if (action.equals("start")) {
        Session session = new Session(id, entity), previous;
        synchronized (this) {
          pruneCancelled();
          if (cancelled.containsKey(id)) return response(410, "{}");
          if (active != null && active.id.equals(id)) return response(409, "{}");
          previous = active; active = session;
        }
        if (previous != null) stopSession(previous);
        try { return response(200, session.start().toString()); }
        catch (Exception failed) {
          if (failed instanceof InterruptedException) Thread.currentThread().interrupt();
          session.finish(true); return response(503, "{\"error\":\"Camera stream unavailable\"}");
        }
      }
      Session session;
      synchronized (this) { session = active; }
      if (session == null || !session.id.equals(id) || !session.entity.equals(entity))
        return action.equals("events") ? response(200, "{\"state\":\"closed\",\"events\":[]}") : response(410, "{}");
      session.touched = System.currentTimeMillis();
      if (action.equals("events")) return response(200, session.events().toString());
      if (!write) return response(404, "{}");
      String signal = header(request, "X-HomeHQ-Camera-Signal");
      if (signal == null || signal.length() > 128 * 1024) return response(400, "{}");
      JSONObject values = new JSONObject(signal);
      if (action.equals("offer")) session.offer(text(values, "offer", 128 * 1024));
      else session.candidate(candidate(values.getJSONObject("candidate")));
      return response(200, "{}");
    } catch (JSONException | IllegalArgumentException invalid) { return response(400, "{}"); }
    catch (IOException unavailable) { return response(503, "{\"error\":\"Camera stream unavailable\"}"); }
    catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt(); return response(503, "{\"error\":\"Camera stream unavailable\"}");
    }
  }

  private static boolean sessionId(String id) { return id != null && id.matches("[A-Za-z0-9_-]{16,80}"); }
  private static String header(WebResourceRequest request, String name) {
    for (Map.Entry<String, String> entry : request.getRequestHeaders().entrySet())
      if (name.equalsIgnoreCase(entry.getKey())) return entry.getValue();
    return null;
  }
  private static boolean trustedGet(WebResourceRequest request) {
    String referer = header(request, "Referer");
    if (!"GET".equals(request.getMethod()) || referer == null) return false;
    Uri source = Uri.parse(referer);
    return CamerasFeed.bundled(source) && source.getPath() != null && source.getPath().startsWith("/dashboard/");
  }
  private static boolean post(WebResourceRequest request) {
    return "POST".equals(request.getMethod()) && ORIGIN.equals(header(request, "Origin"));
  }
  private synchronized void pruneCancelled() {
    long now = System.currentTimeMillis();
    cancelled.entrySet().removeIf(entry -> now - entry.getValue() > 120000);
    while (cancelled.size() > 64) cancelled.remove(cancelled.keySet().iterator().next());
  }
  private void stop(String id) {
    Session session = null;
    synchronized (this) {
      cancelled.put(id, System.currentTimeMillis()); pruneCancelled();
      if (active != null && active.id.equals(id)) { session = active; active = null; }
    }
    if (session != null) session.finish(false);
  }
  /** Reusable after resume; cancels setup, signaling, and the HA media subscription. */
  void close() {
    Session session;
    synchronized (this) { session = active; active = null; }
    if (session != null) stopSession(session);
  }
  private void stopSession(Session session) {
    synchronized (this) { cancelled.put(session.id, System.currentTimeMillis()); pruneCancelled(); }
    session.finish(false);
  }

  private final class Session implements Receiver {
    final String id, entity;
    final AtomicBoolean closed = new AtomicBoolean(), offered = new AtomicBoolean();
    final CountDownLatch authenticated = new CountDownLatch(1);
    final AtomicInteger nextId = new AtomicInteger();
    final Map<Integer, ArrayBlockingQueue<JSONObject>> calls = new ConcurrentHashMap<>();
    final Set<Integer> looseCalls = Collections.synchronizedSet(new HashSet<>());
    final ArrayBlockingQueue<JSONObject> queue = new ArrayBlockingQueue<>(64);
    final List<JSONObject> pendingCandidates = new ArrayList<>();
    volatile Wire wire;
    volatile HttpURLConnection stateConnection;
    volatile String token, haSession, state = "connecting";
    volatile int offerId;
    volatile boolean authorized, ready;
    volatile long touched = System.currentTimeMillis();
    Timer expiry;

    Session(String id, String entity) { this.id = id; this.entity = entity; }

    JSONObject start() throws Exception {
      CamerasFeed.Settings settings = CamerasFeed.load(config);
      ensureOpen();
      // Fresh entity validation prevents a stale list from opening a removed/unavailable camera.
      HttpURLConnection connection = (HttpURLConnection) new URL(settings.base + "/api/states/" + entity).openConnection();
      stateConnection = connection;
      connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
      connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
      connection.setRequestProperty("Authorization", "Bearer " + settings.token);
      connection.setRequestProperty("Accept", "application/json");
      try {
        ensureOpen();
        if (connection.getResponseCode() != 200) throw new IOException("Camera unavailable");
        try (InputStream input = connection.getInputStream()) {
          JSONObject current = new JSONObject(new String(CamerasFeed.bounded(input, 256 * 1024), StandardCharsets.UTF_8));
          String value = current.getString("state");
          if (!entity.equals(current.getString("entity_id")) || value.equals("unavailable") || value.equals("unknown"))
            throw new IOException("Camera unavailable");
        }
      } finally { connection.disconnect(); stateConnection = null; }
      ensureOpen(); token = settings.token;
      URI endpoint = URI.create(settings.base.replaceFirst("^http", "ws") + "/api/websocket");
      synchronized (this) {
        ensureOpen();
        wire = factory.create(endpoint, this);
        wire.connect();
      }
      if (!authenticated.await(10, TimeUnit.SECONDS) || !authorized) throw new IOException("Camera unavailable");
      ensureOpen();
      JSONObject capabilities = call(command("camera/capabilities"));
      JSONArray types = capabilities.getJSONArray("frontend_stream_types"); boolean supported = false;
      for (int i = 0; i < types.length(); i++) if ("web_rtc".equals(types.getString(i))) supported = true;
      if (!supported) throw new IOException("Camera streaming unsupported");
      JSONObject client = sanitizeConfig(call(command("camera/webrtc/get_client_config")));
      synchronized (this) {
        ensureOpen(); ready = true; touched = System.currentTimeMillis();
        expiry = new Timer("HomeHQ-camera-expiry", true);
        expiry.schedule(new TimerTask() {
          @Override public void run() {
            long age = System.currentTimeMillis() - touched;
            if (age < 0 || age > 30000) finish(true);
          }
        }, 5000, 5000);
      }
      return client;
    }

    private JSONObject command(String type) throws JSONException {
      return new JSONObject().put("type", type).put("entity_id", entity);
    }
    private void ensureOpen() throws IOException { if (closed.get()) throw new IOException("Camera closed"); }

    private JSONObject call(JSONObject message) throws IOException, JSONException, InterruptedException {
      return call(message, nextId.incrementAndGet());
    }
    private JSONObject call(JSONObject message, int number) throws IOException, JSONException, InterruptedException {
      ensureOpen();
      ArrayBlockingQueue<JSONObject> reply = new ArrayBlockingQueue<>(1); calls.put(number, reply);
      try {
        send(message.put("id", number));
        JSONObject result = reply.poll(10, TimeUnit.SECONDS);
        if (result == null || !"true".equals(result.getString("success"))) throw new IOException("Camera unavailable");
        return result.isNull("result") ? new JSONObject() : result.getJSONObject("result");
      } finally { calls.remove(number); }
    }
    private void send(JSONObject value) throws IOException {
      ensureOpen();
      try { wire.send(value.toString()); }
      catch (RuntimeException disconnected) { finish(true); throw new IOException("Camera unavailable"); }
    }
    void offer(String sdp) throws IOException, JSONException, InterruptedException {
      if (!ready || !sdp.startsWith("v=0") || !offered.compareAndSet(false, true)) throw new IllegalArgumentException("Invalid offer");
      offerId = nextId.incrementAndGet();
      try { call(command("camera/webrtc/offer").put("offer", sdp), offerId); }
      catch (IOException | InterruptedException failure) { finish(true); throw failure; }
    }
    synchronized void candidate(JSONObject value) throws IOException, JSONException {
      ensureOpen();
      if (!offered.get()) throw new IllegalArgumentException("Offer required");
      if (haSession == null) {
        if (pendingCandidates.size() >= 64) { finish(true); throw new IOException("Camera unavailable"); }
        pendingCandidates.add(value);
      } else sendCandidate(value);
    }
    private void sendCandidate(JSONObject value) throws IOException, JSONException {
      if (looseCalls.size() >= 64) { finish(true); throw new IOException("Camera unavailable"); }
      int number = nextId.incrementAndGet(); looseCalls.add(number);
      send(command("camera/webrtc/candidate").put("id", number).put("session_id", haSession).put("candidate", value));
    }

    @Override public void message(String text) {
      if (closed.get()) return;
      try {
        if (text.length() > MESSAGE_LIMIT) throw new IOException("Camera unavailable");
        JSONObject value = new JSONObject(text); String type = value.getString("type");
        if (type.equals("auth_required")) {
          if (token == null) throw new IOException("Camera unavailable");
          String secret = token; token = null;
          send(new JSONObject().put("type", "auth").put("access_token", secret));
        } else if (type.equals("auth_ok")) { authorized = true; authenticated.countDown(); }
        else if (type.equals("auth_invalid")) finish(true);
        else if (type.equals("result")) {
          int number = value.getInt("id"); ArrayBlockingQueue<JSONObject> reply = calls.get(number);
          if (reply != null) reply.offer(value);
          else if (looseCalls.remove(number) && !"true".equals(value.getString("success"))) finish(true);
        } else if (type.equals("event") && value.getInt("id") == offerId && offerId != 0) {
          JSONObject event = value.getJSONObject("event"); String eventType = event.getString("type");
          if (eventType.equals("session")) {
            synchronized (this) {
              haSession = text(event, "session_id", 1024);
              for (JSONObject item : pendingCandidates) sendCandidate(item);
              pendingCandidates.clear();
            }
          } else if (eventType.equals("answer")) {
            String sdp = text(event, "answer", 128 * 1024);
            if (!sdp.startsWith("v=0")) throw new IOException("Camera unavailable");
            enqueue(new JSONObject().put("type", "answer").put("answer", sdp)); state = "streaming";
          } else if (eventType.equals("candidate")) {
            enqueue(new JSONObject().put("type", "candidate").put("candidate", CameraStream.candidate(event.getJSONObject("candidate"))));
          } else if (eventType.equals("error")) finish(true);
        }
      } catch (JSONException | IOException | RuntimeException invalid) { finish(true); }
    }
    private void enqueue(JSONObject value) throws IOException {
      if (!queue.offer(value)) throw new IOException("Camera unavailable");
    }
    JSONObject events() throws JSONException {
      JSONArray events = new JSONArray(); JSONObject event;
      while ((event = queue.poll()) != null) events.put(event);
      return new JSONObject().put("state", state).put("events", events);
    }
    @Override public void ended() { finish(true); }

    void finish(boolean failed) {
      if (!closed.compareAndSet(false, true)) return;
      state = failed ? "error" : "closed"; token = null; authenticated.countDown();
      HttpURLConnection http = stateConnection; if (http != null) http.disconnect();
      synchronized (this) { if (expiry != null) expiry.cancel(); pendingCandidates.clear(); }
      try {
        JSONObject error = new JSONObject().put("success", false);
        for (ArrayBlockingQueue<JSONObject> reply : calls.values()) reply.offer(error);
        queue.clear();
        if (failed) queue.offer(new JSONObject().put("type", "error").put("message", "Camera stream unavailable"));
        Wire socket = wire;
        if (socket != null) {
          // Keep the subscription for the entire viewing session; HA releases cloud streams on close.
          if (offerId != 0 && authorized) {
            try { socket.send(new JSONObject().put("id", nextId.incrementAndGet())
                .put("type", "unsubscribe_events").put("subscription", offerId).toString()); }
            catch (RuntimeException ignored) { }
          }
          socket.close();
        }
      } catch (JSONException | RuntimeException ignored) { }
    }
  }

  private static String text(JSONObject value, String key, int limit) throws JSONException {
    String text = value.getString(key);
    if (text.isEmpty() || text.length() > limit) throw new IllegalArgumentException("Invalid signal");
    return text;
  }
  private static JSONObject candidate(JSONObject input) throws JSONException {
    String line = text(input, "candidate", 8192);
    if (!line.startsWith("candidate:")) throw new IllegalArgumentException("Invalid candidate");
    JSONObject output = new JSONObject().put("candidate", line);
    if (!input.isNull("sdpMid")) output.put("sdpMid", text(input, "sdpMid", 256));
    if (!input.isNull("sdpMLineIndex")) {
      int index = input.getInt("sdpMLineIndex");
      if (index < 0 || index > 64) throw new IllegalArgumentException("Invalid candidate");
      output.put("sdpMLineIndex", index);
    }
    if (!input.isNull("usernameFragment")) output.put("usernameFragment", text(input, "usernameFragment", 256));
    return output;
  }
  private static JSONObject sanitizeConfig(JSONObject input) throws JSONException {
    JSONObject output = new JSONObject(), configuration = input.getJSONObject("configuration");
    JSONArray servers = configuration.isNull("iceServers") ? new JSONArray() : configuration.getJSONArray("iceServers");
    if (servers.length() > 16) throw new IllegalArgumentException("Invalid ICE configuration");
    JSONArray safe = new JSONArray();
    for (int i = 0; i < servers.length(); i++) {
      JSONObject server = servers.getJSONObject(i), result = new JSONObject();
      JSONArray urls;
      try { urls = server.getJSONArray("urls"); }
      catch (JSONException stringValue) { urls = new JSONArray("[" + JSONObject.quote(server.getString("urls")) + "]"); }
      if (urls.length() > 16) throw new IllegalArgumentException("Invalid ICE configuration");
      for (int j = 0; j < urls.length(); j++) {
        String url = urls.getString(j);
        if (url.length() > 2048 || !url.matches("(?:stun|stuns|turn|turns):[^\\s]+"))
          throw new IllegalArgumentException("Invalid ICE configuration");
      }
      result.put("urls", urls);
      if (!server.isNull("username")) result.put("username", text(server, "username", 4096));
      if (!server.isNull("credential")) result.put("credential", text(server, "credential", 4096));
      safe.put(result);
    }
    output.put("configuration", new JSONObject().put("iceServers", safe));
    output.put("dataChannel", input.isNull("dataChannel") ? "" : text(input, "dataChannel", 256));
    return output;
  }
  private static WebResourceResponse response(int status, String body) {
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff");
    return new WebResourceResponse("application/json", "UTF-8", status, status == 200 ? "OK"
        : status == 400 ? "Bad Request" : status == 403 ? "Forbidden" : status == 404 ? "Not Found"
        : status == 409 ? "Conflict" : status == 410 ? "Gone" : "Service Unavailable", headers,
        new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
  }
}
