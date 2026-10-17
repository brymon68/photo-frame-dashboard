# Home HQ kiosk on the Pastigio frame

Home HQ packages the dashboard in a fullscreen Android WebView. This source
builds **Home HQ 1.30, `com.brymon68.homehq`**, using the owner's signing key.
Version 1.30 is installed as the frame's default Home app.
Its navigation service is selected;
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

Browser previews use the sample calendar; private configured calendars are
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

The build runs `fetch-dependencies.py` to download and SHA-256 verify pinned
Java-WebSocket 1.6.0 and SLF4J 2.0.13 dependencies from Maven Central, plus Google's
R8/D8 8.7.18 compiler on the first build (the build-tools 34 compiler crashes on
SLF4J class metadata). Later builds reuse verified files in ignored `kiosk/lib/`. Their MIT
notices are included in the APK. Python 3 and network access are needed for the
first download.

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

After updating, check the five views, calendar/weather status, room/light states,
climate readings, scrolling, and idle dimming/wake brightness. Confirm Home HQ
still resolves as Home and **Home HQ navigation** remains enabled and usable
outside the app.
Do not repeat firmware captures for routine app updates.

## Navigation and idle dimming

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

After 120 seconds idle, the current tab stays visible at 15% window brightness
from 05:00 to 21:00, and 5% from 21:00 to 05:00 in the frame’s local time. The
level updates at either boundary even while already idle. There are no
Ambient/Night screens or idle tab changes.
Touch, keyboard input, and reload restore normal brightness. Open panels and
scroll positions remain intact; live feeds keep refreshing while dimmed.
The saved system brightness is unchanged.

## Calendar and weather

The bundled kiosk downloads configured Google Calendar secret iCal feeds over
native HTTPS every five minutes. The installed setup shows the Family feed in
black and a work-calendar availability snapshot in blue. Events are read-only,
with a separate name and color for each calendar. Today and Calendar's Today mode
show separate calendar lanes; the date-based views combine events with source
colors and a legend. **Work Week** shows Monday through Friday alongside the
existing Today, Week, and Month modes, replacing the old three-day view.
Creation and calendar demo controls are hidden while connected. Each calendar
has independent native and browser caches, so a failed refresh keeps that
calendar's saved events while other calendars continue updating. Status labels
identify unavailable or saved calendars. Date windows refresh at midnight and
after the device clock changes.

The calendar configuration survives in-place updates of the same package.
This helper targets **`com.brymon68.homehq`**. To configure or change
its calendar, keep the secret URL in an ignored private file, then run from `dashboard/`:

```sh
python3 kiosk/configure-calendar.py --usb --model FRAME156 --url-file /private/path/calendar-url.txt
```

The original address remains the Family calendar. To add another calendar, use
a stable lowercase ID and a display name, with an optional hex color:

```sh
python3 kiosk/configure-calendar.py --usb --model FRAME156 \
  --id another --name Another --color '#2D5BFF' \
  --url-file /private/path/another-calendar-url.txt
```

This adds or updates only that ID in app-private `calendar-sources.json`,
preserving the Family address and other calendars. Up to seven additional
URL calendars are supported. Secret addresses never enter web assets or status
responses. Keep all source configuration files outside Git.

To remove only an additional URL calendar, use the same transport/model options
with `--id another --remove` and omit `--url-file`, `--name`, and `--color`.
The Family calendar and other sources remain configured.

For Wi-Fi use `--serial '<frame-address>:5555'` instead of `--usb`. The helper
verifies the model and uses the frame's existing `su` to transfer the address over
standard input into app-private storage. It keeps the secret out of command
arguments and logs. Reload Home HQ afterward.

### Work-calendar availability snapshots

The work calendar uses **Busy** blocks fetched directly from Google Calendar by
the standalone Python job described below. It does not include event titles,
descriptions, attendees, or locations. The configured computer runs the job every
15 minutes through its user crontab, independently of Codex or a browser. The
computer must remain awake with Google and the frame reachable. OAuth credentials
stay on the computer; the frame reads the latest imported snapshot on its five-minute
calendar poll. A failed refresh preserves the last imported snapshot and its
original timestamp. Snapshots older than 30 minutes, or more than five minutes
ahead of the frame's clock, are marked stale. Dates outside the imported window
are shown as unavailable rather than free.

Keep the selected calendar and import data in ignored private files. For example,
`/private/source.json` contains:

```json
{"calendarId":"team@example.com","id":"work","name":"Work","color":"#2D5BFF"}
```

`/private/availability.json` contains the connector's structured free/busy result:
`timeMin` and `timeMax` bound the requested window, `calendars` contains the
response for the exact `calendarId`, and `updated` is the successful fetch time
in epoch milliseconds or full RFC3339 format with a timezone. Do not synthesize empty availability after a connector
error or missing calendar response. From `dashboard/`, import a validated result
using the selected private ADB endpoint:

```sh
python3 kiosk/configure-availability.py --serial "$FRAME_SERIAL" --model FRAME156 \
  --source-file /private/source.json --input-file /private/availability.json
```

The helper validates the selected device and response, then atomically replaces
app-private `calendar-availability.json` with owner-only permissions. It keeps
Family and URL sources intact. Availability supports one additional source with
a distinct lowercase ID, a maximum 366-day window, and at most 5,000 busy
intervals. Every interval must lie inside that window and have a later end than
start. A successful empty busy list is valid. Native status exposes only display
metadata and coverage; its generated iCal feed contains UTC **Busy** intervals
with stable opaque identifiers. The snapshot requires no frame network request
and remains readable offline.

### Standalone Google availability sync

`kiosk/sync-google-availability.py` supplies the installed standalone calendar
sync. The owner's computer runs it through a private scheduled wrapper; the
previous Codex heartbeat has been removed. A fresh checkout does not configure
credentials or scheduling automatically, and the job does not run on the frame.
For a new setup, install `google-auth`, `google-auth-oauthlib`, and
`requests` in a dedicated Python virtual environment. Add an IANA `timezone`
such as `America/Denver` to the private source JSON. Keep the source, Desktop
OAuth client configuration, and token in separate private files outside Git;
client and token files must be owned by the running user with mode `600`.

Enable Google Calendar API and configure only
`https://www.googleapis.com/auth/calendar.events.freebusy`. This scope reads
availability, not meeting details. Complete Google's production publishing
requirements before the final grant: Testing refresh tokens expire after seven
days. Current Google setup requires a valid app homepage and privacy-policy URL;
do not use placeholders or unrelated sites. See Google's
[branding requirements](https://support.google.com/cloud/answer/15549049) and
[refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

Authorize once from `dashboard/`, using the virtual environment's Python:

```sh
/private/oauth-venv/bin/python kiosk/sync-google-availability.py \
  --source-file /private/source.json --client-file /private/client.json \
  --token-file /private/token.json --serial "$FRAME_SERIAL" --model FRAME156 \
  --authorize --authorize-timeout 600
```

Open the printed authorization URL in the owner's browser. The callback binds
only to `127.0.0.1`; a browser on another computer needs a secure loopback tunnel
or authorization performed on that same computer. Do not expose the callback
listener to the LAN. Authorization uses PKCE and never contacts the frame.

Omit `--authorize` and `--authorize-timeout` for a normal sync. It uses the
previous Monday through eight Mondays after the current Monday in the source's
timezone, validates the exact successful Google result, and reuses the atomic
snapshot importer. Failures do not replace the frame's saved snapshot. Runs
sharing a token file are locked against overlap. Tokens are refreshed and saved
atomically; scheduled runs never open a browser.

Only after a direct sync succeeds, schedule the normal command every 15 minutes
with cron or a systemd timer under the existing ADB user's account. Use absolute
paths, a reliable PATH containing `adb`, and an overall runtime limit. Confirm a
scheduled run succeeds before disabling any previous scheduler. A user systemd
timer also needs lingering to survive logout. No APK update, frame restart, or
WebView debugging is required.

### Weather

Weather uses the fixed public Open-Meteo endpoint for Albuquerque, with Fahrenheit
temperatures, mph wind, daily highs/lows, and seven upcoming hours. Native and
browser caches preserve the last good forecast; refresh is every 15 minutes and
on connectivity recovery. The dashboard labels saved data during outages.
Home Assistant climate and lighting are live. Home's Favorites row provides three
room temperature shortcuts above the room lights and full climate list. The old
summary strip and demo camera/media panels are absent. Hidden demo alerts and Agents usage remain
sample data.

## Home Assistant climate (1.27)

The Home tab replaces its sample thermostat with one dark card per `climate.*`
entity, showing its friendly name and current temperature in Home Assistant's
configured units. A compact footer shows the selected mode, reported activity
(for example, `Cool · Idle`), and target temperature. Heat/cool ranges show both
targets when available. Current and target numbers turn palette orange while
heating in Heat mode and palette blue while cooling in Cool mode; idle, off,
and unavailable readings stay white. The right column scrolls when needed.
The Home section on Today shows separate readings for Amelie's Bedroom, Joseph's Bedroom,
and Hallway, with no sample lock status. Home's Favorites row shows those same
rooms in that order and stays visible while either lower column scrolls. Favorites
match exact room display names (including possessive spellings); missing or
ambiguous matches show unavailable cards without selecting another device. Tap a climate card
to adjust its target with −/+ and press Apply. Supported modes are shown as
buttons; applying a mode loads its temperature settings the next time the card
is opened. Heat/cool devices expose both targets in range mode. Bounds and step
sizes come from Home Assistant (1° steps when none is reported). Unavailable
or stale devices cannot be adjusted; an off device can still have its mode changed.

The bundled app performs an authenticated, read-only `GET /api/states` every
30 seconds. See the [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/).
Native code filters the response before passing climate display fields to WebView.
The server URL and bearer token live in app-private `home-assistant.json`; neither
is bundled into the APK, JavaScript, or browser storage. Redirects are not followed.
The last successful device list is cached privately. An unavailable device or
failed/stale refresh displays `Unavailable` and `—` instead of old readings, and retries
automatically. An empty successful response removes old cards.

After installing the signed update, configure it from an ignored private token file:

```sh
python3 kiosk/configure-home-assistant.py --usb --model FRAME156 \
  --url 'http://<home-assistant-address>:8123' --token-file /private/path/ha-token.txt
```

For Wi-Fi use `--serial '<frame-address>:5555'` instead of `--usb`. The helper
verifies the model and transfers credentials over standard input into private
app storage, with owner-only file permissions. It preserves calendar settings.
The Home tab connects on its next refresh. Plain browser previews display
“Connect Home Assistant” and never request private Home Assistant data.

## Home Assistant rooms and lights (1.27)

Home replaces the sample room/device grid and lighting scenes with the actual
Home Assistant areas and interactive light tiles. Tiles show **On**, **Off**, or
**Unavailable**; tap an available light to turn it on or off. Dimmable lights
(including Bedroom) display their brightness and support horizontal dragging
across the filled tile. Release sends one brightness command; 0% turns the light
off. Vertical scrolling, canceled gestures and lost pointer capture send no
command. Arrow keys adjust by 5%; Home/End select 0%/100%. Empty rooms are hidden.
Pending commands show **Updating…** and block repeat taps. Today's light count uses
the same live feed. Home shows temperature Favorites above rooms and climate; the
former summary strip and sample camera/media panels are removed. Only rooms with lights appear;
lights without an area appear under **Unassigned**. Scrolling is preserved across refreshes.

The native feed uses the existing private Home Assistant configuration and a
fixed, read-only `POST /api/template` every 30 seconds. It resolves room membership
with Home Assistant's `area_id(entity_id)`, which accounts for entity and device
assignments. It includes `light.*` entities and `switch.*` entities whose ID has a
`light` or `lights` word, excluding `led` indicator switches. It does not infer
rooms from device names or change assignments in Home Assistant. A light is
unassigned when neither its entity nor its device has an area; giving either
one an area in Home Assistant is reflected on the next successful refresh.
See [Home Assistant area lookup](https://www.home-assistant.io/template-functions/area_id/)
and the [REST API](https://developers.home-assistant.io/docs/api/rest/).

Only room IDs/names, light IDs/names, room membership, on/off/availability,
dimming capability and brightness percentage cross into WebView. Climate
additionally exposes its supported modes, features,
and temperature bounds/step. Credentials stay native. The last
good list is cached privately. Failed or stale refreshes retain names and show
**Unavailable**, and automatically recover; removed rooms and lights disappear
after a successful refresh. Browser previews show a connection prompt without
sample light data.

## Home controls transport (1.27)

The packaged page sends a POST to its local `/dashboard/home-assistant/command`
endpoint, with a bounded `X-HomeHQ-Command` header because WebView interception
cannot read request bodies. Native code requires the bundled Origin and rejects
other methods, origins, unsupported actions, and unrelated switch entities.
Only explicit light/switch `turn_on`/`turn_off` (including light brightness) and
climate `set_temperature` /
`set_hvac_mode` service calls are supported. The native transport re-reads the
entity immediately before writing to enforce availability, supported modes,
current mode, temperature bounds, reported step, and range order. Brightness
commands additionally require a light entity with a supported dimming color mode
and an integer percentage from 1 to 100; lighting switches remain toggles.

Commands never optimistically change displayed equipment state. The dashboard
blocks duplicate taps, refreshes after the service response, and briefly retries
reads if the device has not reported its new state. Failed or timed-out writes
show an unconfirmed-change message and are never retried automatically. A timeout
can occur after a device accepted the command; the refreshed state is authoritative.
The regular 30-second refresh continues. Opening, editing, or dismissing a climate
panel without Apply makes no service call. Browser previews remain disconnected.

## Home Assistant cameras (1.30)

The **Cameras** button beside Favorites opens a grid from Home Assistant's actual
`camera.*` entities. Tap a tile to start its WebRTC stream in a full-screen viewer.
Back, Close, and stream status sit over the video. The picture keeps its original
proportions without cropping; tall doorbell feeds use the full height with side bars.
The **Doorbell** button beside Cameras and the shortcut inside Today’s Home
card open that camera directly. Today retains its shopping card and shows larger
names and temperature readings for Amelie’s and Joseph’s bedrooms. The shortcut matches a single discovered display name of
“Doorbell” or “Doorbell Camera” and stays disabled if missing, ambiguous, stale,
or unavailable. Back returns to the list; Close, leaving the originating tab,
hiding the dashboard, or pausing the Android app releases the stream. Only one camera is connected at a time.
Playback is muted and receive-only; no microphone or camera permission is used.
The gallery does not start background streams or display sample camera photos.

Discovery refreshes every 30 seconds through the existing private Home Assistant
configuration. Cached names remain visible during an outage with disabled tiles.
Streaming uses Home Assistant's current `camera/webrtc` WebSocket signaling API.
The native bridge authenticates, validates the selected entity and capabilities,
and exchanges bounded SDP/ICE messages with the bundled page. The Home Assistant
bearer token and upstream session identifiers stay native. The WebView receives
the ICE configuration and signaling needed for its receive-only peer connection.
Camera video is not recorded or cached. Unsupported cameras show a connection
error rather than a snapshot labeled as live video.

The player reports streaming only after decoded video frames advance. A stalled
or failed connection is cleared and offers **Retry stream**. Retry is explicit;
the app does not repeatedly open failed camera sessions in the background.
Camera connectivity and the upstream integration still determine whether a
particular device can deliver video.

For cameras without a required data channel, the player first tries advertised
TCP candidates to avoid packet-loss stalls on Wi-Fi. If TCP is unavailable or
cannot connect promptly, it falls back to normal ICE negotiation. Cameras with
a required data channel retain their existing signaling path.

The frame's hardware H.264 decoder advertises a maximum picture size of
1920×1088. Taller doorbell streams need live-video resizing in Home Assistant's
camera service; the installed doorbell uses an aspect-preserving 720×990 stream.
This changes the live feed only, not recordings on the camera. The private
maintenance notes cover the service override and rollback.

## Host checks

`npm test` covers feeds, synchronization, and Home control gestures. Native
HTTP(S)/cache contracts use JDK 17 and the Gson JAR included in Android command-line
tools:

```sh
python3 kiosk/fetch-dependencies.py
python3 kiosk/tests/test-feeds.py --java-home /path/to/jdk17 --gson-jar /path/to/gson.jar
```

Native checks use temporary files, fake HTTP(S) connections, and small Android API
adapters. They exercise payload validation, size limits, cache reuse/fallback,
timestamps, response headers, and storage failures without contacting a frame
or a feed. `--source-dir /path/to/kiosk/src/com/brymon68/homehq` selects another
checkout for comparison.
