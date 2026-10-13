# Pastigio FRAME156: current setup and operation

This fork maintains the owner's working Pastigio dashboard. The personal app was
installed and selected on 2026-10-12. It uses the frame's existing Android firmware and
shipped `su`; setup installed an app and changed launcher/package settings.
No firmware or raw partitions were rewritten.

Home HQ 1.14 under `com.brymon68.homehq` uses the owner's brymon68 signing key.
Calendar configuration, saved settings, and feed caches are in place.

| Component | Installed setup |
| --- | --- |
| Frame | Pastigio FRAME156, Rockchip RK3326, 1920×1080 |
| Android | 8.1.0, stock FrameO.DP105F.v2026010414 firmware |
| WebView | 106.0.5249.126 |
| Dashboard | Home HQ 1.14, `com.brymon68.homehq` |
| Default Home | `com.brymon68.homehq/.Home`; reboot verification pending |
| Clock | Device time, `America/Denver` |

Frameo (`net.frameo.frame`) and the vendor updaters
`com.muxintu.app.mxota` and `android.rockchip.update.service` are disabled.
Their packages were not erased; Frameo's app data remains on the frame.
Home HQ navigation supplies floating Back and Dashboard buttons outside the app.
The selected service is `com.brymon68.homehq/.NavigationService`.

On-device checks for this installation covered all five views, four calendar
modes, touch dragging and cancellation, Undo, lock/garage interactions,
standby/Night behavior, and browser and native offline caches with recovery.
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
- After two minutes idle, standby shows Ambient during the day and Night from
  **21:00 to 06:00**. Both use a **5% window backlight override**. A tap restores
  normal brightness; Night returns after another 20 seconds idle during night hours.
  Standby automatically switches at both schedule boundaries; an awake night
  dashboard becomes the normal dashboard at 06:00. The device's saved brightness
  setting is unchanged.
- One shared Google family calendar is read-only and refreshes every five
  minutes. Albuquerque weather refreshes every 15 minutes in Fahrenheit/mph.
  Both retain saved data during outages and label it accordingly.
- Home controls, camera/media previews, scenes, and Agents usage remain demo
  data. Light/blind dragging, lock holds, garage confirmation, and demo controls
  are retained. They are not connected to household equipment or accounts.
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
