# Home HQ kiosk on the Pastigio frame

Home HQ packages the dashboard in a fullscreen Android WebView. This source
builds **Home HQ 1.14, `com.brymon68.homehq`**, signed with the owner's key and
installed as the frame's default Home app. Its navigation service is selected;
reboot verification and native-menu/navigation-button acceptance have not been
completed for the current installation. See the [current frame setup](../../docs/pastigio-frame156.md)
for operation. Building alone does not update the device or change firmware.

## Build the dashboard

Use Node/npm, JDK 17, Android SDK platform 34, and build-tools 34.0.0.
Set `JAVA_HOME` to the JDK and ensure its `bin` directory is on `PATH`.
From `dashboard/`:

```sh
npm ci
npm test
npm run build -- --base=./
```

This creates `dist/` with relative asset paths. It does **not** download local
fonts/images or enable the installed frame's real-time/offline HTML flags.

## Prepare the offline package

Perform these steps in `dist/` after each Vite build, using the existing approved
assets retained in the private workspace:

1. Copy the Archivo and Instrument Serif font files and their stylesheet into
   `dist/`, for example under `offline/fonts/`. Rewrite the stylesheet's font
   URLs to local files and replace the remote Google Fonts stylesheet link in
   `dist/index.html` with the local stylesheet. Preserve font weights, width
   ranges, and italic faces so the design stays unchanged.
2. Place the demo image assets at `dist/offline/cameras/<seed>.jpg`: include every
   camera seed in `js/data.js`, the media artwork seed, and `visitor-porch`.
   These are the existing camera/media/doorbell illustrations, not a photo
   slideshow or live camera feed.
3. Add the flags to the HTML root in `dist/index.html`:

   ```html
   <html lang="en" data-real-time data-offline-cameras>
   ```

   `data-real-time` uses the device clock. `data-offline-cameras` selects the
   packaged image paths used by the Home controls and demo alerts.
4. Check that the local font stylesheet, every referenced font, image, script,
   and stylesheet exists. Preview the prepared `dist/` with `npm run preview`;
   check all five views, fonts, and Home interactions before packaging.

Browser previews use the sample calendar; the private family calendar is
available through the bundled kiosk's native transport.

There is no automated offline-assets preparation step. Re-running `npm run build`
replaces `dist/`, so repeat preparation afterward. Keep the private calendar URL
out of `dist/`, JavaScript, and the APK.

## Build the personal APK

Use the brymon68 signing key and its private password file. Both paths must
be absolute and readable. The builder does not generate a substitute key. Keep
these files outside Git and outside `kiosk/build/`, which each build replaces.

```sh
BUNDLE_DASHBOARD=1 \
ANDROID_HOME=/absolute/path/to/android-sdk \
KIOSK_KEYSTORE=/absolute/private/path/to/brymon68.keystore \
KIOSK_KEYSTORE_PASSWORD_FILE=/absolute/private/path/to/keystore-password.txt \
bash kiosk/build.sh
```

`KIOSK_KEY_ALIAS` defaults to `homehq-brymon68`. If the key password differs
from the keystore password, set `KIOSK_KEY_PASSWORD_FILE` to its absolute private
file path; otherwise it uses `KIOSK_KEYSTORE_PASSWORD_FILE`. Passwords are read
from files rather than placed in command arguments.

The script bundles the prepared `dist/` by default, compiles the native sources,
and signs `kiosk/build/homehq.apk`. It does not contact or install to a frame.
The app opens its bundled dashboard by default. Bundled files are served inside
WebView at a local HTTPS origin, so dashboard startup needs no host server, USB
connection, or internet. Live feeds still need internet to refresh.

For a custom hosted dashboard, `BUNDLE_DASHBOARD=0` skips bundling and requires
an explicit dashboard URL. After verifying the device model, save that URL for
future starts with:

```sh
adb -d shell am start -n com.brymon68.homehq/.MainActivity --es url 'https://your-dashboard.example/'
```

A VIEW intent opens a URL once without changing the saved startup page. Use the
bundled build for this owner's frame.

A fresh installation starts with empty app storage. Configure its calendar,
navigation placement, and Android Home/accessibility settings explicitly.

## Update the installed app

Use these commands for later updates to the personal package. Select the
intended ADB transport and verify the model before
installation. For the single USB device, expect `FRAME156` from the first command:

```sh
adb -d shell getprop ro.product.model
adb -d install -r kiosk/build/homehq.apk
adb -d shell am start -n com.brymon68.homehq/.MainActivity
```

For Wi-Fi, use `adb -s '<frame-address>:5555'` in place of `adb -d` in every
command. Get the current address from the private frame notes. An in-place update
to the same package with the same signing identity retains app data and calendar
configuration; do not uninstall an app to work around a signature mismatch.

After updating, check the five views, calendar/weather status, light/blind drags,
lock holds, garage confirmation, and standby/wake brightness. Confirm Home HQ
still resolves as Home and **Home HQ navigation** remains enabled and usable
outside the app.
Do not repeat firmware captures for routine app updates.

## Navigation and standby

Hold two fingers still for 1.5 seconds to open the native launcher/settings/reload
menu. **Home HQ navigation**, enabled in Android Accessibility settings, supplies
floating Back and Dashboard buttons outside the app. Drag their dots to reposition
them. The buttons hide inside Home HQ.

The personal app's Home alias is already enabled and selected on this frame.
For a new installation, the alias starts disabled; after configuration and
verification, enable and select it with:

```sh
adb -d shell am start -n com.brymon68.homehq/.MainActivity --ez home true
adb -d shell cmd package set-home-activity com.brymon68.homehq/.Home
```

The selected navigation service is `com.brymon68.homehq/.NavigationService`.

Standby starts after 120 seconds idle: Ambient by day, Night from 21:00 to 06:00.
Both use 5% window brightness. Touch restores the device's normal brightness;
Night returns after 20 seconds idle during night hours. Existing standby switches
automatically at 21:00 and 06:00; an awake night dashboard becomes the normal
dashboard at 06:00. Schedule checks also handle device clock corrections.
Reload also restores normal brightness.
The saved system brightness is unchanged.

## Calendar and weather

The bundled kiosk downloads one Google Calendar secret iCal feed over native
HTTPS every five minutes. Events are read-only and assigned to the Family profile;
creation and calendar demo controls are hidden while connected. Native and
browser caches preserve saved events, with a timestamp/status label. Date windows
refresh at midnight and after the device clock changes.

The calendar configuration survives in-place updates of the same package.
This helper targets **`com.brymon68.homehq`**. To configure or change
its calendar, keep the secret URL in an ignored private file, then run from `dashboard/`:

```sh
python3 kiosk/configure-calendar.py --usb --model FRAME156 --url-file /private/path/calendar-url.txt
```

For Wi-Fi use `--serial '<frame-address>:5555'` instead of `--usb`. The helper
verifies the model and uses the frame's existing `su` to transfer the address over
standard input into app-private storage. It keeps the secret out of command
arguments and logs. Reload Home HQ afterward.

Weather uses the fixed public Open-Meteo endpoint for Albuquerque, with Fahrenheit
temperatures, mph wind, daily highs/lows, and seven upcoming hours. Native and
browser caches preserve the last good forecast; refresh is every 15 minutes and
on connectivity recovery. The dashboard labels saved data during outages.
Home controls, camera/media previews, scenes, and Agents usage remain demo data.

## Host checks

`npm test` covers feeds, synchronization, and Home control gestures. Native
HTTPS/cache contracts use JDK 17 and the Gson JAR included in Android command-line
tools:

```sh
python3 kiosk/tests/test-feeds.py --java-home /path/to/jdk17 --gson-jar /path/to/gson.jar
```

Native checks use temporary files, fake HTTPS connections, and small Android API
adapters. They exercise payload validation, size limits, cache reuse/fallback,
timestamps, response headers, and storage failures without contacting a frame
or a feed. `--source-dir /path/to/kiosk/src/com/brymon68/homehq` selects another
checkout for comparison.
