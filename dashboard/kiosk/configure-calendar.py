#!/usr/bin/env python3
"""Install an ignored Google iCal address into a rooted kiosk's private app files.

The address is sent over ADB standard input, never in a command argument or log.
"""
import argparse
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
    parser.add_argument('--url-file', type=Path, required=True, help='Private, ignored file containing the secret iCal URL')
    args = parser.parse_args()
    value = args.url_file.read_text().strip()
    uri = urlparse(value)
    if not (uri.scheme == 'https' and uri.netloc == 'calendar.google.com'
            and uri.path.startswith('/calendar/ical/') and uri.path.endswith('.ics')
            and '/private-' in uri.path and not uri.query and not uri.fragment
            and '\n' not in value and '\r' not in value and len(value.encode()) <= 4096):
        parser.error('The file must contain one Google Calendar secret HTTPS iCal URL')
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
        raise RuntimeError('Install Home HQ before configuring its calendar')
    uid = match.group(1)
    temporary = '/data/local/tmp/homehq-calendar-' + secrets.token_hex(8)
    destination = '/data/data/com.brymon68.homehq/files'
    try:
        adb('shell', 'umask 077; cat > ' + temporary, data=(value + '\n').encode())
        adb('shell', "su -c 'mkdir -p " + destination + ' && cp ' + temporary + ' ' + destination + '/calendar-url.txt'
            + ' && chown ' + uid + ':' + uid + ' ' + destination + ' ' + destination + '/calendar-url.txt'
            + ' && chmod 700 ' + destination + ' && chmod 600 ' + destination + '/calendar-url.txt'
            + ' && restorecon ' + destination + "/calendar-url.txt'")
    finally:
        adb('shell', 'rm -f ' + temporary)
    print('Private calendar address configured. Reload Home HQ to connect it.')


if __name__ == '__main__':
    main()
