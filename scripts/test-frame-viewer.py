#!/usr/bin/env python3
"""Read-only viewer checks using synthetic screen data, without a device."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
import importlib.util
from pathlib import Path
import subprocess
import threading
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('frame_viewer', Path(__file__).with_name('frame-viewer.py'))
viewer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(viewer)
PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 32


class CaptureTests(unittest.TestCase):
    def test_explicit_transport_and_shared_capture(self):
        screen = viewer.FrameScreen(['adb', '-s', 'test-device'], 'TEST')
        with patch.object(viewer.subprocess, 'run', side_effect=[
            subprocess.CompletedProcess([], 0, b'TEST\n'),
            subprocess.CompletedProcess([], 0, PNG),
        ]) as run:
            with ThreadPoolExecutor(max_workers=4) as pool:
                captures = list(pool.map(lambda _: screen.capture(), range(4)))
        self.assertTrue(all(result == captures[0] for result in captures))
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[0].args[0],
                         ['adb', '-s', 'test-device', 'shell', 'getprop', 'ro.product.model'])
        self.assertEqual(run.call_args_list[1].args[0],
                         ['adb', '-s', 'test-device', 'exec-out', 'screencap', '-p'])

    def test_model_mismatch_refuses_capture(self):
        screen = viewer.FrameScreen(['adb', '-d'], 'TEST')
        with patch.object(screen, 'adb', return_value=b'OTHER\n') as adb:
            with self.assertRaises(viewer.CaptureError):
                screen.capture()
        adb.assert_called_once_with('shell', 'getprop', 'ro.product.model')

    def test_expired_image_is_not_returned_after_disconnect(self):
        screen = viewer.FrameScreen(['adb', '-d'], 'TEST')
        with patch.object(screen, 'adb', side_effect=[b'TEST\n', PNG]):
            screen.capture()
        screen.captured_monotonic -= 3
        with patch.object(screen, 'adb', side_effect=viewer.CaptureError('Disconnected')):
            with self.assertRaises(viewer.CaptureError):
                screen.capture()

    def test_invalid_capture_and_timeout(self):
        screen = viewer.FrameScreen(['adb', '-d'], 'TEST')
        with patch.object(screen, 'adb', side_effect=[b'TEST\n', b'not a PNG']):
            with self.assertRaises(viewer.CaptureError):
                screen.capture()
        with patch.object(viewer.subprocess, 'run', side_effect=subprocess.TimeoutExpired('adb', 15)):
            with self.assertRaises(viewer.CaptureError):
                screen.capture()
        self.assertIsNone(screen.png)


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.screen = viewer.FrameScreen(['adb', '-d'], 'TEST')
        self.server = viewer.ViewerServer(('127.0.0.1', 0), self.screen, 'test-access-key')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def get(self, path, key=None):
        with closing(HTTPConnection(*self.server.server_address, timeout=5)) as connection:
            headers = {'Authorization': 'Bearer ' + key} if key else {}
            connection.request('GET', path, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()

    def test_screen_requires_key_and_never_exposes_files(self):
        with patch.object(self.screen, 'capture') as capture:
            for key in (None, 'wrong', '\u00e9'):
                self.assertEqual(self.get('/screen.png', key)[0], 401)
            self.assertEqual(self.get('/screen.png?token=test-access-key')[0], 401)
            capture.assert_not_called()
        self.assertEqual(self.get('/../../diagnostics/frame156-session/FRAME.md')[0], 404)
        status, headers, body = self.get('/')
        self.assertEqual(status, 200)
        self.assertIn(b'Frame display', body)
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])

    def test_png_response_and_capture_failure(self):
        with patch.object(self.screen, 'capture', return_value=(PNG, 123.5)):
            status, headers, body = self.get('/screen.png', 'test-access-key')
        self.assertEqual((status, body), (200, PNG))
        self.assertEqual(headers['Content-Type'], 'image/png')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['X-Captured-At'], '123.5')
        with patch.object(self.screen, 'capture', side_effect=viewer.CaptureError('Disconnected')):
            status, headers, body = self.get('/screen.png', 'test-access-key')
        self.assertEqual(status, 503)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertIn(b'Disconnected', body)


if __name__ == '__main__':
    unittest.main()
