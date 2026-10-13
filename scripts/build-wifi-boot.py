#!/usr/bin/env python3
"""Build the D156 Wi-Fi startup boot image offline from verified debug boot.

Only adb_debug.prop, ramdisk padding, ramdisk-size and Android image ID change.
The referenced init wrapper must be installed on first-stage-mounted /metadata
before this image is written. This program never accesses the device.
"""
import argparse
import gzip
import json
from pathlib import Path

from android_image import (align, boot_components as components, cpio_records,
                           image_id, newc, replace_boot_ramdisk, require, sha)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    original = args.source.read_bytes()
    require(sha(original) == 'f6e2c27c89a3db7835089fa8037909dc5e7eb62745eb90471fabab58b49821b3',
              'Source is not the verified installed debug boot')
    require(not args.output_dir.exists(), 'Output directory already exists')
    parts, _ = components(original)
    require(original[576:596] == image_id(parts), 'Bad source image ID')
    records = list(cpio_records(gzip.decompress(parts['ramdisk'][2])))
    prop = b'ro.debuggable=1\nro.force.debuggable=1\nro.boot.init_rc=/metadata/skylight-wifi/init.rc\n'
    changed = []
    found = 0
    for name, record, data in records:
        if name == 'adb_debug.prop':
            require(data == b'ro.debuggable=1\nro.force.debuggable=1\n', 'Unexpected debug properties')
            record = newc(name, prop, int(record[6:14], 16))
            found += 1
        changed.append(record)
    require(found == 1, 'Expected exactly one debug property entry')
    raw = b''.join(changed)
    raw += bytes(align(len(raw), 512) - len(raw))
    after = list(cpio_records(raw))
    require(len(after) == len(records), 'Entry count changed')
    for before, current in zip(records, after):
        if before[0] != 'adb_debug.prop':
            require(before == current, 'Unrelated CPIO entry changed')
        else:
            require(current[2] == prop, 'Property content mismatch')
    compressed = gzip.compress(raw, compresslevel=7, mtime=0)
    _, size, _ = parts['ramdisk']
    slot = align(size, 2048)
    result = replace_boot_ramdisk(original, compressed)
    args.output_dir.mkdir(parents=True)
    (args.output_dir / 'boot.img').write_bytes(result)
    manifest = {
        'source_sha256': sha(original), 'output_sha256': sha(result),
        'bytes': len(result), 'ramdisk_bytes': len(compressed),
        'ramdisk_slot_bytes': slot, 'modified_cpio_file': 'adb_debug.prop',
        'init_rc': '/metadata/skylight-wifi/init.rc',
        'preserved': ['kernel', 'resource/second', 'dtb', 'partition tail', 'all other CPIO records'],
        'requires': 'Install and verify metadata init wrapper before writing boot; preserve it across resets.'
    }
    (args.output_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    require(sha((args.output_dir / 'boot.img').read_bytes()) == manifest['output_sha256'],
              'File readback mismatch')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
