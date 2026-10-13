"""Pure byte helpers for the guarded Android v2 image builders.

Source identity, extraction manifests and allowed CPIO edits stay in each CLI.
This module never reads files, invokes tools or accesses a device.
"""
import hashlib
import struct

PAGE = 2048
COMPONENT_FIELDS = [('kernel', 8), ('ramdisk', 16), ('second', 24),
                    ('recovery_dtbo', 1632), ('dtb', 1648)]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def align(number, unit):
    return (number + unit - 1) // unit * unit


def _components(image):
    require(len(image) >= 1660 and image[:8] == b'ANDROID!', 'Invalid Android header')
    require(struct.unpack_from('<II', image, 36) == (PAGE, 2),
            'Only the documented 2048-byte/v2 image is supported')
    require(struct.unpack_from('<I', image, 1644)[0] == 1660, 'Unexpected v2 header size')
    parts, offset = {}, PAGE
    for name, field in COMPONENT_FIELDS:
        size = struct.unpack_from('<I', image, field)[0]
        require(offset + size <= len(image), f'Invalid component bounds: {name}')
        parts[name] = (offset, size, image[offset:offset + size])
        offset += align(size, PAGE)
    return parts, offset


def boot_components(image):
    parts, end = _components(image)
    require(parts['recovery_dtbo'][1] == 0 and image[1636:1644] == bytes(8),
            'Unexpected recovery DTBO')
    return parts, end


def image_id(parts):
    digest = hashlib.sha1()
    for name, _ in COMPONENT_FIELDS:
        _, size, data = parts[name]
        digest.update(data)
        digest.update(struct.pack('<I', size))
    return digest.digest()


def parse_recovery_image(image):
    parts, end = _components(image)
    for name, (_, size, _) in parts.items():
        require(size > 0, f'Invalid component bounds: {name}')
    require(struct.unpack_from('<Q', image, 1636)[0] == parts['recovery_dtbo'][0],
            'Recovery DTBO offset differs from sequential layout')
    require(image[576:596] == image_id(parts), 'Android image ID mismatch')
    return {name: data for name, (_, _, data) in parts.items()}, end


def replace_boot_ramdisk(original, compressed):
    """Replace only the existing ramdisk slot, size field and Android image ID."""
    parts, end = boot_components(original)
    require(original[576:596] == image_id(parts), 'Source Android image ID mismatch')
    start, size, _ = parts['ramdisk']
    slot = align(size, PAGE)
    require(align(len(compressed), PAGE) == slot, 'New ramdisk would relocate other components')
    result = bytearray(original)
    result[start:start + slot] = compressed + bytes(slot - len(compressed))
    struct.pack_into('<I', result, 16, len(compressed))
    rebuilt, new_end = boot_components(result)
    result[576:596] = image_id(rebuilt)
    require(new_end == end, 'Declared image end changed')
    for name in parts:
        if name != 'ramdisk':
            require(rebuilt[name] == parts[name], f'Component changed: {name}')
    reverted = bytearray(result)
    for lo, hi in [(16, 20), (576, 596), (start, start + slot)]:
        reverted[lo:hi] = original[lo:hi]
    require(reverted == original, 'Unexpected bytes outside allowed intervals changed')
    require(result[end:] == original[end:], 'Partition tail changed')
    return bytes(result)


def cpio_records(cpio):
    """Yield (name, complete record, content), preserving metadata and padding."""
    offset = 0
    while offset < len(cpio):
        start = offset
        require(offset + 110 <= len(cpio) and cpio[offset:offset + 6] == b'070701',
                'Unsupported CPIO record')
        fields = [int(cpio[offset + 6 + i * 8:offset + 14 + i * 8], 16) for i in range(13)]
        size, namesize = fields[6], fields[11]
        offset += 110
        require(namesize > 0 and offset + namesize <= len(cpio), 'Invalid CPIO name bounds')
        require(cpio[offset + namesize - 1] == 0, 'Unterminated CPIO name')
        name = cpio[offset:offset + namesize - 1].decode('utf-8')
        offset = align(offset + namesize, 4)
        content = cpio[offset:offset + size]
        require(len(content) == size, 'Truncated CPIO record')
        offset = align(offset + size, 4)
        require(offset <= len(cpio), 'Truncated CPIO padding')
        yield name, cpio[start:offset], content
        if name == 'TRAILER!!!':
            require(not any(cpio[offset:]), 'Unexpected nonzero CPIO tail')
            return
    raise ValueError('Missing CPIO trailer')


def newc(name, content, inode):
    """Encode the root-owned regular files added by the debug/Wi-Fi builders."""
    name = name.encode() + b'\0'
    fields = [inode, 0o100644, 0, 0, 1, 0, len(content), 0, 0, 0, 0, len(name), 0]
    result = b'070701' + b''.join(f'{x:08x}'.encode() for x in fields) + name
    result += bytes(align(len(result), 4) - len(result))
    result += content
    return result + bytes(align(len(result), 4) - len(result))
