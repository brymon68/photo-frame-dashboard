# View a frame's display in a browser

`scripts/frame-viewer.py` runs on the computer connected to the frame. It uses
ADB to capture the actual Android display and serves a browser viewer plus a PNG
endpoint. It needs Python 3 and `adb`; there are no additional dependencies.

Connect ADB first, then select the transport and expected model explicitly:

```sh
python3 scripts/frame-viewer.py --serial '<frame-address>:5555' --model '<expected-model>'
# Or, for the single USB device:
python3 scripts/frame-viewer.py --usb --model '<expected-model>'
```

Open the `viewer` URL printed at startup, including the access key after `#`.
The page refreshes about every two seconds after each capture, pauses in hidden
tabs, and has a Pause/Resume button. Failed captures leave the previous image
dimmed and marked stale while the viewer retries. This is a read-only screenshot
viewer; it does not send taps, wake the display or alter the installed dashboard.
Screenshots show display pixels; they do not reproduce physical backlight dimming.

By default, only browsers on the host computer can connect. To view from another
device on the trusted local network, add `--bind '<host-LAN-address>'`, or
`--bind 0.0.0.0` and replace the URL's loopback address with the host's LAN address.
The viewer uses local HTTP, so keep it on the trusted network. Anyone with the
full link can view the screen. A new access key is generated on each restart.
Keep links and any saved screenshots in ignored private diagnostics.

The PNG endpoint is `GET /screen.png` with the header
`Authorization: Bearer <access-key-from-link>`. Responses have `Cache-Control:
no-store` and an `X-Captured-At` Unix timestamp. Missing or invalid keys return
401; capture or device-model failures return 503. Concurrent viewers share
captures for up to two seconds. Capture stops when no viewer is requesting it.

Leave this process running and keep the host awake and connected to ADB.
Stop it with Ctrl-C. Nothing is installed on the frame, and there is no new
startup service or firmware change.

Run the isolated checks with:

```sh
python3 scripts/test-frame-viewer.py
```
