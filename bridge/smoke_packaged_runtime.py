#!/usr/bin/env python3
"""Render a captioned, sped-up H.264 clip with the shipped interpreter and tools."""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    resources = Path(sys.argv[1]).resolve()
    binaries = resources / "engine-bin"
    suffix = ".exe" if sys.platform == "win32" else ""
    ffmpeg, ffprobe = (str(binaries / f"{name}{suffix}") for name in ("ffmpeg", "ffprobe"))
    os.environ["PATH"] = str(binaries) + os.pathsep + os.environ.get("PATH", "")
    os.environ["LOCAL_MODE"] = "true"
    sys.path.insert(0, str(resources / "engine"))
    from clip_engine.bridge_contract import BRIDGE_CONTRACT_VERSION
    from clip_engine.services.layout_analyzer import LayoutAnalyzer
    from clip_engine.services.rendering_service import RenderingService, RenderRequest
    from clip_engine.services.transcription_service import TranscriptSegment
    import cv2
    import yt_dlp
    assert BRIDGE_CONTRACT_VERSION == 2 and LayoutAnalyzer().available
    assert cv2.__version__ and yt_dlp.version.__version__
    subprocess.run([str(binaries / f"yt-dlp{suffix}"), "--version"], check=True, timeout=20)
    with tempfile.TemporaryDirectory(prefix="BridgeClip packaged smoke ") as temporary:
        work = Path(temporary)
        source, output = work / "source.mp4", work / "output.mp4"
        subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", str(source)], check=True, timeout=30)
        request = RenderRequest(video_path=str(source), output_path=str(output), start_time_ms=0,
                                end_time_ms=4000, source_width=320, source_height=240,
                                video_speed=2.0, pacing="natural", layout_style="fit",
                                transcript_segments=[TranscriptSegment(start_time_ms=0, end_time_ms=3500, text="Packaged caption test")])
        asyncio.run(RenderingService().render_clip(request))
        probe = json.loads(subprocess.check_output([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)], timeout=15))
        video = next(s for s in probe["streams"] if s["codec_type"] == "video")
        audio = next(s for s in probe["streams"] if s["codec_type"] == "audio")
        assert video["codec_name"] == "h264", video["codec_name"]
        assert audio["codec_name"] == "aac", audio["codec_name"]
        assert 1.9 <= float(probe["format"]["duration"]) <= 2.2, probe["format"]["duration"]
        assert abs(float(video.get("start_time", 0)) - float(audio.get("start_time", 0))) < 0.1
    print("Packaged H.264, captions, speed, audio, framing model and downloader passed")


if __name__ == "__main__":
    main()
