#!/usr/bin/env python3
"""Stage relocatable Windows/Linux tools; all network archives are hash locked."""
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def download(url, destination, digest):
    with urllib.request.urlopen(url, timeout=120) as response, destination.open("wb") as out:
        shutil.copyfileobj(response, out)
    with destination.open("rb") as content:
        actual = hashlib.file_digest(content, "sha256").hexdigest()
    if actual != digest:
        raise RuntimeError(f"Checksum mismatch: {destination.name}")


def extract(archive, destination):
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as bundle:
            for item in bundle.infolist():
                candidate = (destination / item.filename).resolve()
                if not candidate.is_relative_to(destination.resolve()):
                    raise RuntimeError("Unsafe archive member")
            bundle.extractall(destination)
    else:
        with tarfile.open(archive) as bundle:
            bundle.extractall(destination, filter="data")


def stage():
    target = {"win32": "windows", "linux": "linux"}.get(sys.platform)
    if target is None or platform.machine().lower() not in ("amd64", "x86_64"):
        raise RuntimeError("Use a native x64 Windows or Linux runner")
    lock = json.loads((ROOT / "scripts/release/runtime-lock.json").read_text())
    venv, binaries = ROOT / "engine-venv", ROOT / "engine-bin"
    if venv.exists() or binaries.exists():
        raise RuntimeError("Runtime directories already exist; use a clean checkout")
    with tempfile.TemporaryDirectory(prefix="bridgeclip-runtime-") as scratch:
        work = Path(scratch)
        py = lock["python"]
        filename = f'cpython-{py["version"]}+{py["tag"]}-{py[target]["target"]}-install_only_stripped.tar.gz'
        archive = work / filename
        download(f'https://github.com/astral-sh/python-build-standalone/releases/download/{py["tag"]}/{filename}', archive, py[target]["sha256"])
        extract(archive, work / "python-extract")
        shutil.copytree(work / "python-extract/python", venv, symlinks=False)
        interpreter = venv / ("python.exe" if target == "windows" else "bin/python3")
        subprocess.run([str(interpreter), "-m", "pip", "install", "--require-hashes", "-r", str(ROOT / "engine/requirements.lock")], check=True)
        download(f'https://raw.githubusercontent.com/python/cpython/v{py["version"]}/LICENSE', venv / "PYTHON-LICENSE", "3b2f81fe21d181c499c59a256c8e1968455d6689d269aa85373bfb6af41da3bf")
        ff = lock["ffmpeg"]
        archive = work / ff[target]["file"]
        # A maintainer may mirror the exact upstream archives for long-term
        # retention. The committed digest remains mandatory for mirrors.
        base = os.environ.get("BRIDGECLIP_FFMPEG_MIRROR") or f'https://github.com/BtbN/FFmpeg-Builds/releases/download/{ff["tag"]}'
        if not base.startswith("https://"):
            raise RuntimeError("Archive mirror must use HTTPS")
        cached = os.environ.get("BRIDGECLIP_FFMPEG_ARCHIVE")
        if cached:
            shutil.copy2(cached, archive)
            with archive.open("rb") as content:
                if hashlib.file_digest(content, "sha256").hexdigest() != ff[target]["sha256"]:
                    raise RuntimeError("Mirrored FFmpeg checksum mismatch")
        else:
            download(f'{base}/{archive.name}', archive, ff[target]["sha256"])
        extract(archive, work / "ffmpeg")
        distribution, = (work / "ffmpeg").iterdir()
        shutil.copytree(distribution / "bin", binaries, symlinks=False)
        if target == "linux":
            shutil.copytree(distribution / "lib", binaries / "lib", symlinks=False)
            # Keep every loader path inside this relocatable media directory.
            for binary in [binaries / "ffmpeg", binaries / "ffprobe", *list((binaries / "lib").glob("*.so*"))]:
                if binary.is_file():
                    subprocess.run(["patchelf", "--set-rpath", "$ORIGIN:$ORIGIN/lib", str(binary)], check=True)
        (binaries / ("ffplay.exe" if target == "windows" else "ffplay")).unlink(missing_ok=True)
        shutil.copy2(distribution / "LICENSE.txt", binaries / "FFMPEG-LICENSE")
        shutil.copy2(ROOT / "scripts/release/runtime-lock.json", binaries / "RUNTIME-PROVENANCE.json")
        (binaries / "FFMPEG-SOURCE.txt").write_text(
            f'FFmpeg 8.1.3, LGPL shared build. Build recipes and dependency revisions:\n'
            f'https://github.com/BtbN/FFmpeg-Builds/tree/{ff["build_commit"]}\n'
            'Windows/Linux official publication also requires the reviewed corresponding-source archive.\n', encoding="utf-8")
        if target == "windows":
            subprocess.run(["powershell", "-NoProfile", "-File", str(ROOT / "scripts/release/build-launcher.ps1")], check=True)
        else:
            launcher = binaries / "yt-dlp"
            launcher.write_text('#!/bin/sh\nBUNDLE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$BUNDLE_DIR/../engine-venv/bin/python3" -m yt_dlp "$@"\n')
            launcher.chmod(0o755)
        for cache in venv.rglob("__pycache__"):
            shutil.rmtree(cache)
        version = subprocess.check_output([str(binaries / ("ffmpeg.exe" if target == "windows" else "ffmpeg")), "-version"], text=True)
        if "--enable-gpl" in version or "--enable-nonfree" in version or "--enable-libopenh264" not in version:
            raise RuntimeError("Unexpected media build license or missing CPU H.264 encoder")
        (binaries / "FFMPEG-CONFIGURATION.txt").write_text(version, encoding="utf-8")
    print(f"Staged verified {target} x64 runtime")


if __name__ == "__main__":
    stage()
