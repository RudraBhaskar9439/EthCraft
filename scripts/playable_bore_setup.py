#!/usr/bin/env python3
"""Prepare the pinned Bore client; never start or restart a tunnel."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import urllib.request

VERSION = "0.6.0"
URL = "https://github.com/ekzhang/bore/releases/download/v0.6.0/bore-v0.6.0-x86_64-unknown-linux-musl.tar.gz"
ARCHIVE_SHA = "e484d1e3acba77169b773f31a5bfb34192d4b660f44a094a658a2522cd2270f7"
BINARY_SHA = "60548b7a145ba334981b19fda7cd0210d24a108a3d0dc113919b33fd2eaa90ab"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError("OWNED_REGULAR_FILE_REQUIRED")
    return path.read_bytes()


def atomic(path, data, mode):
    descriptor, temporary = tempfile.mkstemp(prefix=".bore-", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare", action="store_true")
    arguments = parser.parse_args()
    if not arguments.prepare:
        print(json.dumps({"version": VERSION, "url": URL, "archiveSha256": ARCHIVE_SHA,
                          "binarySha256": BINARY_SHA, "publicExposureStarted": False}))
        return
    if os.name != "posix" or not os.environ.get("WSL_DISTRO_NAME"):
        raise RuntimeError("WSL_PRIVATE_EXT4_PREPARATION_REQUIRED")
    private = Path.home() / ".local/share/agentcity-public-access/bore-v0.6.0"
    if str(private).startswith("/mnt/"):
        raise RuntimeError("PRIVATE_EXT4_REQUIRED")
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = private.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("PRIVATE_DIRECTORY_OWNER_MODE_REQUIRED")
    binary = private / "bore"
    if binary.exists() or binary.is_symlink():
        contents = regular(binary)
        if digest(contents) != BINARY_SHA or binary.stat().st_mode & 0o077 or not binary.stat().st_mode & stat.S_IXUSR:
            raise RuntimeError("EXISTING_BORE_BINARY_MISMATCH")
    else:
        archive = private / "release.tar.gz"
        if archive.exists() or archive.is_symlink():
            data = regular(archive)
        else:
            with urllib.request.urlopen(URL, timeout=60) as response:
                data = response.read(16_000_001)
            if len(data) > 16_000_000 or digest(data) != ARCHIVE_SHA:
                raise RuntimeError("OFFICIAL_ARCHIVE_CHECKSUM_MISMATCH")
            atomic(archive, data, 0o600)
        if digest(data) != ARCHIVE_SHA:
            raise RuntimeError("EXISTING_ARCHIVE_CHECKSUM_MISMATCH")
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source:
            members = [entry for entry in source.getmembers() if entry.name in ("bore", "./bore") and entry.isfile()]
            if len(members) != 1 or members[0].size > 16_000_000:
                raise RuntimeError("EXACT_REGULAR_BORE_MEMBER_REQUIRED")
            contents = source.extractfile(members[0]).read(16_000_001)
        if digest(contents) != BINARY_SHA:
            raise RuntimeError("BORE_BINARY_CHECKSUM_MISMATCH")
        atomic(binary, contents, 0o700)
    settings = {"binary": str(binary), "sha256": BINARY_SHA, "requestedPort": 51967,
                "relay": "bore.pub", "relayAddress": "159.223.110.159"}
    destination = Path(__file__).resolve().parent.parent / ".local/hosting/bore.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        if json.loads(regular(destination)) != settings:
            raise RuntimeError("EXISTING_BORE_SETTINGS_MISMATCH")
    else:
        atomic(destination, (json.dumps(settings, indent=2) + "\n").encode(), 0o600)
    print(json.dumps({"status": "prepared", "version": VERSION, "settings": str(destination),
                      "binarySha256": BINARY_SHA, "publicExposureStarted": False}))


if __name__ == "__main__":
    main()
