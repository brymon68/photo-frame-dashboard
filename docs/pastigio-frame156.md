# Pastigio FRAME156: current setup and operation

This fork maintains the owner's working Pastigio dashboard. The personal app was
installed and selected on 2026-10-12. It uses the frame's existing Android firmware and
shipped `su`; setup installed an app and changed launcher/package settings.
No firmware or raw partitions were rewritten.

The full-screen camera update was installed on 2026-10-17.
Home HQ 1.30 under `com.brymon68.homehq` uses the owner's brymon68 signing key.
Calendar configuration, saved settings, and feed caches are in place.

| Component | Installed setup |
| --- | --- |
| Frame | Pastigio FRAME156, Rockchip RK3326, 1920×1080 |
| Android | 8.1.0, stock FrameO.DP105F.v2026010414 firmware |
| WebView | 106.0.5249.126 |
| Dashboard | Home HQ 1.30, `com.brymon68.homehq` |
| Default Home | `com.brymon68.homehq/.Home`; reboot verification pending |
| Clock | Device time, `America/Denver` |

Frameo (`net.frameo.frame`) and the vendor updaters
`com.muxintu.app.mxota` and `android.rockchip.update.service` are disabled.
Their packages were not erased; Frameo's app data remains on the frame.
Home HQ navigation supplies floating Back and Dashboard buttons outside the app.
The selected service is `com.brymon68.homehq/.NavigationService`.

On-device checks across the installed updates covered all five views, four calendar
modes, touch dragging and cancellation, Undo,
idle dimming/wake behavior, and browser and native offline caches with recovery.
**Reboot verification and acceptance checks for the native two-finger menu and
floating navigation buttons remain outstanding.**

## Connect and identify

Read `diagnostics/frame156-session/FRAME.md` for this owner's current connection
details before device work. It is private and ignored by Git. The commands below
use placeholders, not saved addresses.

For Wi-Fi ADB:

```sh
adb connect '<frame-address>:5555'
adb -s '<frame-address>:5555' shell getprop ro.product.model
adb -s '<frame-address>:5555' shell am start -n com.brymon68.homehq/.MainActivity
```

For the single USB device:

```sh
adb -d shell getprop ro.product.model
adb -d shell am start -n com.brymon68.homehq/.MainActivity
```

The model must be `FRAME156` before making changes. Always select the transport:
USB and Wi-Fi can list the same frame twice. Network ADB is already configured
to persist across reboot. Its DHCP address can change; use the private notes for
reconnection. Keep wall power connected when removing the USB data cable.

## Daily use

- **Today, Calendar, Shopping, Home, and Agents** are the five views. The layout
  fills the display while retaining its 800px logical height and text scale.
- The packaged dashboard and local fonts load without a host server or internet.
  The Photos view and photo slideshow are absent.
- After two minutes idle, the current view remains visible with a **15% window
  backlight override by day and 5% from 9 p.m. to 5 a.m.**, using the frame’s
  local time. The level adjusts at either boundary while idle. Touch restores
  normal brightness. There is no screensaver, night screen, or automatic return
  to Today. Tabs, open panels and scroll positions
  stay in place, and feeds continue refreshing. The device's saved brightness
  setting is unchanged.
- The read-only Family calendar uses black; the work calendar shows blue **Busy**
  blocks without meeting titles or details. Today and Calendar's Today mode have
  separate labeled lanes. Week, Monday–Friday **Work Week**, and Month
  views combine sources with a color legend. The frame checks calendars every
  five minutes. Family downloads directly; work availability comes from bounded
  snapshots fetched directly from Google Calendar by a scheduled Python job on
  the computer every 15 minutes. These imports require the computer to be awake
  with Google and the frame reachable; Codex and a browser need not be running.
  The frame does not sign in to Google or independently refresh
  work availability. Imported data remains visible offline with its original
  timestamp, becomes stale after 30 minutes, and shows dates outside its coverage
  as unavailable. Status labels identify saved or unavailable sources.
  Albuquerque weather refreshes every 15 minutes in Fahrenheit/mph and retains
  saved data during outages.
- Home Assistant climate temperatures are live and refresh every 30 seconds.
  Today's Home section has separate readings for Amelie's Bedroom, Joseph's
  Bedroom, and Hallway. The sample lock status is removed. Home's Favorites row
  keeps those three rooms at the top; tap a favorite to open its temperature
  controls. Missing or stale favorites show unavailable readings and stay disabled.
  Home shows one dark tile per climate entity, with its name, current
  temperature, mode/activity, and target temperature; the column scrolls for additional devices. Missing or stale readings
  show `—`. Current and target numbers turn orange during active heating in Heat
  mode and blue during active cooling in Cool mode; idle readings stay white.
  Tap a card for target −/+ controls and supported mode buttons, then press Apply.
  Apply a mode first to load its temperature settings; heat/cool ranges have
  separate heating and cooling targets. Unavailable devices stay disabled.
- Home's rooms and light tiles use live Home Assistant areas and light states,
  refreshing every 30 seconds. Lighting switches are included; their LED
  indicators are excluded. Tap a light tile to turn it on or off. Bedroom and other
  dimmable lights use a filled tile slider: drag horizontally to choose 0–100%;
  release to apply (0% turns it off). Vertical scrolling and canceled drags send
  no command. Tiles show a brightness percentage or On,
  Off, Unavailable, or Updating… while a command is pending. Repeat taps are
  blocked during updates; failed commands show a message and refresh the state.
  Empty rooms are hidden. Lights without a Home Assistant room assignment appear
  under Unassigned.
  The Today light count uses the same feed. Home shows temperature Favorites,
  room lights, and climate; the old summary strip, sample cameras, and media are absent.
  Sample lighting scenes and bulk light actions are also absent.
- Tap **Cameras** beside Favorites to see Home Assistant camera tiles, then tap a
  tile to start full-screen live video. Back, Close, and status overlay the picture.
  Video keeps its proportions; tall doorbell feeds fill the height with side bars.
  **Doorbell** beside Cameras or inside Today’s Home
  card opens the doorbell directly. Today retains its shopping card and shows
  larger names and temperature readings for Amelie’s and Joseph’s bedrooms.
  Back returns to the camera list; Close or leaving the originating tab stops
  the stream. Only one camera streams at a time. Loading, interruption and Retry
  states distinguish a failed connection from live video. Streams are muted
  and do not use the frame's microphone or camera.
- Agents usage and the hidden demo drawer's alerts remain sample data and are
  not connected to household equipment or accounts.
- Shopping edits, demo control values, and the current view are held in memory
  and reset when the app process restarts.

Hold two fingers still for 1.5 seconds to open the native menu: launcher,
Android settings, or Reload dashboard. Outside Home HQ, use the floating Back
and Dashboard buttons; drag their dots to move them. The service is enabled in
Android **Settings → Accessibility → Home HQ navigation**.

The clock may reset after power loss while offline. Android's network time
corrected it after an online reboot; calendar date windows follow the correction.
No hardware-clock fix was installed.

## Updates and maintenance

Use the [Mac kiosk build/update guide](../dashboard/kiosk/README.md) for personal
builds. Updates must retain `com.brymon68.homehq` and its signing key. A plain
Vite build does not reproduce the installed offline font/image preparation; the
guide separates that preparation from APK packaging. Source edits alone do not
update the frame.

Use the [display viewer](frame-viewer.md) to inspect the actual screen from a
browser. It uses an explicitly selected ADB transport and does not install
anything on the frame.

Routine reconnection, inspection, and dashboard updates do not require another
firmware capture. No saved firmware backup is currently available. Any future
firmware or partition work is a separate task and
must follow the repository's identity and backup requirements. Keep signing
keys, calendar credentials, viewer links, and device identifiers in private
ignored files. Keep network ADB on the trusted LAN and install only trusted apps;
the frame's existing `su` grants root without a prompt.
