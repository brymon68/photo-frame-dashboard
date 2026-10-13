# Home HQ — Pastigio FRAME156

This personal fork maintains the Home HQ dashboard installed on a Pastigio
FRAME156 15.6-inch frame. It is based on
[wesbos/photo-frame-dashboard](https://github.com/wesbos/photo-frame-dashboard).
The upstream project and Git history retain the original multi-device research.

The frame runs its existing Android 8.1 firmware and WebView 106. **We replaced
the default launcher with Home HQ; we did not replace Android or flash new
firmware.** The recorded installed app is Home HQ 1.12. Repository changes are
not installed automatically.

## How we got here

1. Enabled ADB through Frameo's Beta/ADB Access settings and authorized the Mac.
   The frame already supplied `su`; no root exploit or boot patch was needed.
2. Built and signed Home HQ (`com.wesbos.homehq`) with the dashboard bundled
   inside its APK, including local fonts for offline startup.
3. Enabled Home HQ's `.Home` component and made it Android's default Home app.
   Disabled Frameo and the two vendor updaters; their system files were not
   erased. Startup into Home HQ was verified after reboot.
4. Enabled Home HQ's accessibility navigation service for floating Back and
   Dashboard buttons outside the kiosk. A stationary two-finger hold opens the
   kiosk's native menu.
5. Configured the real device clock, `America/Denver` timezone, and persistent
   Wi-Fi ADB on the owner's isolated network. Connection details stay private.
6. Connected a read-only shared Google Calendar and live Albuquerque weather.
   Removed Photos and Chores, expanded the layout to fill the 1920×1080 screen,
   and set standby brightness to 5%, with Night mode from 9 PM to 6 AM.

The [Pastigio guide](docs/pastigio-frame156.md) records the current configuration
and access instructions. Firmware/settings captures made during initial setup
were deleted at the owner's request; no saved firmware backup is available from
that session. Routine app maintenance does not require new firmware captures.

## What this repository maintains

- `dashboard/`: Today, Calendar, Shopping, Home controls, Agents, and standby
  displays, with tests for feeds, routing, and touch gestures.
- `dashboard/kiosk/`: the Android WebView app, native calendar/weather transport,
  navigation service, Mac/Linux APK build, and calendar configuration helper.
- `scripts/frame-viewer.py`: an optional read-only browser view of the frame's
  screen through an existing ADB connection.
- `docs/`: current Pastigio operation and [display-viewer instructions](docs/frame-viewer.md).

Calendar and weather are live. Home controls, cameras, and agent usage remain
sample data; their existing appearance, sliders, and other interactions are
retained. Browser previews also retain the sample calendar when no private feed
is configured.

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
`FRAME156` before changes. Preserve the current design, drag controls, private
calendar configuration, and Android package identity.

Keep the existing private signing key and current known-good APK. Android needs
the same signing identity to accept an in-place update and preserve app data.
Old installer versions are not needed to build future updates. Do not uninstall
the app as a shortcut around a signing mismatch.

Future firmware or partition changes are outside routine dashboard maintenance:
identify the exact device, obtain approval for that work, and create and verify
a fresh backup covering the proposed changes before writing.

## Private files

`diagnostics/`, `backups/`, device captures, calendar feed addresses, signing keys,
and machine-specific connection details stay outside Git. The frame's existing
root access and old Android version make its isolated network and trusted-app
policy part of the maintained setup. Keep ADB off the public internet.
