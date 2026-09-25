"""Real local child processes verify limits and cleanup without provider calls."""
import asyncio
from contextlib import contextmanager
import io
import json
import os
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from clip_engine.services.media_process import MediaProcessError, run_media, validate_video_dimensions
from clip_engine.services.layout_analyzer import analysis_dimensions, LayoutAnalyzer, MAX_ANALYSIS_DURATION_MS
from clip_engine.services.transcription_service import TranscriptionService, TranscriptionError
from clip_engine.services.video_downloader import VideoDownloaderService, VideoDownloadError


def test_tool_output_and_exit_status():
    result = run_media([sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'out\\n'); sys.stderr.write('err'); sys.exit(3)"])
    assert result.stdout == b"out\n" and result.stderr == b"err" and result.returncode == 3


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_output_limit_kills_noisy_process(stream):
    start = time.monotonic()
    with pytest.raises(MediaProcessError, match="size limit"):
        run_media([sys.executable, "-c", f"import sys,time; sys.{stream}.write('x'*100000); sys.{stream}.flush(); time.sleep(30)"],
                  max_output=1024, timeout=5)
    assert time.monotonic() - start < 5


def test_deadline_kills_and_reaps_tool(tmp_path):
    pid_file = tmp_path / "pid"
    with pytest.raises(MediaProcessError, match="time limit"):
        run_media([sys.executable, "-c",
                   "import os,time,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)",
                   str(pid_file)], timeout=1)
    pid = int(pid_file.read_text())
    if os.name == "posix":
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


def test_media_child_does_not_inherit_provider_keys(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "dummy-test-secret")
    result = run_media([sys.executable, "-c", "import os; print('OPENROUTER_API_KEY' in os.environ)"])
    assert result.stdout.strip() == b"False"


@pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")
def test_media_child_preserves_desktop_cancellation_group():
    result = run_media([sys.executable, "-c", "import os; print(os.getpgrp())"])
    assert int(result.stdout) == os.getpgrp()


@pytest.mark.parametrize("dimensions", [(0, 100), (100, 0), (1, 16000), (20000, 1), (16384, 16384)])
def test_extreme_dimensions_rejected(dimensions):
    with pytest.raises(ValueError):
        validate_video_dimensions(*dimensions)
    with pytest.raises(ValueError):
        analysis_dimensions(*dimensions)


@pytest.mark.parametrize("dimensions", [(3840, 2160), (2160, 3840), (7680, 4320), (128, 4096)])
def test_supported_analysis_dimensions_remain_bounded(dimensions):
    width, height = analysis_dimensions(*dimensions)
    assert 2 <= width <= 640 and 2 <= height <= 1280
    assert width % 2 == height % 2 == 0


def test_layout_rejects_unbounded_window_before_spawning():
    analyzer = LayoutAnalyzer.__new__(LayoutAnalyzer)
    with pytest.raises(MediaProcessError, match="window"):
        analyzer._decode_and_detect("unused.mp4", 0, MAX_ANALYSIS_DURATION_MS + 1, 1920, 1080)


@pytest.mark.parametrize("case", ["partial", "frames", "keyframes"])
def test_layout_rejects_partial_or_excessive_decoded_output(monkeypatch, case):
    from clip_engine.services import layout_analyzer as module
    frame_size = 640 * 64 * 3
    raw = b"x" if case == "partial" else bytes(frame_size * 6)
    @contextmanager
    def fake_process(*args, **kwargs):
        yield SimpleNamespace(stdout=io.BytesIO(raw), returncode=0), bytearray()
    monkeypatch.setattr(module, "media_process", fake_process)
    if case == "keyframes":
        monkeypatch.setattr(module, "MAX_KEYFRAME_BYTES", 1)
    analyzer = LayoutAnalyzer.__new__(LayoutAnalyzer)
    monkeypatch.setattr(analyzer, "_get_detector", lambda *_: SimpleNamespace(detect=lambda _: (None, None)))
    with pytest.raises(MediaProcessError, match={"partial": "Incomplete", "frames": "frame limit", "keyframes": "keyframes"}[case]):
        analyzer._decode_and_detect("unused.mp4", 0, 1000, 640, 64)


def test_metadata_rejects_extreme_geometry(monkeypatch):
    downloader = VideoDownloaderService.__new__(VideoDownloaderService)
    raw = json.dumps({"streams": [{"codec_type": "video", "width": 1, "height": 16000}],
                      "format": {"duration": 10}}).encode()
    monkeypatch.setattr(downloader, "_run_ffprobe_sync", lambda _: (0, raw, b""))
    with pytest.raises(VideoDownloadError, match="Invalid video metadata"):
        asyncio.run(downloader._get_video_metadata_ffprobe("unused.mp4"))


def test_audio_error_fallback_rejects_disguised_playlist(tmp_path, monkeypatch):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("FFmpeg tools required")
    audio = tmp_path / "private.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.1", str(audio)],
                   check=True, timeout=10, capture_output=True)
    playlist = tmp_path / "source.mp4"
    playlist.write_text("ffconcat version 1.0\nfile 'private.wav'\n")
    service = TranscriptionService.__new__(TranscriptionService)
    probe_results = []
    def checked_run(command, **kwargs):
        result = run_media(command, **kwargs)
        if command[0] == "ffprobe":
            probe_results.append(result.returncode)
        return result
    monkeypatch.setattr("clip_engine.services.transcription_service.run_media", checked_run)
    with pytest.raises(TranscriptionError, match="Failed to extract"):
        asyncio.run(service._extract_audio_from_video(str(playlist), str(tmp_path / "out.m4a")))
    assert probe_results and all(code != 0 for code in probe_results)
