#!/usr/bin/env python3
"""Synthetic image/CPIO checks; never reads firmware or accesses a device."""
import hashlib
import importlib.util
from pathlib import Path
import struct
import unittest
from unittest.mock import patch

from android_image import (boot_components, cpio_records, image_id, newc,
                           parse_recovery_image, replace_boot_ramdisk, sha)


def fixture(recovery=False):
    # Construct the format independently of the production parser and ID writer.
    payloads = [b'kernel' * 400, b'ramdisk' * 350, b'second',
                b'dtbo' if recovery else b'', b'dtb' * 101]
    image = bytearray(2048)
    image[:8] = b'ANDROID!'
    struct.pack_into('<II', image, 36, 2048, 2)
    struct.pack_into('<I', image, 1644, 1660)
    digest = hashlib.sha1()
    for field, payload in zip([8, 16, 24, 1632, 1648], payloads):
        struct.pack_into('<I', image, field, len(payload))
        if field == 1632 and recovery:
            struct.pack_into('<Q', image, 1636, len(image))
        image.extend(payload)
        image.extend(bytes(-len(image) % 2048))
        digest.update(payload + struct.pack('<I', len(payload)))
    image[576:596] = digest.digest()
    end = len(image)
    image.extend(b'partition-tail\x00AVB0' * 23)
    return bytes(image), payloads, end


class ImageTests(unittest.TestCase):
    def test_boot_and_recovery_layouts_and_digest(self):
        for recovery in [False, True]:
            original, payloads, end = fixture(recovery)
            if recovery:
                parts, actual_end = parse_recovery_image(original)
                self.assertEqual(list(parts.values()), payloads)
                with self.assertRaisesRegex(ValueError, 'DTBO'):
                    boot_components(original)
            else:
                parts, actual_end = boot_components(original)
                self.assertEqual([data for _, _, data in parts.values()], payloads)
                self.assertEqual(image_id(parts), original[576:596])
                self.assertEqual([offset for offset, _, _ in parts.values()],
                                 [2048, 6144, 10240, 12288, 12288])
                with self.assertRaisesRegex(ValueError, 'recovery_dtbo'):
                    parse_recovery_image(original)
            self.assertEqual(actual_end, end)

    def test_ramdisk_edit_changes_only_slot_size_and_image_id(self):
        original, payloads, end = fixture()
        replacement = b'new ramdisk' * 300
        result = replace_boot_ramdisk(original, replacement)
        expected = bytearray(original)
        expected[6144:10240] = replacement + bytes(4096 - len(replacement))
        struct.pack_into('<I', expected, 16, len(replacement))
        payloads[1] = replacement
        expected[576:596] = hashlib.sha1(b''.join(
            part + struct.pack('<I', len(part)) for part in payloads)).digest()
        self.assertEqual(result, expected)
        self.assertEqual(result[end:], original[end:])
        self.assertEqual(len(result), len(original))

    def test_rejects_relocation_invalid_header_id_bounds_and_dtbo(self):
        original, _, _ = fixture()
        for size in [0, 2048, 4097]:
            with self.subTest(size=size), self.assertRaisesRegex(ValueError, 'relocate'):
                replace_boot_ramdisk(original, bytes(size))
        for position, value in [(36, 4096), (40, 1), (1644, 1234), (8, len(original)), (1636, 1)]:
            broken = bytearray(original)
            struct.pack_into('<I', broken, position, value)
            with self.subTest(field=position), self.assertRaises(ValueError):
                boot_components(broken)
        for broken in [b'ANDROID!', bytes(len(original)), original[:2048]]:
            with self.assertRaises(ValueError):
                boot_components(broken)
        broken = bytearray(original)
        broken[576] ^= 1
        with self.assertRaisesRegex(ValueError, 'image ID'):
            replace_boot_ramdisk(broken, b'x' * 3000)
        recovery, _, _ = fixture(True)
        for field in [576, 1636]:
            broken = bytearray(recovery)
            broken[field] ^= 1
            with self.subTest(recovery_field=field), self.assertRaises(ValueError):
                parse_recovery_image(broken)


class CpioTests(unittest.TestCase):
    def test_newc_records_keep_content_metadata_and_padding(self):
        record = newc('hello', b'world', 123)
        self.assertEqual(record[:14], b'0707010000007b')
        self.assertEqual(int(record[14:22], 16), 0o100644)
        self.assertEqual(len(record) % 4, 0)
        trailer = newc('TRAILER!!!', b'', 124)
        raw = record + trailer + bytes(13)
        self.assertEqual(list(cpio_records(raw)),
                         [('hello', record, b'world'), ('TRAILER!!!', trailer, b'')])

    def test_rejects_truncated_records_names_and_nonzero_tail(self):
        record = newc('hello', b'world', 1)
        trailer = newc('TRAILER!!!', b'', 2)
        no_terminator = bytearray(record + trailer)
        no_terminator[115] = 65
        for raw in [record[:109], record[:113], record[:-4], record[:-1],
                    record, record + trailer + b'x', no_terminator]:
            with self.subTest(length=len(raw)), self.assertRaises(ValueError):
                list(cpio_records(raw))

    def test_property_patch_changes_exactly_three_content_bytes(self):
        spec = importlib.util.spec_from_file_location('recovery',
                    Path(__file__).with_name('build-diagnostic-recovery.py'))
        recovery = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recovery)
        props = b'ro.secure=1\nro.adb.secure=1\nro.debuggable=0\n'
        for name in ['prop.default', './prop.default']:
            raw = (newc('unrelated', b'unchanged', 1) + newc(name, props, 2) +
                   newc('TRAILER!!!', b'', 3) + bytes(17))
            with patch.object(recovery, 'CPIO_SHA256', sha(raw)), patch.object(recovery, 'PROP_SHA256', sha(props)):
                result, changes = recovery.patch_cpio(raw)
            self.assertEqual(len(changes), 3)
            self.assertEqual(sum(a != b for a, b in zip(raw, result)), 3)
            expected_props = b'ro.secure=0\nro.adb.secure=0\nro.debuggable=1\n'
            self.assertEqual(result, raw.replace(props, expected_props))


if __name__ == '__main__':
    unittest.main()
