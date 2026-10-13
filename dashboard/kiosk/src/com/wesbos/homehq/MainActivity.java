package com.wesbos.homehq;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.MimeTypeMap;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Full-screen kiosk WebView for the Home HQ wall tablet.
 * - Immersive mode hides the status + navigation bars (true 1280x800).
 * - Controls: hold two fingers still on the screen for 1.5s for launcher/settings/reload.
 * - Remote debugging is OFF unless launched with the debug extra (every app on this device
 *   gets root, so the devtools socket should only exist while actively debugging):
 *     adb shell am start -n com.wesbos.homehq/.MainActivity --ez debug true
 * - Launch with a URL: adb shell am start -a android.intent.action.VIEW -d <url> -n com.wesbos.homehq/.MainActivity
 */
public class MainActivity extends Activity {
  static final String TAG = "HomeHQ";
  static final String DEFAULT_URL = "https://home-dashboard.wesbos.workers.dev/";
  static final String BUNDLED_HOST = "appassets.androidplatform.net";
  static final String BUNDLED_URL = "https://" + BUNDLED_HOST + "/dashboard/index.html";
  static final long EXIT_HOLD_MS = 1500;
  static final long RETRY_MS = 5000;
  static final float EXIT_SLOP_PX = 60;

  private WebView web;
  private CalendarFeed calendarFeed;
  private WeatherFeed weatherFeed;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final int[] exitIds = new int[2];
  private final float[] exitX = new float[2];
  private final float[] exitY = new float[2];
  private boolean exitArmed;
  private String retryUrl;

  private final Runnable retry = new Runnable() {
    @Override
    public void run() {
      if (retryUrl != null) web.loadUrl(retryUrl);
    }
  };

  private final Runnable showControls = new Runnable() {
    @Override
    public void run() {
      exitArmed = false;
      Log.i(TAG, "Two-finger hold: opening controls");
      new AlertDialog.Builder(MainActivity.this)
          .setTitle("Home HQ")
          .setItems(new String[] {"Open launcher", "Android settings", "Reload dashboard"},
              (dialog, which) -> {
                if (which == 0) openLauncher();
                else if (which == 1) startActivity(new Intent(Settings.ACTION_SETTINGS));
                else web.reload();
              })
          .setNegativeButton("Back to dashboard", null).show();
    }
  };

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    applyDebugFlag(getIntent());
    applyHomeFlag(getIntent());
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        | WindowManager.LayoutParams.FLAG_FULLSCREEN);

    web = new WebView(this);
    calendarFeed = new CalendarFeed(this);
    weatherFeed = new WeatherFeed(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setUseWideViewPort(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    web.addJavascriptInterface(new ScreenBrightness(), "HomeHQ");
    // Keep navigation inside the kiosk. When the kiosk starts at boot before Wi-Fi is up, the
    // first load fails and would stay on the error page, so retry failed main-frame loads.
    web.setWebViewClient(new WebViewClient() {
      @Override
      public void onPageStarted(WebView view, String url, Bitmap favicon) {
        // A reload or a different page starts at the owner's usual brightness.
        setStandbyBrightness(false);
      }

      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        WebResourceResponse calendar = calendarFeed.request(request.getUrl());
        if (calendar != null) return calendar;
        WebResourceResponse weather = weatherFeed.request(request.getUrl());
        if (weather != null) return weather;
        return bundledAsset(request.getUrl());
      }

      @Override
      @SuppressWarnings("deprecation")
      public void onReceivedError(WebView view, int code, String desc, String failingUrl) {
        Log.w(TAG, "Load failed (" + desc + "), retrying in " + RETRY_MS + " ms");
        retryUrl = failingUrl;
        handler.removeCallbacks(retry);
        handler.postDelayed(retry, RETRY_MS);
      }
    });
    setContentView(web);

    String url = requestedUrl(getIntent());
    web.loadUrl(url != null ? url : getSharedPreferences("kiosk", MODE_PRIVATE)
        .getString("url", defaultUrl()));
  }

  @Override
  protected void onResume() {
    super.onResume();
    NavigationService.setDashboardVisible(true);
  }

  @Override
  protected void onPause() {
    cancelExit();
    NavigationService.setDashboardVisible(false);
    super.onPause();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    applyDebugFlag(intent);
    applyHomeFlag(intent);
    String url = requestedUrl(intent);
    if (url != null) {
      handler.removeCallbacks(retry);
      web.loadUrl(url);
    }
  }

  /** Save only an explicit configuration extra; ordinary links don't change the startup page. */
  private String requestedUrl(Intent intent) {
    String url = intent.getStringExtra("url");
    if (url == null) return intent.getDataString();
    Uri uri = Uri.parse(url);
    if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) return null;
    getSharedPreferences("kiosk", MODE_PRIVATE).edit().putString("url", url).apply();
    return url;
  }

  private String defaultUrl() {
    try (InputStream ignored = getAssets().open("dashboard/index.html")) {
      return BUNDLED_URL;
    } catch (IOException absent) {
      return DEFAULT_URL;
    }
  }

  /** Only the packaged dashboard can request the fixed standby backlight level. */
  public final class ScreenBrightness {
    @JavascriptInterface
    public void setStandby(final boolean standby) {
      // JavaScript interfaces run off the UI thread; window changes must run on it.
      handler.post(() -> {
        if (web == null || web.getUrl() == null) return;
        Uri uri = Uri.parse(web.getUrl());
        if ("https".equals(uri.getScheme()) && BUNDLED_HOST.equals(uri.getHost())
            && "/dashboard/index.html".equals(uri.getPath())) {
          setStandbyBrightness(standby);
        }
      });
    }
  }

  private void setStandbyBrightness(boolean standby) {
    WindowManager.LayoutParams params = getWindow().getAttributes();
    float brightness = standby ? 0.05f : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
    if (params.screenBrightness == brightness) return;
    params.screenBrightness = brightness;
    getWindow().setAttributes(params);
  }

  /** Serve packaged files from a reserved HTTPS origin so modules work without a network. */
  private WebResourceResponse bundledAsset(Uri uri) {
    if (!"https".equals(uri.getScheme()) || !BUNDLED_HOST.equals(uri.getHost())) return null;
    String path = uri.getPath();
    if (path != null && path.startsWith("/dashboard/") && !path.contains("..")
        && !path.contains("\\")) {
      try {
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(
            MimeTypeMap.getFileExtensionFromUrl(path));
        if (path.endsWith(".js")) type = "application/javascript";
        if (type == null) type = "application/octet-stream";
        return new WebResourceResponse(type, null, getAssets().open(path.substring(1)));
      } catch (IOException absent) {
        Log.w(TAG, "Missing bundled asset: " + path);
      }
    }
    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null,
        new ByteArrayInputStream(new byte[0]));
  }

  /** Offering the kiosk as a Home app is an explicit setup choice. */
  private void applyHomeFlag(Intent intent) {
    if (!intent.hasExtra("home")) return;
    getPackageManager().setComponentEnabledSetting(new ComponentName(this, getPackageName() + ".Home"),
        intent.getBooleanExtra("home", false) ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            : PackageManager.COMPONENT_ENABLED_STATE_DEFAULT,
        PackageManager.DONT_KILL_APP);
  }

  private void openLauncher() {
    Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
    for (ResolveInfo info : getPackageManager().queryIntentActivities(home, 0)) {
      String pkg = info.activityInfo.packageName;
      if (pkg.equals(getPackageName()) || pkg.equals("com.android.settings")) continue;
      startActivity(new Intent(home).setComponent(new ComponentName(pkg, info.activityInfo.name)));
      return;
    }
    startActivity(new Intent(Settings.ACTION_SETTINGS));
  }

  @Override
  protected void onDestroy() {
    handler.removeCallbacksAndMessages(null);
    if (web != null) web.destroy();
    super.onDestroy();
  }

  /** Remote debugging only when explicitly requested; any normal launch turns it back off. */
  private void applyDebugFlag(Intent intent) {
    boolean debug = intent != null && intent.getBooleanExtra("debug", false);
    WebView.setWebContentsDebuggingEnabled(debug);
    Log.i(TAG, "WebView remote debugging " + (debug ? "ON" : "off"));
  }

  /** Watches for the two-finger exit hold; all touches still go to the page. */
  @Override
  public boolean dispatchTouchEvent(MotionEvent e) {
    switch (e.getActionMasked()) {
      case MotionEvent.ACTION_POINTER_DOWN:
        if (e.getPointerCount() == 2) {
          for (int i = 0; i < 2; i++) {
            exitIds[i] = e.getPointerId(i);
            exitX[i] = e.getX(i);
            exitY[i] = e.getY(i);
          }
          exitArmed = true;
          handler.removeCallbacks(showControls);
          handler.postDelayed(showControls, EXIT_HOLD_MS);
        } else {
          cancelExit(); // 3+ fingers
        }
        break;
      case MotionEvent.ACTION_MOVE:
        if (exitArmed) {
          for (int i = 0; i < 2; i++) {
            int idx = e.findPointerIndex(exitIds[i]);
            if (idx < 0 || Math.hypot(e.getX(idx) - exitX[i], e.getY(idx) - exitY[i]) > EXIT_SLOP_PX) {
              cancelExit();
              break;
            }
          }
        }
        break;
      case MotionEvent.ACTION_POINTER_UP:
      case MotionEvent.ACTION_UP:
      case MotionEvent.ACTION_CANCEL:
        cancelExit();
        break;
      default:
        break;
    }
    return super.dispatchTouchEvent(e);
  }

  private void cancelExit() {
    if (!exitArmed) return;
    exitArmed = false;
    handler.removeCallbacks(showControls);
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemUi();
  }

  private void hideSystemUi() {
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
  }

  @Override
  public void onBackPressed() {
    if (web.canGoBack()) web.goBack();
  }
}
