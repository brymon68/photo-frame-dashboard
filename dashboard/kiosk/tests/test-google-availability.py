#!/usr/bin/env python3
"""Offline OAuth, free/busy, and import orchestration contracts."""
import contextlib
import copy
from datetime import datetime
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo


specification = importlib.util.spec_from_file_location('google_availability', Path(__file__).resolve().parents[1] / 'sync-google-availability.py')
sync = importlib.util.module_from_spec(specification)
specification.loader.exec_module(sync)
availability = sync.importer_module()
SOURCE = {'calendarId': 'shared@example.test', 'id': 'work', 'name': 'Work', 'color': '#2d5bff', 'timezone': 'America/Denver'}
CLIENT = {'client_id': 'example.apps.googleusercontent.com', 'client_secret': 'test-client-secret',
          'auth_uri': 'https://accounts.google.com/o/oauth2/auth', 'token_uri': sync.TOKEN_ENDPOINT}
NOW = datetime(2026, 10, 17, 12, tzinfo=ZoneInfo(SOURCE['timezone']))
STAMP = int(NOW.timestamp() * 1000)
QUERY = sync.rolling_request(SOURCE, NOW)
RESPONSE = {'kind': 'calendar#freeBusy', 'timeMin': QUERY['timeMin'], 'timeMax': QUERY['timeMax'],
            'calendars': {SOURCE['calendarId']: {'busy': [{'start': '2026-10-19T09:00:00-06:00', 'end': '2026-10-19T10:00:00-06:00'}]}}}


class FakeCredentials:
    def __init__(self, valid=True):
        self.valid = valid
        self.token = 'test-access-token'
        self.refresh_token = 'test-refresh-token'
        self.scopes = [sync.SCOPE]
        self.granted_scopes = None
        self.refreshes = 0

    def refresh(self, request):
        self.refreshes += 1
        request(url=sync.TOKEN_ENDPOINT, method='POST', body=b'private-refresh-request')
        self.valid = True
        self.token = 'refreshed-access-token'

    def to_json(self):
        return json.dumps({'token': self.token, 'refresh_token': self.refresh_token,
                           'client_id': CLIENT['client_id'], 'client_secret': CLIENT['client_secret'],
                           'token_uri': sync.TOKEN_ENDPOINT, 'scopes': self.scopes})


class FakeResponse:
    def __init__(self, payload=None, status=200, raw=None):
        self.status_code = status
        self.contents = raw if raw is not None else json.dumps(RESPONSE if payload is None else payload).encode()
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *arguments):
        self.closed = True

    def iter_content(self, chunk_size):
        for offset in range(0, len(self.contents), chunk_size):
            yield self.contents[offset:offset + chunk_size]


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.closed = False

    def post(self, url, **options):
        self.calls.append((url, options))
        return self.responses.pop(0)

    def close(self):
        self.closed = True


class GoogleAvailabilityTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.write('source.json', SOURCE)
        self.client = self.write('client.json', {'installed': CLIENT})
        self.token = self.root / 'token.json'
        self.token.write_text(FakeCredentials().to_json())
        self.token.chmod(0o600)

    def write(self, name, value):
        target = self.root / name
        target.write_text(json.dumps(value))
        target.chmod(0o600)
        return target

    def run_sync(self, responses, valid=True, serial='test-device'):
        credentials = FakeCredentials(valid)
        session = FakeSession(responses)
        request = Mock()
        importer = Mock(snapshot=availability.snapshot, timestamp=availability.timestamp)
        with patch.object(sync, 'create_clients', return_value=(credentials, session, request)), \
                patch.object(sync, 'rolling_request', return_value=QUERY), patch.object(sync.time, 'time', return_value=STAMP / 1000), \
                patch.object(sync.subprocess, 'run') as adb:
            sync.synchronize(importer, SOURCE, {'installed': CLIENT}, self.token, serial, 'FRAME156')
        return importer, credentials, session, request, adb

    def test_rolling_window_follows_local_monday_and_dst(self):
        self.assertEqual(QUERY['timeMin'], '2026-10-05T00:00:00-06:00')
        self.assertEqual(QUERY['timeMax'], '2026-12-07T00:00:00-07:00')
        self.assertEqual(QUERY['items'], [{'id': SOURCE['calendarId']}])
        monday = datetime(2026, 10, 19, 0, tzinfo=ZoneInfo(SOURCE['timezone']))
        self.assertEqual(sync.rolling_request(SOURCE, monday)['timeMin'], '2026-10-12T00:00:00-06:00')

    def test_valid_run_only_requests_freebusy_and_imports_real_timestamp(self):
        response = FakeResponse()
        importer, credentials, session, request, adb = self.run_sync([response])
        self.assertEqual(credentials.refreshes, 0)
        self.assertFalse(request.called)
        self.assertFalse(adb.called)
        importer.install.assert_called_once()
        value, prefix, model = importer.install.call_args.args
        self.assertEqual(value['updated'], STAMP)
        self.assertEqual(prefix, ['adb', '-s', 'test-device'])
        self.assertEqual(model, 'FRAME156')
        self.assertEqual(set(value['busy'][0]), {'start', 'end'})
        self.assertNotIn(SOURCE['calendarId'], json.dumps(value))
        self.assertTrue(response.closed and session.closed)
        endpoint, options = session.calls[0]
        self.assertEqual(endpoint, sync.ENDPOINT)
        self.assertEqual(options['json'], QUERY)
        self.assertEqual(options['timeout'], (10, 30))
        self.assertFalse(options['allow_redirects'])
        self.assertTrue(options['stream'])
        self.assertEqual(options['headers'], {'Authorization': 'Bearer test-access-token'})

    def test_refresh_persists_atomically_and_network_transport_reconnects(self):
        importer, credentials, session, request, adb = self.run_sync([FakeResponse()], valid=False, serial='test-device:5555')
        self.assertEqual(credentials.refreshes, 1)
        self.assertEqual(request.call_args.kwargs['timeout'], sync.HTTP_TIMEOUT)
        self.assertFalse(request.call_args.kwargs['allow_redirects'])
        self.assertEqual(json.loads(self.token.read_text())['token'], 'refreshed-access-token')
        self.assertEqual(stat.S_IMODE(self.token.stat().st_mode), 0o600)
        self.assertFalse(list(self.root.glob('.token.json-*')))
        adb.assert_called_once_with(['adb', 'connect', 'test-device:5555'], check=True,
                                    stdout=sync.subprocess.PIPE, stderr=sync.subprocess.PIPE, timeout=30)
        self.assertEqual(importer.install.call_args.args[1], ['adb', '-s', 'test-device:5555'])

    def test_unauthorized_retries_once_with_a_refreshed_token(self):
        importer, credentials, session, request, adb = self.run_sync([FakeResponse(status=401), FakeResponse()])
        self.assertEqual(credentials.refreshes, 1)
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(session.calls[1][1]['headers']['Authorization'], 'Bearer refreshed-access-token')
        self.assertTrue(importer.install.called)
        with self.assertRaises(sync.Unauthorized):
            self.run_sync([FakeResponse(status=401), FakeResponse(status=401)])

    def test_missing_wrong_failed_or_malformed_responses_never_import(self):
        failed = copy.deepcopy(RESPONSE)
        failed['calendars'][SOURCE['calendarId']]['errors'] = [{'reason': 'forbidden'}]
        error = copy.deepcopy(RESPONSE)
        error['calendars'][SOURCE['calendarId']]['error'] = {'reason': 'forbidden'}
        missing_busy = copy.deepcopy(RESPONSE)
        del missing_busy['calendars'][SOURCE['calendarId']]['busy']
        invalid_busy = copy.deepcopy(RESPONSE)
        invalid_busy['calendars'][SOURCE['calendarId']]['busy'] = [{'start': STAMP, 'end': STAMP}]
        for payload in [None, {}, [], failed, error, missing_busy, invalid_busy,
                        {**RESPONSE, 'kind': 'other'}, {**RESPONSE, 'error': {'message': 'private-error'}},
                        {**RESPONSE, 'timeMin': '2026-01-01T00:00:00Z'},
                        {**RESPONSE, 'timeMax': '2026-01-01T00:00:00Z'},
                        {**RESPONSE, 'calendars': {'wrong@example.test': {'busy': []}}},
                        {**RESPONSE, 'calendars': {**RESPONSE['calendars'], 'extra@example.test': {'busy': []}}}]:
            session = FakeSession([FakeResponse(raw=json.dumps(payload).encode())])
            importer = Mock(snapshot=availability.snapshot, timestamp=availability.timestamp)
            with self.subTest(payload=payload), patch.object(sync, 'create_clients', return_value=(FakeCredentials(), session, Mock())), \
                    patch.object(sync, 'rolling_request', return_value=QUERY), patch.object(sync.time, 'time', return_value=STAMP / 1000), \
                    patch.object(sync.subprocess, 'run') as adb, self.assertRaises((ValueError, RuntimeError)):
                sync.synchronize(importer, SOURCE, {'installed': CLIENT}, self.token, 'test-device', 'FRAME156')
            self.assertFalse(importer.install.called or adb.called)
            self.assertTrue(session.closed)

    def test_explicit_empty_busy_is_success(self):
        response = {**RESPONSE, 'calendars': {SOURCE['calendarId']: {'busy': []}}}
        importer, *_ = self.run_sync([FakeResponse(response)])
        self.assertEqual(importer.install.call_args.args[0]['busy'], [])

    def test_response_http_and_size_failures(self):
        for response in [FakeResponse(status=302), FakeResponse(status=403), FakeResponse(status=500),
                         FakeResponse(raw=b'{'), FakeResponse(raw=b'x' * (sync.MAX_SIZE + 1))]:
            with self.subTest(status=response.status_code), self.assertRaises((ValueError, RuntimeError)):
                sync.fetch_availability(FakeSession([response]), 'token', QUERY)
            self.assertTrue(response.closed)

    def test_client_token_permissions_identity_and_scope_are_restricted(self):
        self.assertEqual(sync.client_configuration(self.client), {'installed': CLIENT})
        self.assertEqual(sync.token_configuration(self.token, CLIENT)['scopes'], [sync.SCOPE])
        for change in [{'token_uri': 'https://example.test/token'}, {'auth_uri': 'https://example.test/auth'},
                       {'client_id': 'not-a-google-client'}, {'client_secret': ''}]:
            bad = self.write('bad-client.json', {'installed': {**CLIENT, **change}})
            with self.subTest(change=change), self.assertRaises(ValueError):
                sync.client_configuration(bad)
        original = json.loads(self.token.read_text())
        for change in [{'client_id': 'different.apps.googleusercontent.com'}, {'refresh_token': ''},
                       {'scopes': [sync.SCOPE, 'email']}, {'token_uri': 'https://example.test/token'},
                       {'client_secret': 'different'}]:
            bad = self.write('bad-token.json', {**original, **change})
            with self.subTest(change=change), self.assertRaises(ValueError):
                sync.token_configuration(bad, CLIENT)
        self.client.chmod(0o644)
        with self.assertRaises(ValueError):
            sync.client_configuration(self.client)
        link = self.root / 'linked-token.json'
        link.symlink_to(self.token)
        with self.assertRaises(ValueError):
            sync.private_json(link)

    def test_failed_atomic_token_write_preserves_previous_token(self):
        before = self.token.read_bytes()
        with patch.object(sync.os, 'replace', side_effect=OSError('failed')), self.assertRaises(OSError):
            sync.save_token(self.token, FakeCredentials())
        self.assertEqual(self.token.read_bytes(), before)
        self.assertFalse(list(self.root.glob('.token.json-*')))

    def test_lock_prevents_concurrent_authorization_or_sync(self):
        with sync.single_run(self.token):
            with self.assertRaises(sync.AlreadyRunning):
                with sync.single_run(self.token):
                    self.fail('The second run acquired the same lock')
        with sync.single_run(self.token):
            pass
        self.assertEqual(stat.S_IMODE(Path(str(self.token) + '.lock').stat().st_mode), 0o600)

    def test_authorize_is_loopback_only_bounded_and_saves_tokens(self):
        flow = Mock()
        flow.oauth2session.request = Mock(return_value='response')
        original = flow.oauth2session.request
        flow.run_local_server.return_value = FakeCredentials()
        with patch.object(sync, 'create_flow', return_value=flow) as factory:
            sync.authorize({'installed': CLIENT}, self.token, '127.0.0.1', 0, 180)
        factory.assert_called_once_with({'installed': CLIENT})
        options = flow.run_local_server.call_args.kwargs
        self.assertEqual(options['bind_addr'], '127.0.0.1')
        self.assertFalse(options['open_browser'])
        self.assertEqual(options['timeout_seconds'], 180)
        self.assertEqual(options['access_type'], 'offline')
        self.assertEqual(options['prompt'], 'consent')
        self.assertIn('{url}', options['authorization_prompt_message'])
        flow.oauth2session.request('POST', sync.TOKEN_ENDPOINT)
        self.assertEqual(original.call_args.kwargs['timeout'], sync.HTTP_TIMEOUT)
        self.assertFalse(original.call_args.kwargs['allow_redirects'])
        flow.oauth2session.close.assert_called_once()
        for host, port, timeout in [('0.0.0.0', 0, 180), ('example.test', 0, 180), ('localhost', -1, 180),
                                    ('localhost', 65536, 180), ('localhost', 0, 0), ('localhost', 0, 601)]:
            with self.subTest(host=host, port=port, timeout=timeout), self.assertRaises(ValueError):
                sync.authorize({'installed': CLIENT}, self.token, host, port, timeout)

    def test_oauth_factory_enables_pkce_and_only_requests_availability(self):
        flow_module = Mock()
        with patch.dict(sys.modules, {'google_auth_oauthlib': Mock(), 'google_auth_oauthlib.flow': flow_module}):
            flow = sync.create_flow({'installed': CLIENT})
        flow_module.InstalledAppFlow.from_client_config.assert_called_once_with(
            {'installed': CLIENT}, scopes=[sync.SCOPE], autogenerate_code_verifier=True)
        self.assertIs(flow, flow_module.InstalledAppFlow.from_client_config.return_value)

    def test_authorization_rejects_broader_grants_without_replacing_tokens(self):
        credentials = FakeCredentials()
        credentials.granted_scopes = [sync.SCOPE, 'email']
        before = self.token.read_bytes()
        with self.assertRaises(ValueError):
            sync.save_token(self.token, credentials)
        self.assertEqual(self.token.read_bytes(), before)

    def test_cli_failures_do_not_disclose_provider_errors(self):
        arguments = ['--source-file', str(self.source), '--client-file', str(self.client), '--token-file', str(self.token),
                     '--serial', 'test-device', '--model', 'FRAME156']
        with patch.object(sync, 'synchronize', side_effect=RuntimeError('secret-token private-calendar')), \
                contextlib.redirect_stderr(io.StringIO()) as stderr, self.assertRaises(SystemExit) as stopped:
            sync.main(arguments)
        self.assertEqual(stopped.exception.code, 1)
        self.assertNotIn('secret-token', stderr.getvalue())
        self.assertNotIn('private-calendar', stderr.getvalue())
        with patch.object(sync, 'authorize') as authorize, patch.object(sync, 'synchronize') as synchronize, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sync.main([*arguments, '--authorize']), 0)
        authorize.assert_called_once()
        self.assertFalse(synchronize.called)


if __name__ == '__main__':
    unittest.main()
