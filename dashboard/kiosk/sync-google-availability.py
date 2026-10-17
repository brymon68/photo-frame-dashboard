#!/usr/bin/env python3
"""Authorize once, or fetch Google busy times and import them without Codex.

Requires google-auth, google-auth-oauthlib, and requests for live operations.
Client and token files must be owner-only regular files with mode 600.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
from zoneinfo import ZoneInfo


SCOPE = 'https://www.googleapis.com/auth/calendar.events.freebusy'
ENDPOINT = 'https://www.googleapis.com/calendar/v3/freeBusy'
TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
HTTP_TIMEOUT = (10, 30)
MAX_SIZE = 512 * 1024


class AlreadyRunning(Exception):
    pass


class Unauthorized(Exception):
    pass


def importer_module():
    specification = importlib.util.spec_from_file_location('homehq_availability', Path(__file__).with_name('configure-availability.py'))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
        raise ValueError('Credentials must be owned by this user with mode 600')


def private_json(path):
    private_file(path)
    with path.open('rb') as stream:
        contents = stream.read(MAX_SIZE + 1)
    if len(contents) > MAX_SIZE:
        raise ValueError('Credential file exceeds size limit')
    value = json.loads(contents)
    if not isinstance(value, dict):
        raise ValueError('Invalid credential file')
    return value


def client_configuration(path):
    value = private_json(path)
    client = value.get('installed')
    if (not isinstance(client, dict) or not isinstance(client.get('client_id'), str)
            or not client['client_id'].endswith('.apps.googleusercontent.com')
            or not isinstance(client.get('client_secret'), str) or not client['client_secret']
            or client.get('auth_uri') not in ('https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/v2/auth')
            or client.get('token_uri') != TOKEN_ENDPOINT):
        raise ValueError('Expected a Google Desktop OAuth client')
    return {'installed': client}


def token_configuration(path, client):
    value = private_json(path)
    if (value.get('client_id') != client['client_id'] or value.get('client_secret') != client['client_secret']
            or value.get('token_uri') != TOKEN_ENDPOINT or value.get('scopes') != [SCOPE]
            or not isinstance(value.get('refresh_token'), str) or not value['refresh_token']):
        raise ValueError('Token must match the client and exact availability scope')
    return value


def validate_credentials(credentials):
    granted = credentials.granted_scopes
    if (not credentials.token or not credentials.refresh_token or set(credentials.scopes or []) != {SCOPE}
            or (granted is not None and set(granted) != {SCOPE})):
        raise ValueError('Authorization did not grant only the required scope')


def save_token(path, credentials):
    validate_credentials(credentials)
    if path.exists() or path.is_symlink():
        private_file(path)
    contents = credentials.to_json().encode()
    if len(contents) > MAX_SIZE:
        raise ValueError('Token exceeds size limit')
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def single_run(token_path):
    descriptor = os.open(str(token_path) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AlreadyRunning() from None
        yield
    finally:
        os.close(descriptor)


def create_flow(configuration):
    from google_auth_oauthlib.flow import InstalledAppFlow
    return InstalledAppFlow.from_client_config(configuration, scopes=[SCOPE], autogenerate_code_verifier=True)


def create_clients(token):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    import requests
    session = requests.Session()
    credentials = Credentials.from_authorized_user_info(token, scopes=[SCOPE])
    return credentials, session, Request(session=session)


def authorize(configuration, token_path, host, port, timeout):
    if host not in ('127.0.0.1', 'localhost') or not 0 <= port <= 65535 or not 30 <= timeout <= 600:
        raise ValueError('Authorization requires a bounded loopback listener')
    if token_path.exists() or token_path.is_symlink():
        private_file(token_path)
    flow = create_flow(configuration)
    original_request = flow.oauth2session.request

    def bounded_request(method, url, **options):
        options['timeout'] = HTTP_TIMEOUT
        options['allow_redirects'] = False
        return original_request(method, url, **options)

    flow.oauth2session.request = bounded_request
    try:
        credentials = flow.run_local_server(host=host, bind_addr='127.0.0.1', port=port,
                                           open_browser=False, timeout_seconds=timeout, access_type='offline',
                                           prompt='consent', authorization_prompt_message='Open this URL in your browser to authorize Home HQ:\n{url}')
        save_token(token_path, credentials)
    finally:
        flow.oauth2session.close()


def rolling_request(source, now=None):
    if not isinstance(source, dict) or not isinstance(source.get('calendarId'), str) or not source['calendarId']:
        raise ValueError('A source calendar is required')
    zone = ZoneInfo(source['timezone'])
    current = datetime.now(zone) if now is None else now.astimezone(zone)
    monday = current.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=current.weekday())
    return {'timeMin': (monday - timedelta(days=7)).isoformat(), 'timeMax': (monday + timedelta(days=56)).isoformat(),
            'timeZone': source['timezone'], 'items': [{'id': source['calendarId']}]}


def fetch_availability(session, token, query):
    with session.post(ENDPOINT, json=query, headers={'Authorization': 'Bearer ' + token},
                      timeout=HTTP_TIMEOUT, allow_redirects=False, stream=True) as response:
        if response.status_code == 401:
            raise Unauthorized()
        if response.status_code != 200:
            raise RuntimeError('Availability request failed')
        contents = bytearray()
        for chunk in response.iter_content(chunk_size=16384):
            contents.extend(chunk)
            if len(contents) > MAX_SIZE:
                raise ValueError('Availability response exceeds size limit')
    return json.loads(contents)


def prepare_snapshot(importer, source, query, response, updated):
    calendar_id = source['calendarId']
    if (not isinstance(response, dict) or response.get('kind') != 'calendar#freeBusy'
            or response.get('error') is not None or response.get('errors') not in (None, [])
            or not isinstance(response.get('calendars'), dict) or set(response['calendars']) != {calendar_id}
            or importer.timestamp(response.get('timeMin')) != importer.timestamp(query['timeMin'])
            or importer.timestamp(response.get('timeMax')) != importer.timestamp(query['timeMax'])):
        raise ValueError('Availability response does not match the requested calendar and range')
    calendar = response['calendars'][calendar_id]
    if (not isinstance(calendar, dict) or calendar.get('error') is not None or calendar.get('errors') not in (None, [])
            or not isinstance(calendar.get('busy'), list)):
        raise ValueError('Availability response is incomplete')
    envelope = {'timeMin': response['timeMin'], 'timeMax': response['timeMax'], 'updated': updated,
                'calendars': [{'calendar_id': calendar_id, 'busy': calendar['busy']}]}
    return importer.snapshot(source, envelope, now=updated)


def refresh_token(credentials, request, token_path):
    def bounded_request(*arguments, **options):
        options['timeout'] = HTTP_TIMEOUT
        options['allow_redirects'] = False
        return request(*arguments, **options)

    credentials.refresh(bounded_request)
    save_token(token_path, credentials)


def synchronize(importer, source, configuration, token_path, serial, model):
    query = rolling_request(source)
    token = token_configuration(token_path, configuration['installed'])
    credentials, session, request = create_clients(token)
    try:
        if not credentials.valid:
            refresh_token(credentials, request, token_path)
        validate_credentials(credentials)
        try:
            response = fetch_availability(session, credentials.token, query)
        except Unauthorized:
            refresh_token(credentials, request, token_path)
            response = fetch_availability(session, credentials.token, query)
        value = prepare_snapshot(importer, source, query, response, int(time.time() * 1000))
    finally:
        session.close()
    if ':' in serial:
        subprocess.run(['adb', 'connect', serial], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    importer.install(value, ['adb', '-s', serial], model)


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-file', type=Path, required=True, help='Private JSON with calendarId, id, name, color, timezone')
    parser.add_argument('--client-file', type=Path, required=True, help='Private Google Desktop OAuth client JSON, mode 600')
    parser.add_argument('--token-file', type=Path, required=True, help='Private OAuth token JSON, mode 600; created by --authorize')
    parser.add_argument('--serial', required=True, help='Explicit ADB serial or Wi-Fi endpoint')
    parser.add_argument('--model', required=True, help='Expected Android model, checked before importing')
    parser.add_argument('--authorize', action='store_true', help='Authorize interactively once; does not contact the frame')
    parser.add_argument('--host', choices=('127.0.0.1', 'localhost'), default='127.0.0.1')
    parser.add_argument('--port', type=int, default=0, help='Loopback callback port; zero chooses a free port')
    parser.add_argument('--authorize-timeout', type=int, default=180, help='Authorization wait, 30 to 600 seconds')
    args = parser.parse_args(arguments)
    try:
        paths = (args.source_file, args.client_file, args.token_file)
        if len({path.resolve() for path in paths}) != len(paths):
            raise ValueError('Source, client, and token must be separate files')
        with single_run(args.token_file):
            importer = importer_module()
            source = importer.read_json(args.source_file)
            rolling_request(source)
            configuration = client_configuration(args.client_file)
            if args.authorize:
                authorize(configuration, args.token_file, args.host, args.port, args.authorize_timeout)
            else:
                synchronize(importer, source, configuration, args.token_file, args.serial, args.model)
    except AlreadyRunning:
        print('Another calendar sync or authorization is already running; skipped.')
        return 0
    except ImportError:
        parser.exit(1, 'Install google-auth, google-auth-oauthlib, and requests in this Python environment before using Google synchronization.\n')
    except Exception:
        parser.exit(1, 'Google calendar operation failed. Check private configuration, mode-600 OAuth files, authorization, network, and the selected frame; a successful sync was not recorded.\n')
    print('Google authorization saved privately.' if args.authorize else 'Busy-only availability synchronized and verified. The frame refreshes within five minutes.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
