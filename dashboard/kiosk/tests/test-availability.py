#!/usr/bin/env python3
"""Host-only validation and mocked ADB tests for busy snapshot imports."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('availability', Path(__file__).resolve().parents[1] / 'configure-availability.py')
availability = importlib.util.module_from_spec(spec)
spec.loader.exec_module(availability)
SOURCE = {'calendarId': 'shared@example.test', 'id': 'work', 'name': 'Work', 'color': '#2d5bff'}
RESPONSE = {
    'timeMin': '2026-10-17T00:00:00-06:00', 'timeMax': '2026-10-24T00:00:00-06:00',
    'updated': '2026-10-17T12:00:00-06:00',
    'calendars': [{'calendar_id': 'shared@example.test', 'errors': None, 'busy': [
        {'start': '2026-10-19T09:00:00-06:00', 'end': '2026-10-19T10:00:00-06:00', 'title': 'Must not persist'},
    ]}],
}
NOW = availability.timestamp(RESPONSE['updated'])


class AvailabilityTest(unittest.TestCase):
    def build(self, response=None, source=None):
        return availability.snapshot(source or SOURCE, RESPONSE if response is None else response, NOW)

    def test_busy_only_deterministic_snapshot(self):
        value = self.build()
        self.assertEqual(value, self.build())
        self.assertEqual(value['color'], '#2D5BFF')
        self.assertEqual(value['updated'], NOW)
        self.assertRegex(value['revision'], '^[0-9a-f]{64}$')
        self.assertEqual(set(value['busy'][0]), {'start', 'end'})
        self.assertNotIn('shared@example.test', json.dumps(value))
        self.assertNotIn('Must not persist', json.dumps(value))

    def test_empty_busy_is_valid_but_missing_is_not(self):
        response = copy.deepcopy(RESPONSE)
        response['calendars'][0]['busy'] = []
        self.assertEqual(self.build(response)['busy'], [])
        del response['calendars'][0]['busy']
        with self.assertRaises(ValueError):
            self.build(response)

    def test_calendar_errors_or_wrong_identity_never_become_free(self):
        for calendars in [[], [{'calendar_id': 'wrong@example.test', 'busy': []}],
                          [{'calendar_id': SOURCE['calendarId'], 'busy': [], 'errors': [{'reason': 'forbidden'}]}],
                          RESPONSE['calendars'] * 2]:
            with self.subTest(calendars=calendars), self.assertRaises(ValueError):
                self.build({**RESPONSE, 'calendars': calendars})

    def test_invalid_times_and_ranges_rejected(self):
        for value in [True, None, 1.5, -1, availability.MAX_TIMESTAMP + 1,
                      '2026-10-17', '2026-10-17T12:00:00', '2026-99-17T12:00:00Z']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                availability.timestamp(value)
        for change in [{'timeMax': RESPONSE['timeMin']}, {'timeMax': '2028-01-01T00:00:00Z'},
                       {'updated': NOW - 30 * 60000 - 1}, {'updated': NOW + 5 * 60000 + 1}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.build({**RESPONSE, **change})

    def test_invalid_busy_intervals_rejected(self):
        for intervals in [[None], [{'start': NOW, 'end': NOW}], [{'start': NOW + 1, 'end': NOW}],
                          [{'start': 0, 'end': 1}], RESPONSE['calendars'][0]['busy'] * 5001]:
            response = copy.deepcopy(RESPONSE)
            response['calendars'][0]['busy'] = intervals
            with self.subTest(count=len(intervals)), self.assertRaises(ValueError):
                self.build(response)

    def test_intervals_clipped_deduplicated_and_sorted(self):
        response = copy.deepcopy(RESPONSE)
        response['calendars'][0]['busy'] *= 2
        response['calendars'][0]['busy'].append({'start': '2026-10-16T23:00:00-06:00', 'end': '2026-10-17T01:00:00-06:00'})
        value = self.build(response)
        self.assertEqual(len(value['busy']), 2)
        self.assertEqual(value['busy'][0]['start'], value['rangeStart'])

    def test_source_validation_and_revision_changes(self):
        for change in [{'id': 'family'}, {'id': 'feed'}, {'id': '../bad'}, {'name': ''},
                       {'name': '😀' * 21}, {'color': 'blue'}, {'calendarId': 'bad\nvalue'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.build(source={**SOURCE, **change})
        self.assertEqual(self.build(source={**SOURCE, 'name': '\u202e Work\n Name '})['name'], 'Work Name')
        self.assertEqual(availability.timestamp('2026-11-02T12:00:00-07:00'), availability.timestamp('2026-11-02T19:00:00Z'))

    def run_install(self, model='FRAME156', sources=None, existing=None, version=30, fail_upload=False):
        calls = []
        state = {'snapshot': existing}

        def adb(arguments, **kwargs):
            calls.append((arguments, kwargs.get('input')))
            self.assertEqual(arguments[:3], ['adb', '-s', 'test-device'])
            command = arguments[-1]
            output = ''
            code = 0
            if command == 'getprop ro.product.model':
                output = model
            elif command.startswith('dumpsys package'):
                output = 'userId=12345 versionCode=' + str(version)
            elif 'if [ -f' in command:
                value = sources if 'calendar-sources.json' in command else state['snapshot']
                output = json.dumps(value) if value is not None else ''
            elif command.startswith('umask 077; cat >'):
                state['pending'] = json.loads(kwargs['input'])
                code = 1 if fail_upload else 0
            elif '&& mv -f' in command:
                self.assertIn('chmod 600', command)
                self.assertIn('chown 12345:12345', command)
                state['snapshot'] = state['pending']
            return subprocess.CompletedProcess(arguments, code, output.encode(), b'')

        with patch.object(availability.subprocess, 'run', side_effect=adb):
            availability.install(self.build(), ['adb', '-s', 'test-device'], 'FRAME156')
        return calls

    def test_atomic_upload_preserves_ical_sources(self):
        calls = self.run_install(sources=[{'id': 'other', 'url': 'private-not-logged'}])
        mutations = [arguments[-1] for arguments, data in calls if '&& mv -f' in arguments[-1]]
        self.assertEqual(len(mutations), 1)
        self.assertIn('calendar-availability.json', mutations[0])
        self.assertNotIn('calendar-url.txt', mutations[0])
        self.assertNotIn('calendar-sources.json', mutations[0])
        self.assertTrue(any(data is not None for arguments, data in calls))

    def test_model_old_app_collision_and_regression_fail_closed(self):
        for options in [{'model': 'wrong'}, {'version': 29}, {'sources': [{'id': 'work'}]},
                        {'existing': {**self.build(), 'updated': NOW + 1}}, {'fail_upload': True}]:
            with self.subTest(options=options), self.assertRaises((ValueError, RuntimeError)):
                self.run_install(**options)


if __name__ == '__main__':
    unittest.main()
