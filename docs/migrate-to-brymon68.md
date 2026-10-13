# Migrate Home HQ to the personal signing identity

This is a migration plan, not a record of a completed device change. The frame
still runs Home HQ 1.12 as `com.wesbos.homehq`. The prepared source builds Home HQ
1.13 (version code 14) as `com.brymon68.homehq`, with the owner's new signing key.
Both apps keep the visible name **Home HQ** and the same dashboard design.

The retained 1.12 APK has a generic **Android Debug** certificate subject;
`wesbos` is its inherited package namespace, not the certificate's owner name.
The new package and signing key establish a separate app identity. Android 8.1
does not accept this new signer as an in-place update of the old package. Installing
the new package alongside it preserves the working app while migration is checked.

## Before device work

Read the ignored `diagnostics/frame156-session/FRAME.md`. Select the intended
transport explicitly throughout: `adb -d` for the single USB device, or
`adb -s '<frame-address>:5555'` for Wi-Fi. Verify `ro.product.model` is `FRAME156`
before changes. This plan requires no firmware or partition writes or captures.

Build the bundled APK using the [kiosk guide](../dashboard/kiosk/README.md).
Verify its package, version, bundled fonts/images, and signing certificate against
the retained new key before installation. Keep both private keys, their password
files, and the known-good old APK. Record fingerprints and migration results in
the private session notes, without copying passwords or calendar contents into
logs or tracked documentation.

The repo does not contain an automatic cross-package data migration tool. Prepare
and verify the selective private export/import described below before switching
the launcher. Creating an APK alone does not transfer this state.

## State to preserve

The new app receives a different Android UID and an empty private data directory.
Use the following allowlist for migration from the old package. Store any temporary
exports only in ignored private files with owner-only access.

| State | Transfer and verification |
| --- | --- |
| `files/calendar-url.txt` | Reuse the existing private URL file with `configure-calendar.py`, which now targets `com.brymon68.homehq`. If no local copy remains, export only this file privately from the old app. Never print its contents. Verify the new calendar reports configured and displays the same family events. |
| `files/calendar-feed.ics` and `files/weather-forecast.json` | Preserve the last-good native caches and their modification times so saved-data timestamps remain accurate. Use a consistent snapshot after stopping the old app; account for any pending Android `AtomicFile` backup before selecting the last-good content. Verify both feeds can show saved data with refresh unavailable. |
| `shared_prefs/kiosk.xml` | Transfer only the `url`, `nav_x`, and `nav_y` entries, preserving their types. The integers retain navigation-button placement. Confirm the startup URL still selects the bundled dashboard rather than an obsolete hosted URL. |
| WebView local storage | Export/import `hq-google-calendar-v1`, `hq-albuquerque-weather-v1`, and `hq-diag` as exact strings for `https://appassets.androidplatform.net`. Preserve an absent key as absent. These are cached events, cached weather, and the diagnostic-overlay preference. Verify the imported values privately before allowing a live refresh. |
| Android Home and accessibility selection | These are system settings, not app-private files. Select the new Home component and navigation service explicitly during cutover. |

Transfer only these app-owned items. After stopping each app for its snapshot or
restore, verify it is no longer writing. Use the destination package's actual UID,
owner-only permissions, and Android SELinux labels for restored files. Compare
file contents and timestamps privately; do not log personal calendar data. If
using a WebView debugging session for logical storage export/import, enable it
only for that work and disable it afterward. Do not copy the entire app data
directory, another app's ownership metadata, or a WebView profile wholesale.

Shopping edits, demo control values, the current route, and other transient UI
state are held in memory in this version. They already reset when the app process
restarts; this migration does not introduce persistent storage for them. Preserve
any session-only entries the owner needs before stopping the old app.

## Install and verify before cutover

1. Install `com.brymon68.homehq` alongside the old app, without uninstalling,
   clearing data, or changing the old Home selection. Launch it once if needed to
   initialize its storage, then stop it before restoring private state.
2. Complete the selective transfer above. Configure the new app's calendar with
   the helper using the existing private URL file. Keep the old app and its data
   intact throughout.
3. Launch the new app explicitly by component so the identical app labels cannot
   select the wrong one. Check all five views, offline fonts/images, family
   calendar, Albuquerque weather, date/time, and the 1920×1080 layout.
4. Check light/blind drags, lock holds, garage confirmation, and scene/shopping
   Undo. Check the two-finger menu, 5% standby brightness, wake brightness, and
   Night timing. Confirm saved events and weather remain usable offline.

For the single USB device, these are the installation and explicit-launch
commands from the repository root. The state-transfer steps above are separate;
do not treat these commands as a complete migration:

```sh
adb -d shell getprop ro.product.model
adb -d install dashboard/kiosk/build/homehq.apk
adb -d shell am start -n com.brymon68.homehq/.MainActivity
```

## Switch the launcher after verification

Enable the new Home alias and select it only after the new app and transferred
state pass the checks:

```sh
adb -d shell am start -n com.brymon68.homehq/.MainActivity --ez home true
adb -d shell cmd package set-home-activity com.brymon68.homehq/.Home
```

In Android Accessibility settings, switch from
`com.wesbos.homehq/.NavigationService` to
`com.brymon68.homehq/.NavigationService`, retaining any unrelated enabled services.
Both appear as **Home HQ navigation**. Enable the new service, disable the old one,
and confirm there is one floating navigation bar. Check that its placement was
preserved, Back works outside the app, and Dashboard opens the new package.

Verify Android resolves Home to the new component, then reboot and confirm the
new app starts with its calendar, navigation, and brightness behavior intact.
Update the private session record and public current-setup documentation only
after those device checks pass. Keep the old app installed until the owner agrees
it can be retired; do not remove its data or key as part of preparing this migration.

Future updates must retain `com.brymon68.homehq` and the same new signing key.
Use `adb install -r` for those updates after verifying the selected device; the
old app's key is not interchangeable with the new one.
