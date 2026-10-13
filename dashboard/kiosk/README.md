# Home HQ kiosk navigation

Hold two fingers still on the dashboard for 1.5 seconds to open the native controls:

- **Open launcher** opens another installed Home app, such as Rootless Launcher.
  If none is available, it opens Android Settings.
- **Android settings** opens the device's Settings app.
- **Reload dashboard** reloads the current URL.
- **Back to dashboard** dismisses the controls.

The dashboard keeps its 800px logical height and expands its layout horizontally
on wider screens, filling a 16:9 frame without side bars. Text and controls keep
their proportions and vertical size.

The packaged dashboard dims the screen backlight to 5% in the ambient and night
standby displays. Tapping back into the dashboard restores the device's normal
brightness. Reloading also restores normal brightness; the device's saved
brightness setting stays unchanged.

After two minutes without touch, the dashboard uses the red Night standby
display from 9 PM until 6 AM, and the Ambient display during the day. Tapping
Night wakes the dashboard; after 20 seconds without touch, it returns to Night.

## Frames without Home or Back buttons

Some frame firmware omits Android's navigation bar. The two-finger gesture only
works inside Home HQ, so it cannot bring you back from another app's settings.

Enable **Home HQ navigation** in Android **Settings → Accessibility**. The
optional service adds floating **Back** and **Dashboard** buttons outside Home HQ:

- **Back** performs Android's normal Back action.
- **Dashboard** returns directly to Home HQ, keeping the current dashboard URL.
- Drag the dots to move the buttons. Their position is saved.

The buttons hide while Home HQ is active and return when you leave it. Android
keeps the service enabled across reboots. It requests no accessibility events or
screen-content access and does not require root. Disable **Home HQ navigation**
in Accessibility settings to remove the buttons.

Keep an ADB connection available while enabling the service on a frame with no
other way back. If needed, return to the kiosk with:

```sh
adb shell am start -n com.wesbos.homehq/.MainActivity
```

This service supplies navigation controls. To start the dashboard at boot,
enable Home HQ's optional Home component and make it the default launcher:

```sh
adb shell am start -n com.wesbos.homehq/.MainActivity --ez home true
adb shell cmd package set-home-activity com.wesbos.homehq/.Home
```

The Home component is disabled on installation. To undo, first select another
default Home app, then launch Home HQ with `--ez home false`.

To save a dashboard URL for later launches, including reboot:

```sh
adb shell am start -n com.wesbos.homehq/.MainActivity --es url https://your-dashboard/
```

Ordinary VIEW links open without replacing the saved startup URL. The two-finger
hold opens the controls when Home HQ is the default launcher.

## Build and install

Use JDK 17, Android build-tools 34.0.0, and platform 34. From `dashboard/`:

```sh
ANDROID_HOME=/path/to/android-sdk bash kiosk/build.sh
adb install -r kiosk/build/homehq.apk
```

The kiosk loads the existing hosted dashboard over the frame's Wi-Fi. A USB
connection is only needed for installation or diagnostics, not normal use.

## Bundle the dashboard for offline startup

Build the dashboard with relative asset paths, then include it in the APK:

```sh
npm ci
npm run build -- --base=./
BUNDLE_DASHBOARD=1 ANDROID_HOME=/path/to/android-sdk bash kiosk/build.sh
```

When `assets/dashboard/index.html` is present, the kiosk opens the packaged
dashboard by default. It serves those files from a local HTTPS origin inside
WebView; no server, USB connection, or Wi-Fi is needed for the page itself.
The usual hosted demo remains the default for builds without bundled assets.

For an offline package, cache the Google Fonts stylesheet and font files in
`dist` and replace the remote stylesheet with local references. The camera demo
can use `./offline/cameras/<seed>.jpg` with the `data-offline-cameras` HTML root
attribute; include the camera seeds from `js/data.js` plus `visitor-porch`.

Add `data-real-time` to the HTML root to use the device clock at startup instead
of the demo's 3:18 PM starting time. The demo controls can still change the time
for previews.

`KIOSK_KEYSTORE=/path/to/keystore` optionally changes the signing-key location;
keep that key private and retain it to install later app updates.

## Private, read-only Google Calendar

The bundled dashboard can subscribe to one Google Calendar secret iCal feed.
Its existing home and calendar views display real events, including recurring
appointments, modified/cancelled instances, and all-day events. Shared-calendar
events are assigned to the whole family. Calendar creation and calendar demo
controls are hidden while connected; edit events in Google Calendar.

The kiosk downloads the feed directly over HTTPS every five minutes. No hosted
service or Google account sign-in on the frame is needed. The address remains
in the app's private files, outside JavaScript and the APK. Native and browser
caches retain the last downloaded calendar; the calendar view shows its update
time and indicates when saved data is being used. Calendar dates refresh at
midnight and after network time corrects a reset boot clock. Only the bundled HTTPS origin
serves calendar data; the hosted demo stays unchanged.

On the owner's rooted frame, save the secret address in an ignored local file,
install the bundled APK with the retained signing key, then configure it from
`dashboard/` with an explicitly selected transport and expected model:

```sh
python3 kiosk/configure-calendar.py --usb --model FRAME156 --url-file /private/path/calendar-url.txt
```

Use `--serial DEVICE` instead of `--usb` for an explicitly selected Wi-Fi
transport. The helper verifies the model and transfers the address over standard
input, without placing the secret in command arguments or logs. Reload Home HQ
after configuration. Removing the app-private `files/calendar-url.txt` and
reloading returns to the sample calendar. Delete `files/calendar-feed.ics` and
clear the dashboard's `hq-google-calendar-v1` local-storage entry if also removing
cached calendar data. This helper requires the frame's existing `su`; it does
not change firmware or grant root.

Run calendar parser and synchronization checks from `dashboard/` with `npm test`.

## Live Albuquerque weather

Today and the idle clock show Open-Meteo weather for Albuquerque, NM
(35.0844, -106.6504), with Fahrenheit temperatures, wind in mph, daily highs/lows,
and seven upcoming hourly forecasts. Weather refreshes every 15 minutes and
when connectivity returns. No account, API key, location permission, or paid
subscription is needed for this personal use. Attribution links to Open-Meteo.

The bundled kiosk downloads the fixed public HTTPS endpoint through its native
transport; hosted previews call Open-Meteo directly. Native and browser caches
retain the last successful forecast across reloads and outages. The panel labels
saved data with its update date/time; a first launch without connectivity shows
weather unavailable and retries automatically. Hourly forecasts carry full dates,
so midnight does not wrap into yesterday's forecast. Photos and slideshows are
removed; the idle display keeps the clock, weather, and next appointment.

Run calendar and weather checks from `dashboard/` with `npm test`.
