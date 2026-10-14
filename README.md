# Home HQ — Pastigio FRAME156

This repository maintains the Home HQ dashboard installed on a Pastigio FRAME156
15.6-inch frame.

The frame runs its existing Android 8.1 firmware and WebView 106. **We replaced
the default launcher with Home HQ; we did not replace Android or flash new
firmware.** The installed app is Home HQ 1.20. Repository changes are
not installed automatically.

The frame uses `com.brymon68.homehq`, signed with the owner's brymon68 key, as
its default Home app. Calendar configuration and saved app data are in place.
The current installation has not been checked through a reboot, and acceptance
checks for the native menu and floating navigation buttons remain outstanding.

The [Pastigio guide](docs/pastigio-frame156.md) records the current configuration
and access instructions. Firmware/settings captures made during initial setup
were deleted at the owner's request; no saved firmware backup is available from
that session. Routine app maintenance does not require new firmware captures.

## What this repository maintains

- `dashboard/`: Today, Calendar, Shopping, Home controls, Agents, and standby
  displays, with tests for feeds, routing, and touch gestures.
- `dashboard/kiosk/`: the Android WebView app, native calendar/weather/Home Assistant transport,
  navigation service, Mac/Linux APK build, and calendar configuration helper.
- `scripts/frame-viewer.py`: an optional read-only browser view of the frame's
  screen through an existing ADB connection.
- `docs/`: current Pastigio operation and [display-viewer instructions](docs/frame-viewer.md).

Calendar, weather, and Home Assistant climate and lighting data are live. Home
shows the configured rooms and their lights with On/Off/Unavailable
status; tap an available light to toggle it. Unassigned lights have their own section. Each climate device has a dark
tile showing its name, current temperature, mode/activity, and target. Both feeds
refresh every 30 seconds. Tap a climate card to adjust its target or mode and
press Apply. Pending commands block repeat taps; failed commands refresh state
and show a message. Home displays only live room lights and climate; its
summary strip and demo camera/media panels have been removed. Agent usage and hidden demo alerts remain
sample data. Browser previews retain the sample calendar and show a connection prompt
for Home Assistant when no native feed is available.

Other-device setup scripts, firmware experiments, recovery workflows, community
catalogs, and obsolete installation logs are retired from this fork. The active
dashboard still keeps offline feed caches, gesture cancellation, and user-facing
Undo actions.

## Develop and check

Use a Node.js version supported by the locked Vite release. From the repository:

```sh
cd dashboard
npm ci
npm test
npm run dev
```

`npm run build` produces the web bundle; `npm run preview` serves that build
locally. Keep the Chromium 106 JavaScript target and existing CSS target in
`dashboard/vite.config.js`: both reflect the frame's tested WebView behavior.

From the repository root, the screen viewer's isolated tests run with:

```sh
python3 scripts/test-frame-viewer.py
```

The [kiosk guide](dashboard/kiosk/README.md) covers native feed tests, offline
packaging, signing, and app updates. The installed package includes additional
offline assets and uses the real device clock; a plain browser build is not a
complete replacement package by itself.

## Maintain the installed frame

Read the ignored `diagnostics/frame156-session/FRAME.md` before accessing this
owner's frame. Always select one ADB transport explicitly (`adb -d` for the
single USB device, or `adb -s <address>:5555` for Wi-Fi) and verify the model is
`FRAME156` before changes. Preserve the current design, drag controls, and private
calendar configuration. Use the same personal package and signing key for
future in-place updates.

Keep the current installer, brymon68 signing key, and password file privately.
Android needs the same signing identity for updates to the installed package.
Do not uninstall the working app to get around a signing mismatch.

## App identity and signing

This fork is maintained under `brymon68`. The package identifier and signing
certificate are separate parts of an Android app's identity:

| Property | Installed app |
| --- | --- |
| Version | 1.20 |
| Package | `com.brymon68.homehq` |
| Certificate subject | `CN=brymon68, O=Home HQ` |
| Status | Current default launcher and navigation service |

The app uses an RSA-3072 key and a random password, stored only in ignored private
files. The builder reads passwords from files rather than hardcoded values.
Future updates must use the same brymon68 key and package identifier to retain
the installed app's calendar configuration and saved data. Android
8.1 cannot use the signing-key rotation introduced in
[Android 9's APK signature scheme v3](https://source.android.com/docs/security/features/apksigning/v3).
Changing the certificate on the installed package therefore cannot be an ordinary
in-place update. See Android's
[signing considerations](https://developer.android.com/studio/publish/app-signing#considerations).

## Firmware changes

Future firmware or partition changes are outside routine dashboard maintenance:
identify the exact device, obtain approval for that work, and create and verify
a fresh backup covering the proposed changes before writing.

## Private files

`diagnostics/`, `backups/`, device captures, calendar feed addresses, signing keys,
and machine-specific connection details stay outside Git. The frame's existing
root access and old Android version make its isolated network and trusted-app
policy part of the maintained setup. Keep ADB off the public internet.
