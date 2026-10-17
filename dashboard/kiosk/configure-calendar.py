#!/usr/bin/env python3
"""Install an ignored Google iCal address into a rooted kiosk's private app files.

The address is sent over ADB standard input, never in a command argument or log.
"""
import argparse
import json
from pathlib import Path
import re
import secrets
import subprocess
from urllib.parse import urlparse


def valid_address(value):
    if not isinstance(value, str):
        return False
    try:
        uri = urlparse(value)
        return (uri.scheme == 'https' and uri.netloc == 'calendar.google.com'
                and uri.path.startswith('/calendar/ical/') and uri.path.endswith('.ics')
                and not uri.query and not uri.fragment
                and not re.search(r'[\s\x00-\x1f\x7f]', value)
                and len(value.encode()) <= 4096)
    except ValueError:
        return False


def clean_name(value):
    return re.sub(r'\s+', ' ', re.sub(r'[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', '', value)).strip()


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,31}', value) and value not in ('family', 'feed')


def validate_sources(sources):
    if not isinstance(sources, list) or len(sources) > 7:
        raise ValueError('Calendar source configuration must contain at most seven additional calendars')
    identifiers = set()
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError('Invalid calendar source configuration')
        identifier = source.get('id')
        name = source.get('name')
        color = source.get('color')
        if (not valid_id(identifier) or identifier in identifiers
                or not isinstance(name, str) or not 1 <= len(clean_name(name).encode('utf-16-le')) // 2 <= 40
                or not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color)
                or not valid_address(source.get('url'))):
            raise ValueError('Invalid calendar source configuration; existing calendars were preserved')
        identifiers.add(identifier)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    transport = parser.add_mutually_exclusive_group(required=True)
    transport.add_argument('--serial', help='Explicit ADB serial or Wi-Fi endpoint')
    transport.add_argument('--usb', action='store_true', help='Select the single USB device')
    parser.add_argument('--model', required=True, help='Expected model; refuse other devices')
    parser.add_argument('--url-file', type=Path, help='Private, ignored file containing the secret iCal URL; required unless removing a source')
    parser.add_argument('--id', help='Additional calendar ID, such as personal; omit to configure the existing Family calendar')
    parser.add_argument('--name', help='Display name for an additional calendar, up to 40 characters')
    parser.add_argument('--color', help='Display color for an additional calendar, such as #2D5BFF')
    parser.add_argument('--remove', action='store_true', help='Remove only the additional calendar selected by --id')
    args = parser.parse_args()
    if args.remove:
        if args.id is None or args.url_file is not None or args.name is not None or args.color is not None:
            parser.error('--remove requires --id and cannot be combined with --url-file, --name, or --color')
        value = ''
    else:
        if args.url_file is None:
            parser.error('--url-file is required unless removing an additional calendar')
        value = args.url_file.read_text().strip()
        if not valid_address(value) or '/private-' not in urlparse(value).path:
            parser.error('The file must contain one Google Calendar secret HTTPS iCal URL')
    if args.id is not None and not valid_id(args.id):
        parser.error('Calendar ID must be a lowercase slug of at most 32 characters; family and feed are reserved')
    if args.id is None and (args.name is not None or args.color is not None):
        parser.error('--name and --color require an additional calendar --id')
    name = clean_name(args.name) if args.name is not None else None
    if name is not None and not 1 <= len(name.encode('utf-16-le')) // 2 <= 40:
        parser.error('Display name must contain 1 to 40 characters')
    if args.color is not None and not re.fullmatch(r'#[0-9a-fA-F]{6}', args.color):
        parser.error('Display color must be six hexadecimal digits, such as #2D5BFF')
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
    destination = '/data/data/com.brymon68.homehq/files'
    filename = 'calendar-url.txt'
    contents = value + '\n'
    if args.id is not None:
        filename = 'calendar-sources.json'
        current = adb('shell', "su -c 'if [ -f " + destination + '/' + filename + ' ]; then cat '
                      + destination + '/' + filename + "; fi'")
        if len(current.encode()) > 40 * 1024:
            raise ValueError('Calendar source configuration exceeds its size limit; no changes made')
        sources = json.loads(current) if current else []
        validate_sources(sources)
        selected = next((source for source in sources if source['id'] == args.id), None)
        if args.remove:
            if selected is None:
                print('The selected additional calendar is already absent. No changes made.')
                return
            sources = [existing for existing in sources if existing['id'] != args.id]
        else:
            source = {
                'id': args.id,
                'name': name if name is not None else selected['name'] if selected else args.id.replace('-', ' ').title(),
                'color': (args.color if args.color is not None else selected['color'] if selected else '#2D5BFF').upper(),
                'url': value,
            }
            sources = [source if existing['id'] == args.id else existing for existing in sources]
            if selected is None:
                sources.append(source)
        validate_sources(sources)
        contents = json.dumps(sources, ensure_ascii=False, separators=(',', ':')) + '\n'
        if len(contents.encode()) > 40 * 1024:
            raise ValueError('Calendar source configuration exceeds its size limit; no changes made')
    nonce = secrets.token_hex(8)
    temporary = '/data/local/tmp/homehq-calendar-' + nonce
    pending = destination + '/.' + filename + '.' + nonce + '.new'
    try:
        adb('shell', 'umask 077; cat > ' + temporary, data=contents.encode())
        adb('shell', "su -c 'mkdir -p " + destination + ' && cp ' + temporary + ' ' + pending
            + ' && chown ' + uid + ':' + uid + ' ' + destination + ' ' + pending
            + ' && chmod 700 ' + destination + ' && chmod 600 ' + pending
            + ' && restorecon ' + pending + ' && mv -f ' + pending + ' ' + destination + '/' + filename + "'")
    finally:
        adb('shell', 'rm -f ' + temporary)
        adb('shell', "su -c 'rm -f " + pending + "'")
    print('Additional calendar removed. Reload Home HQ to update it.' if args.remove
          else 'Private calendar address configured. Reload Home HQ to connect it.')


if __name__ == '__main__':
    main()
