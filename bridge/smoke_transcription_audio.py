#!/usr/bin/env python3
"""Exercise BridgeClip audio extraction with the exact FFmpeg shipped to users."""

import asyncio
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from clip_engine.services.transcription_service import TranscriptionService


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: smoke_transcription_audio.py <ffmpeg-directory>", file=sys.stderr)
        return 2
    binary_dir = Path(sys.argv[1]).resolve()
    suffix = ".exe" if sys.platform == "win32" else ""
    ffmpeg = binary_dir / f"ffmpeg{suffix}"
    ffprobe = binary_dir / f"ffprobe{suffix}"
    if not ffmpeg.is_file() or not ffprobe.is_file():
        print("FFmpeg and FFprobe are required", file=sys.stderr)
        return 2
    os.environ["PATH"] = f"{binary_dir}{os.pathsep}{os.environ.get('PATH', '')}"

    with tempfile.TemporaryDirectory(prefix="bridgeclip-transcription-") as work:
        source = Path(work) / "source.mp4"
        extracted = Path(work) / "audio_extracted.wav"
        generated = subprocess.run(
            [str(ffmpeg), "-v", "error", "-y", "-f", "lavfi", "-i",
             "color=c=black:s=160x90:r=24:d=1", "-f", "lavfi", "-i",
             "sine=frequency=440:duration=1", "-c:v", "mpeg4", "-c:a", "aac",
             "-shortest", str(source)],
            capture_output=True, timeout=30, check=False,
        )
        if generated.returncode:
            print("Could not generate the audio smoke source", file=sys.stderr)
            return 1

        service = TranscriptionService.__new__(TranscriptionService)
        try:
            asyncio.run(service._extract_audio_from_video(str(source), str(extracted)))
        except Exception as exc:
            print(f"Bundled audio extraction failed: {type(exc).__name__}", file=sys.stderr)
            return 1
        probed = subprocess.run(
            [str(ffprobe), "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1",
             str(extracted)], capture_output=True, text=True, timeout=10, check=False,
        )
        if probed.returncode or probed.stdout.strip() != "pcm_s16le":
            print("Bundled audio extraction did not produce PCM WAV audio", file=sys.stderr)
            return 1
        if not 0.8 <= service._audio_duration(str(extracted)) <= 1.2:
            print("Transcription extraction changed the source playback speed", file=sys.stderr)
            return 1

    print("Bundled transcription audio extraction passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
