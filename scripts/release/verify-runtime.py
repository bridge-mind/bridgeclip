#!/usr/bin/env python3
"""Verify installed resources from a path containing spaces, without the checkout."""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def verify(resources):
    resources = Path(resources).resolve()
    interpreter = resources / "engine-venv" / ("python.exe" if sys.platform == "win32" else "bin/python3")
    for required in ["LICENSE", "THIRD_PARTY_NOTICES.md", "RENDERER-THIRD-PARTY-LICENSES.txt", "engine-venv/PYTHON-LICENSE", "engine-bin/FFMPEG-LICENSE"]:
        if not (resources / required).is_file():
            raise RuntimeError(f"Missing packaged resource: {required}")
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(resources / "engine")}
    for script, args in [("smoke_smart_render.py", [str(resources / "engine-bin" / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"))]),
                         ("smoke_transcription_audio.py", [str(resources / "engine-bin")]),
                         ("smoke_packaged_runtime.py", [str(resources)])]:
        subprocess.run([str(interpreter), str(resources / "bridge" / script), *args], env=environment, cwd=resources, check=True, timeout=180)


if __name__ == "__main__":
    # A copy catches absolute shebangs, missing DLLs, and build-machine paths.
    with tempfile.TemporaryDirectory(prefix="BridgeClip installed test ") as temporary:
        destination = Path(temporary) / "resources"
        shutil.copytree(sys.argv[1], destination, symlinks=False)
        verify(destination)
