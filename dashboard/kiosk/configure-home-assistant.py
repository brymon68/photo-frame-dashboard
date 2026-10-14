#!/usr/bin/env python3
"""Install a private Home Assistant URL and token into a rooted kiosk's private app files.

The configuration is sent over ADB standard input, never in a command argument or log.
"""
import argparse
import json
from pathlib import Path
import re
import secrets
import subprocess
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    transport = parser.add_mutually_exclusive_group(required=True)
    transport.add_argument('--serial', help='Explicit ADB serial or Wi-Fi endpoint')
    transport.add_argument('--usb', action='store_true', help='Select the single USB device')
    parser.add_argument('--model', required=True, help='Expected model; refuse other devices')
    parser.add_argument('--url', required=True, help='Home Assistant base URL, including port')
    parser.add_argument('--token-file', type=Path, required=True, help='Private, ignored token file')
    args = parser.parse_args()
    value = args.url.rstrip('/')
    token = args.token_file.read_text().strip()
    uri = urlparse(value)
    if not (uri.scheme in ('http', 'https') and uri.hostname and not uri.username and not uri.password
            and not uri.path and not uri.query and not uri.fragment):
        parser.error('Use a Home Assistant HTTP(S) origin with no path, credentials, query or fragment')
    if not re.fullmatch(r'[A-Za-z0-9._~-]+', token) or len(token) > 8192:
        parser.error('The token file must contain one bearer token')
    payload = json.dumps({'url': value, 'token': token}).encode()
    prefix = ['adb', '-s', args.serial] if args.serial else ['adb', '-d']

    def adb(*command, data=None):
        result = subprocess.run(prefix + list(command), input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if result.returncode:
            raise RuntimeError('ADB operation failed; reconnect the selected device and confirm root access')
        return result.stdout.decode().strip()

    if adb('shell', 'getprop ro.product.model') != args.model:
        raise RuntimeError('Device model does not match; no changes made')
    package = adb('shell', 'dumpsys package com.brymon68.homehq')
    match = re.search(r'\buserId=(\d+)\b', package)
    if not match:
        raise RuntimeError('Install Home HQ before configuring Home Assistant')
    uid = match.group(1)
    temporary = '/data/local/tmp/homehq-climate-' + secrets.token_hex(8)
    destination = '/data/data/com.brymon68.homehq/files'
    try:
        adb('shell', 'umask 077; cat > ' + temporary, data=payload)
        adb('shell', "su -c 'mkdir -p " + destination + ' && cp ' + temporary + ' ' + destination + '/home-assistant.json'
            + ' && rm -f ' + destination + '/climate-devices.json'
            + ' && chown ' + uid + ':' + uid + ' ' + destination + ' ' + destination + '/home-assistant.json'
            + ' && chmod 700 ' + destination + ' && chmod 600 ' + destination + '/home-assistant.json'
            + ' && restorecon ' + destination + "/home-assistant.json'")
    finally:
        adb('shell', 'rm -f ' + temporary)
    print('Home Assistant configured privately. The dashboard will connect on its next refresh.')


if __name__ == '__main__':
    main()
