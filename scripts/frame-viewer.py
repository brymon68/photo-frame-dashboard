#!/usr/bin/env python3
"""View an Android frame's actual display in a browser through explicit ADB."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import subprocess
import threading
import time
from urllib.parse import urlsplit


PAGE = b'''<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frame display</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #101014; color: #eee; font: 16px system-ui, sans-serif; }
header { display: flex; align-items: center; gap: 16px; padding: 14px 20px; flex-wrap: wrap; }
h1 { font-size: 18px; margin: 0; } #status { flex: 1; color: #bbc1cc; }
button { color: inherit; background: #282832; border: 1px solid #555; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
main { display: grid; place-items: center; min-height: 70vh; }
img { display: block; max-width: 100%; max-height: calc(100vh - 85px); object-fit: contain; }
img[hidden] { display: none; } .stale { opacity: .5; }
</style>
<header><h1>Frame display</h1><span id="status" role="status">Connecting...</span>
<button id="pause" type="button">Pause</button></header>
<main><img id="screen" alt="Current frame display" hidden></main>
<script>
const token = location.hash.slice(1);
const screen = document.getElementById('screen');
const status = document.getElementById('status');
const pause = document.getElementById('pause');
let paused = false, busy = false, timer, imageURL, capturedAt;
function describe() {
  if (capturedAt) status.textContent = (paused ? 'Paused' : 'Live') + ' - captured ' + capturedAt.toLocaleTimeString();
}
async function refresh() {
  clearTimeout(timer);
  if (busy || paused || document.hidden) return;
  if (!token) { status.textContent = 'Open the full viewer link, including its access key.'; return; }
  busy = true;
  try {
    const response = await fetch('/screen.png', {
      headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: AbortSignal.timeout(35000)
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Access key expired. Open the latest viewer link.');
      throw new Error('Frame unavailable - retrying. Last image is stale.');
    }
    const nextURL = URL.createObjectURL(await response.blob());
    const nextImage = new Image();
    nextImage.src = nextURL;
    try { await nextImage.decode(); } catch (error) { URL.revokeObjectURL(nextURL); throw error; }
    const previousURL = imageURL;
    screen.src = imageURL = nextURL;
    screen.hidden = false;
    screen.classList.remove('stale');
    if (previousURL) URL.revokeObjectURL(previousURL);
    capturedAt = new Date(Number(response.headers.get('X-Captured-At')) * 1000);
    describe();
  } catch (error) {
    status.textContent = error.message;
    screen.classList.add('stale');
  } finally {
    busy = false;
    if (!paused && !document.hidden) timer = setTimeout(refresh, 2000);
  }
}
pause.addEventListener('click', () => {
  paused = !paused;
  pause.textContent = paused ? 'Resume' : 'Pause';
  if (paused) { clearTimeout(timer); describe(); } else refresh();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer); else refresh();
});
refresh();
</script></html>'''


class CaptureError(RuntimeError):
    pass


class FrameScreen:
    def __init__(self, prefix, model):
        self.prefix = prefix
        self.model = model
        self.lock = threading.Lock()
        self.png = None
        self.captured_at = 0
        self.captured_monotonic = 0

    def adb(self, *arguments):
        try:
            result = subprocess.run(self.prefix + list(arguments), capture_output=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise CaptureError('Cannot reach the selected frame; check its ADB connection.') from error
        if result.returncode:
            raise CaptureError('Cannot reach the selected frame; check its ADB connection.')
        return result.stdout

    def verify_model(self):
        if self.adb('shell', 'getprop', 'ro.product.model').decode().strip() != self.model:
            raise CaptureError('Selected frame model does not match --model; refusing capture.')

    def capture(self):
        with self.lock:
            # Multiple viewers share a capture; only capture while someone is viewing.
            if self.png is None or time.monotonic() - self.captured_monotonic >= 2:
                self.verify_model()
                png = self.adb('exec-out', 'screencap', '-p')
                if not png.startswith(b'\x89PNG\r\n\x1a\n') or len(png) < 24:
                    raise CaptureError('Frame returned an invalid screenshot.')
                self.png = png
                self.captured_at = time.time()
                self.captured_monotonic = time.monotonic()
            return self.png, self.captured_at


class ViewerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, screen, token):
        self.screen = screen
        self.token = token
        super().__init__(address, ViewerHandler)


class ViewerHandler(BaseHTTPRequestHandler):
    def log_message(self, *_arguments):
        # Avoid recording access keys, private addresses or screen contents.
        pass

    def reply(self, status, content_type, body, captured_at=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        if captured_at is not None:
            self.send_header('X-Captured-At', str(captured_at))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/':
            self.reply(200, 'text/html; charset=utf-8', PAGE)
        elif path == '/screen.png':
            authorization = self.headers.get('Authorization', '').encode('utf-8')
            expected = ('Bearer ' + self.server.token).encode('ascii')
            if not secrets.compare_digest(authorization, expected):
                self.reply(401, 'text/plain; charset=utf-8', b'Viewer access key required.\n')
                return
            try:
                png, captured_at = self.server.screen.capture()
            except CaptureError as error:
                self.reply(503, 'text/plain; charset=utf-8', (str(error) + '\n').encode())
                return
            self.reply(200, 'image/png', png, captured_at)
        else:
            self.reply(404, 'text/plain; charset=utf-8', b'Not found.\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    transport = parser.add_mutually_exclusive_group(required=True)
    transport.add_argument('--serial', help='Explicit ADB serial or Wi-Fi endpoint')
    transport.add_argument('--usb', action='store_true', help='Select the single USB device')
    parser.add_argument('--model', required=True, help='Expected model; refuse other devices')
    parser.add_argument('--bind', default='127.0.0.1', help='Host interface (default: loopback only)')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    prefix = ['adb', '-s', args.serial] if args.serial else ['adb', '-d']
    screen = FrameScreen(prefix, args.model)
    try:
        screen.verify_model()
        token = secrets.token_urlsafe(32)
        with ViewerServer((args.bind, args.port), screen, token) as server:
            host = '127.0.0.1' if args.bind == '0.0.0.0' else args.bind
            print(json.dumps({'viewer': f'http://{host}:{args.port}/#{token}',
                              'bind': args.bind, 'port': args.port}), flush=True)
            server.serve_forever()
    except (CaptureError, OSError) as error:
        parser.exit(1, str(error) + '\n')
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
