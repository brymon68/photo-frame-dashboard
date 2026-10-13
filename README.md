# Home HQ — Pastigio FRAME156

This personal fork maintains the Home HQ dashboard installed on a Pastigio
FRAME156 15.6-inch frame. It is based on
[wesbos/photo-frame-dashboard](https://github.com/wesbos/photo-frame-dashboard).
The upstream project and Git history retain the original multi-device research.

The frame runs its existing Android 8.1 firmware and WebView 106. **We replaced
the default launcher with Home HQ; we did not replace Android or flash new
firmware.** The installed app is Home HQ 1.13. Repository changes are
not installed automatically.

The frame now uses `com.brymon68.homehq`, signed with the owner's brymon68 key.
Calendar configuration and saved app data were transferred from the original
package on 2026-10-12. The old app remains installed and inactive. See the
[migration record](docs/migrate-to-brymon68.md) for the completed work and remaining
verification limits; this migration was not checked through a reboot.

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
7. Migrated to Home HQ 1.13 under `com.brymon68.homehq` with a personal signing
   key on 2026-10-12. Transferred calendar/settings/caches and selected the new
   Home and navigation service. Retained the old app with its Home alias and
   navigation service disabled. Reboot verification was not performed.

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
`FRAME156` before changes. Preserve the current design, drag controls, and private
calendar configuration. Use the same personal package and signing key for
future in-place updates.

Keep the current installer, brymon68 signing key, and password file privately.
Retain the old installer/key and inactive app until their retirement is agreed.
Android needs the same signing identity for updates to each respective package.
Do not uninstall the working app to get around a signing mismatch.

## App identity and signing

This fork is maintained under `brymon68`. The package identifier and signing
certificate are separate parts of an Android app's identity:

| | Retained original app | Installed personal app |
| --- | --- | --- |
| Version | 1.12 | 1.13 |
| Package | `com.wesbos.homehq` | `com.brymon68.homehq` |
| Certificate subject | `CN=Android Debug, O=Android, C=US` | `CN=brymon68, O=Home HQ` |
| Status | Retained inactive; Home and navigation disabled | Current default launcher and navigation service |

The existing certificate was checked against the retained installer and keystore;
it does not name Wes Bos. The personal app has a newly generated RSA-3072 key
and a random password, stored only in ignored private files. The builder reads
the passwords from files rather than hardcoded values. Retain both signing
identities while the old app is retained; future personal-app updates use the brymon68 key.

The new package has its own app storage. Calendar configuration, saved settings,
default Home selection, and the accessibility service were migrated separately. Android
8.1 cannot use the signing-key rotation introduced in
[Android 9's APK signature scheme v3](https://source.android.com/docs/security/features/apksigning/v3).
Changing the certificate on the existing package therefore cannot be an ordinary
in-place update. See Android's
[signing considerations](https://developer.android.com/studio/publish/app-signing#considerations).
The [migration guide](docs/migrate-to-brymon68.md) records the installation,
selective transfer, checks, and remaining verification limits.

## Firmware changes

Future firmware or partition changes are outside routine dashboard maintenance:
identify the exact device, obtain approval for that work, and create and verify
a fresh backup covering the proposed changes before writing.

## Private files

`diagnostics/`, `backups/`, device captures, calendar feed addresses, signing keys,
and machine-specific connection details stay outside Git. The frame's existing
root access and old Android version make its isolated network and trusted-app
policy part of the maintained setup. Keep ADB off the public internet.
