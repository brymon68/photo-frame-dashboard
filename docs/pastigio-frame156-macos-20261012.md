# Pastigio FRAME156 on an Apple silicon Mac

Session started 2026-10-12. This is a second unit matching the firmware in
[the FRAME156 guide](pastigio-frame156.md). Private outputs and backups stay
in the ignored `diagnostics/` and `backups/` directories.

## Confirmed identity and connection

- Owner identified the brand as Pastigio and About model as FRAME156.
- Initial USB-C to USB-C connection produced no USB enumeration on the Mac.
- A later connection through an Anker USB hub enumerated FRAME156. The exact
  replacement cable was not confirmed by the owner.
- After reboot, macOS reported USB VID:PID `2211:0006`, differing from the
  prior unit's documented `18d1:0006`. Model, firmware, fingerprint, platform,
  eMMC size and all partition starts/sizes match the prior unit; the ADB
  backup route does not depend on a fixed USB vendor ID.
- Owner enabled Frameo's Beta Program and ADB Access, then accepted the USB
  debugging prompt. Initial ADB state was `unauthorized`; after refreshing the
  ADB connection, it became `device`. No authorization-key patch was needed.
- Google Android platform-tools 37.0.0 were installed through Homebrew.

| Field | Observed value |
| --- | --- |
| Model / device | FRAME156 |
| Platform / ABI | rk3326 / armeabi-v7a |
| Android | 8.1.0 |
| Firmware | FrameO.DP105F.v2026010414 |
| Fingerprint | rockchip/rk3326_32bit/rk3326_32bit:8.1.0/OC/145229:user/release-keys |
| Security patch | 2020-11-05 |
| Display | 1920×1080 |
| WebView | com.android.webview 106.0.5249.126 |
| Root | Shipped `su -c id` returns UID 0; ordinary ADB shell UID 2000 |
| eMMC | mmcblk2, 61,063,168 sectors |
| Userdata start | Sector 5,612,544; all partition starts/sizes match the FRAME156 guide |

At the start, `/system`, `/vendor` and `/oem` were mounted read-only. The stock
Frameo app was Home, Launcher3 was disabled, and the two vendor updater
packages were enabled. No active network route was present. The clock was in
2008, with `Europe/London` configured and automatic time enabled.
The hardware-clock class directory was empty, and `hwclock -r` failed because
no RTC device was present. Persistence of a corrected clock is unverified.
The owner subsequently set the date and time manually. Preserve those settings;
the prepared undo script does not restore the original timezone. A subsequent
read showed `America/Denver` but the date still in 2008. The owner then requested
synchronization with the Mac. That completed with `su -c 'date -u @<epoch>'`;
independent epoch readback matched the Mac within five seconds. UTC input is
necessary on this unit: plain `date @<epoch>` added the timezone offset. The
timezone stayed `America/Denver`. No hardware clock or persistence fix was made;
the clock may reset after another reboot or loss of power while offline.

## Backup and setup

**Current status:** after setup was completed, the owner explicitly requested
deletion of this session's saved backups. The firmware images, incomplete
capture, cached chunks, OEM supplements, boot areas, selected settings archive,
and backup manifests were deleted (66 files, about 1.79 GB). The directory's
absence was verified. The verification history below describes setup-time
checks; those backup files are no longer available. Connection notes, dashboard
installers, the private signing key, and undo commands remain. No additional
backups are requested for routine dashboard use.

The 4,096-byte transfer preflight passed its exact length and source SHA-256
comparison, using gzip plus base64 inside `su` to avoid CRLF corruption.

The first long capture ended early. Local inspection recovered about 2.46 GB
of the expected 2,873,622,528 raw bytes, and gzip reported a missing end marker.
The frame subsequently disappeared from both ADB and the Mac's USB tree while
the hub remained present. This is an incomplete capture, **not a verified
backup**. It is retained privately. A bounded-chunk read-only capture method
was used after the frame powered back up.

The second capture completed: **2,873,622,528 raw bytes**, saved as standard
concatenated gzip members. Every transfer chunk passed its expected byte count
and gzip checksum, and the final file passed full gzip readback/SHA-256, primary
GPT CRC checks, and a scan for 64 KiB runs of `0xCC` filler. Independent full
partition rereads matched for `uboot`, `trust`, `misc`, `resource`, `kernel`,
`boot`, `recovery`, `backup`, `security`, and the complete `system` partition.

During the subsequent `vendor` checksum, new ADB shell commands stopped
responding. USB enumeration still showed FRAME156. Refreshing the USB transport
and restarting the host ADB service did not immediately restore command access.
No vendor hash result or mismatch was received. `vendor`, `oem` and `frp`
comparisons were initially pending. The complete capture and validated chunks
were retained.
After the owner set the date and time, a new host check showed neither an ADB
device nor FRAME156 in the USB tree; the Anker hub remained visible.

After reconnecting the data cable, command access returned. `vendor` and `frp`
matched, bringing the original matching partition rereads to twelve. `oem`
differed in exactly two bytes: partition offset 1076 changed 10→11, and offset
1400 changed 41→45. Installation stopped for investigation. These offsets are
the ext4 superblock mount counter (`0x34`) and lifetime KiB written (`0x178`),
relative to the superblock at byte 1024; see the
[Linux layout reference](https://www.kernel.org/doc/html/latest/filesystems/ext4/super.html).
All other OEM bytes matched. A fresh 134,217,728-byte OEM capture matched an
independent full partition checksum, passed gzip readback, and was retained
separately as `oem-current.img.gz`. The original image remains unchanged. The
manifest records both the original difference and the verified supplemental
copy as the basis for proceeding with reversible app changes.

Both hardware boot areas were also saved and independently hashed. A live,
non-atomic archive of selected settings and Frameo app data validated with 434
entries. It excludes photographs and other apps' data. The archive command's
stderr was suppressed because `su` can mix warnings into the encoded stream;
the successful capture command returned zero.

The main capture excludes userdata, the backup GPT, hardware boot areas and RPMB;
it is not a full-device or photo backup. Cache and metadata are included in the
prefix but were not independently compared. The supplemental boot-area and
selected app/settings backups are separate from that image.

Before installation, the original launcher/package/accessibility/clock settings
were saved privately, and undo commands were prepared. No firmware or raw
partition writes are part of this setup.

The repo's sample dashboard has been built and bundled into Home HQ,
including local fonts and placeholder photos, with the kiosk as the default
Home app prepared as an opt-in setting. The signed APK is about 3.5 MB. Local
checks passed for its signature, all HTML/JS/CSS/font references and 25 demo
photos. Real calendars, weather, photographs, home controls and account usage
are not connected by this demo.

## Reversible app setup

- Installed Home HQ version 1.2. The installed APK's SHA-256 matches the retained
  signed artifact.
- Enabled its optional `.Home` alias and selected it as the default Home app;
  Android's Home resolution confirmed that selection.
- Disabled `net.frameo.frame`, preserving its app data, and disabled both
  `com.muxintu.app.mxota` and `android.rockchip.update.service`. Verified package
  states and that Frameo stopped.
- Enabled Home HQ navigation. Verified that its accessibility service connected,
  its floating buttons appeared in Android Settings, and tapping Dashboard
  returned to the kiosk.
- On the actual frame, checked all seven dashboard views, three loaded fonts,
  and visible photos. No JavaScript errors occurred. A screenshot confirmed the
  layout. The two-finger hold gesture is implemented but was not physically
  tested in this session.
- Updated the packaged dashboard to use the real device time at startup through
  the `data-real-time` HTML flag. The default hosted demo still starts at 3:18 PM.
  Repeated the view/font/photo checks after the update; the dashboard clock's
  offset from the device clock was zero. The actual screen showed the corrected
  local time. Re-enabled navigation after updating the app and verified its
  service connected again.
- Turned off temporary WebView debugging, verified its socket disappeared, and
  removed the host port forwarding.
- Rebooted to test automatic startup. The owner saw Home HQ immediately after
  boot. USB did not return until the data cable was reconnected; afterward,
  `sys.boot_completed=1`, default Home resolution, the resumed Home HQ activity,
  the disabled vendor packages, navigation service, and absence of a WebView
  debugging socket all passed. USB ADB works again. No active IP route or
  explicit ADB TCP-port property was present at the final check.

Private rollback commands are in `diagnostics/frame156-session/undo-setup.sh`.
Backups are in `backups/pastigio-frame156-20261012`. Restore through Rockchip loader
has not been tested. Keep this old Android frame on an isolated guest/IoT network
and install only trusted apps: its shipped `su` grants root without a prompt.

## Remote ADB requested by the owner

After the owner connected Wi-Fi, enabled TCP ADB with `adb -d tcpip 5555` and
connected from this Mac to the frame's Wi-Fi address. Explicitly selected the
network transport to verify the model, current date, and TCP-port property;
commands succeeded through Wi-Fi. `ro.adb.secure=1` was present before enabling
it. The Frameo app and both vendor updaters remained disabled.

Only the current ADB service setting was changed. `persist.adb.tcp.port` remains
empty; this setup does not promise network ADB after a reboot. The DHCP address
and a USB-only rollback command are saved privately in
`diagnostics/frame156-session/remote-adb.json` and `disable-remote-adb.sh`.
Keep port 5555 limited to the trusted local network; do not forward it through
the router. To disable remote access while connected over Wi-Fi, use
`adb -s <frame-ip>:5555 usb`.
