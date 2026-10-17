#!/usr/bin/env python3
"""Validate a busy-only connector response and atomically install it on a kiosk."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import secrets
import subprocess
import time


MAX_TIMESTAMP = 253402300799000
MAX_SIZE = 512 * 1024
DESTINATION = '/data/data/com.brymon68.homehq/files'
FILENAME = 'calendar-availability.json'


def timestamp(value):
    if isinstance(value, str):
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})', value):
            raise ValueError('Timestamps must be complete RFC3339 dates with a timezone')
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        delta = parsed.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
        value = delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000
    if type(value) is not int or not 0 <= value <= MAX_TIMESTAMP:
        raise ValueError('Timestamp is outside the supported range')
    return value


def read_json(path):
    contents = path.read_bytes()
    if len(contents) > MAX_SIZE:
        raise ValueError('Private input exceeds the size limit')
    return json.loads(contents)


def snapshot(source, response, now=None):
    if not isinstance(source, dict) or not isinstance(response, dict):
        raise ValueError('Source and response must be JSON objects')
    identifier = source.get('id')
    calendar_id = source.get('calendarId')
    name = source.get('name')
    color = source.get('color')
    if (not isinstance(identifier, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', identifier)
            or identifier in ('family', 'feed')):
        raise ValueError('Source ID must be a nonreserved lowercase slug of at most 32 characters')
    if (not isinstance(calendar_id, str) or not 1 <= len(calendar_id) <= 1024
            or re.search(r'[\s\x00-\x1f\x7f]', calendar_id)):
        raise ValueError('Source requires an exact calendarId')
    if not isinstance(name, str):
        raise ValueError('Source requires a display name')
    name = re.sub(r'\s+', ' ', re.sub(r'[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', '', name)).strip()
    if not 1 <= len(name.encode('utf-16-le')) // 2 <= 40:
        raise ValueError('Display name must contain 1 to 40 characters')
    if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        raise ValueError('Display color must be six hexadecimal digits')
    start = timestamp(response.get('timeMin'))
    end = timestamp(response.get('timeMax'))
    updated = timestamp(response.get('updated'))
    now = int(time.time() * 1000) if now is None else now
    if not start < end or end - start > 366 * 86400000:
        raise ValueError('Availability window must be positive and at most 366 days')
    if updated > now + 5 * 60000 or updated < now - 30 * 60000:
        raise ValueError('Fetch timestamp must be recent; fetch fresh availability before importing')
    calendars = response.get('calendars')
    if (not isinstance(calendars, list) or len(calendars) != 1
            or not isinstance(calendars[0], dict) or calendars[0].get('calendar_id') != calendar_id):
        raise ValueError('Response must contain only the configured calendar')
    calendar = calendars[0]
    if calendar.get('errors') not in (None, []):
        raise ValueError('Calendar lookup failed; previous availability was preserved')
    intervals = calendar.get('busy')
    if not isinstance(intervals, list) or len(intervals) > 5000:
        raise ValueError('Response must contain a busy array of at most 5000 intervals')
    busy = set()
    for interval in intervals:
        if not isinstance(interval, dict):
            raise ValueError('Invalid busy interval')
        begins = timestamp(interval.get('start'))
        ends = timestamp(interval.get('end'))
        if begins >= ends or ends <= start or begins >= end:
            raise ValueError('Busy interval is invalid or does not intersect the requested window')
        busy.add((max(start, begins), min(end, ends)))
    result = {
        'id': identifier, 'name': name, 'color': color.upper(),
        'revision': hashlib.sha256(calendar_id.encode()).hexdigest(),
        'updated': updated, 'rangeStart': start, 'rangeEnd': end,
        'busy': [{'start': begins, 'end': ends} for begins, ends in sorted(busy)],
    }
    if len(json.dumps(result).encode()) > MAX_SIZE:
        raise ValueError('Availability snapshot exceeds the size limit')
    return result


def install(value, prefix, model):
    def adb(*command, data=None):
        result = subprocess.run(prefix + list(command), input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if result.returncode:
            raise RuntimeError('ADB operation failed; reconnect the selected device and confirm root access')
        return result.stdout.decode().strip()

    if adb('shell', 'getprop ro.product.model') != model:
        raise RuntimeError('Device model does not match; no changes made')
    package = adb('shell', 'dumpsys package com.brymon68.homehq')
    uid = re.search(r'\buserId=(\d+)\b', package)
    version = re.search(r'\bversionCode=(\d+)\b', package)
    if not uid or not version or int(version.group(1)) < 30:
        raise RuntimeError('Install Home HQ 1.29 or newer before importing availability')

    def existing(filename):
        contents = adb('shell', "su -c 'if [ -f " + DESTINATION + '/' + filename + ' ]; then cat '
                       + DESTINATION + '/' + filename + "; fi'")
        if len(contents.encode()) > MAX_SIZE:
            raise ValueError('Existing calendar configuration exceeds its size limit')
        return json.loads(contents) if contents else None

    sources = existing('calendar-sources.json')
    if sources is not None and (not isinstance(sources, list) or any(not isinstance(item, dict) for item in sources)):
        raise ValueError('Existing calendar source configuration is invalid; no changes made')
    if any(item.get('id') == value['id'] for item in (sources or [])):
        raise ValueError('Availability ID conflicts with an iCal source; no changes made')
    current = existing(FILENAME)
    if current is not None:
        if not isinstance(current, dict) or type(current.get('updated')) is not int:
            raise ValueError('Existing availability configuration is invalid; no changes made')
        if current.get('revision') == value['revision'] and current['updated'] > value['updated']:
            raise ValueError('A newer snapshot is already installed; no changes made')
    contents = json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n'
    nonce = secrets.token_hex(8)
    temporary = '/data/local/tmp/homehq-availability-' + nonce
    pending = DESTINATION + '/.' + FILENAME + '.' + nonce + '.new'
    try:
        adb('shell', 'umask 077; cat > ' + temporary, data=contents.encode())
        adb('shell', "su -c 'mkdir -p " + DESTINATION + ' && cp ' + temporary + ' ' + pending
            + ' && chown ' + uid.group(1) + ':' + uid.group(1) + ' ' + pending
            + ' && chmod 600 ' + pending + ' && restorecon ' + pending
            + ' && mv -f ' + pending + ' ' + DESTINATION + '/' + FILENAME + "'")
        if existing(FILENAME) != value:
            raise RuntimeError('Availability write could not be verified')
    finally:
        adb('shell', 'rm -f ' + temporary)
        adb('shell', "su -c 'rm -f " + pending + "'")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    transport = parser.add_mutually_exclusive_group(required=True)
    transport.add_argument('--serial', help='Explicit ADB serial or Wi-Fi endpoint')
    transport.add_argument('--usb', action='store_true', help='Select the single USB device')
    parser.add_argument('--model', required=True, help='Expected model; refuse other devices')
    parser.add_argument('--source-file', type=Path, required=True, help='Private JSON with calendarId, id, name, color')
    parser.add_argument('--input-file', type=Path, required=True, help='Private JSON with timeMin, timeMax, updated, calendars')
    args = parser.parse_args()
    try:
        value = snapshot(read_json(args.source_file), read_json(args.input_file))
        install(value, ['adb', '-s', args.serial] if args.serial else ['adb', '-d'], args.model)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError):
        parser.exit(1, 'Availability import failed. Check the private input, fetch freshness, device model, app version, and ADB connection; no successful refresh was recorded.\n')
    print('Busy-only availability installed and verified. Home HQ refreshes it within five minutes.')


if __name__ == '__main__':
    main()
