#!/usr/bin/env python3
"""Fetch and verify the pinned camera-signaling dependencies from Maven Central."""
import hashlib
from pathlib import Path
import urllib.request

DEPENDENCIES = {
    "org/java-websocket/Java-WebSocket/1.6.0/Java-WebSocket-1.6.0.jar":
        "eae29213e4f16515639c28957200f011b3967fffcada1962cf0255d24919c22f",
    "org/slf4j/slf4j-api/2.0.13/slf4j-api-2.0.13.jar":
        "e7c2a48e8515ba1f49fa637d57b4e2f590b3f5bd97407ac699c3aa5efb1204a9",
    "org/slf4j/slf4j-nop/2.0.13/slf4j-nop-2.0.13.jar":
        "8962a107b4a8bdf80b6c17e470cd3614ad3329643833ff5cf0c60c7dce9deaac",
}
COMPILER = (
    "https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.7.18/r8-8.7.18.jar",
    "58366f77067207c39a17d469de7b05701d2877212a9c55201bcb0af43e59e903",
)


def main():
    folder = Path(__file__).resolve().parent / "lib"
    folder.mkdir(exist_ok=True)
    downloads = [("https://repo.maven.apache.org/maven2/" + path, digest)
                 for path, digest in DEPENDENCIES.items()] + [COMPILER]
    for address, checksum in downloads:
        target = folder / address.rsplit("/", 1)[1]
        data = target.read_bytes() if target.exists() else b""
        if hashlib.sha256(data).hexdigest() != checksum:
            with urllib.request.urlopen(address, timeout=30) as response:
                data = response.read(32 * 1024 * 1024)
            if hashlib.sha256(data).hexdigest() != checksum:
                raise RuntimeError("Dependency checksum mismatch: " + target.name)
            target.write_bytes(data)
    print("Camera signaling dependencies verified.")


if __name__ == "__main__":
    main()
