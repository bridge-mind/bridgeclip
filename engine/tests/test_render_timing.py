"""The export guard must fail closed when media timing cannot be verified."""

import asyncio
import json
import os
import threading
from types import SimpleNamespace

import pytest

from clip_engine.services import rendering_service as module
from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.layout_renderer import build_layout_graph
from clip_engine.services.rendering_service import RenderingError, RenderingService


def stream(kind, start="0", duration="10"):
    return {"codec_type": kind, "start_time": start, "duration": duration}


@pytest.mark.parametrize("streams", [
    [], [stream("video")], [stream("audio")],
    [stream("video"), stream("audio", start="0.3")],
    [stream("video", start="0.066"), stream("audio")],
    [stream("video", duration="9"), stream("audio")],
    [stream("video"), stream("audio", duration="9")],
    [stream("video"), stream("audio", duration="nan")],
    [stream("video"), stream("audio", start="inf")],
    [stream("video"), {"codec_type": "audio"}],
    [stream("video"), stream("audio"), stream("audio")],
])
def test_rejects_unusable_exports(monkeypatch, streams):
    monkeypatch.setattr(module, "run_media", lambda *a, **kw: SimpleNamespace(
        returncode=0, stdout=json.dumps({"streams": streams}).encode(),
    ))
    service = RenderingService.__new__(RenderingService)
    with pytest.raises(RenderingError, match="timing validation failed"):
        asyncio.run(service._validate_output_timing("output.mp4", 10000, "30", True))


@pytest.mark.parametrize("with_audio,fps,video_duration,audio_duration", [
    (True, "30", "10", "10.020"), (False, "30", "10", "10"),
    (True, "30000/1001", "10.010", "10"),
    # Audio one frame short at the tail (seen on real 29.97 fps exports).
    (True, "30000/1001", "10", "9.967"),
])
def test_accepts_codec_and_frame_rounding(monkeypatch, with_audio, fps, video_duration, audio_duration):
    streams = [stream("video", duration=video_duration)]
    if with_audio:
        streams.append(stream("audio", duration=audio_duration))
    monkeypatch.setattr(module, "run_media", lambda *a, **kw: SimpleNamespace(
        returncode=0, stdout=json.dumps({"streams": streams}).encode(),
    ))
    service = RenderingService.__new__(RenderingService)
    asyncio.run(service._validate_output_timing("output.mp4", 10000, fps, with_audio))


def test_failed_probe_does_not_silently_drop_audio(monkeypatch):
    monkeypatch.setattr(module, "run_media", lambda *a, **kw: SimpleNamespace(returncode=1, stdout=b""))
    service = RenderingService.__new__(RenderingService)
    with pytest.raises(RenderingError, match="source audio"):
        asyncio.run(service._has_audio("source.mp4"))


@pytest.mark.parametrize("encoder_failure", [False, True])
def test_failed_export_is_removed_before_fallback(monkeypatch, tmp_path, encoder_failure):
    output = tmp_path / "clip.mp4"
    service = RenderingService.__new__(RenderingService)
    service._video_codec_args = lambda *a: []

    async def encode(_):
        output.write_bytes(b"broken media")
        if encoder_failure:
            raise RenderingError("FFmpeg failed")

    async def reject(*_):
        raise RenderingError("Export timing validation failed")

    monkeypatch.setattr(service, "_run_cmd", encode)
    monkeypatch.setattr(service, "_validate_output_timing", reject)
    with pytest.raises(RenderingError):
        asyncio.run(service._run_ffmpeg_complex("source.mp4", str(output), 0, 10000, "graph"))
    assert not output.exists()


def test_empty_edit_is_not_replaced_with_entire_source():
    plan = ClipLayoutPlan([ShotLayout(0, 1000, LayoutType.TALKING_HEAD)], 64, 64)
    with pytest.raises(ValueError, match="no video"):
        build_layout_graph(plan, 64, 64, keeps=[])


def test_short_filter_graph_stays_inline(monkeypatch):
    graph = "[0:v]null[out]"
    seen = []

    def run_media(cmd):
        seen.append(cmd)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(module, "run_media", run_media)
    service = RenderingService.__new__(RenderingService)
    asyncio.run(service._run_cmd(["ffmpeg", "-filter_complex", graph]))
    assert seen == [["ffmpeg", "-filter_complex", graph]]


@pytest.mark.parametrize("fail", [False, True])
def test_large_filter_graph_uses_private_script_and_cleans_up(monkeypatch, fail):
    graph = "[0:v]" + "null," * 2000 + "null[out]"
    seen = []

    def run_media(cmd):
        assert cmd[1] == "-/filter_complex"
        script_path = cmd[2]
        seen.append(script_path)
        with open(script_path, encoding="utf-8") as script:
            assert script.read() == graph
        if os.name != "nt":
            assert os.stat(script_path).st_mode & 0o077 == 0
        if fail:
            raise RuntimeError("FFmpeg launch failed")
        return SimpleNamespace(returncode=0, stderr=b"")

    monkeypatch.setattr(module, "run_media", run_media)
    service = RenderingService.__new__(RenderingService)
    if fail:
        with pytest.raises(RuntimeError, match="FFmpeg launch failed"):
            asyncio.run(service._run_cmd(["ffmpeg", "-filter_complex", graph]))
    else:
        asyncio.run(service._run_cmd(["ffmpeg", "-filter_complex", graph]))
    assert len(seen) == 1
    assert not os.path.exists(seen[0])


@pytest.mark.parametrize("legacy_succeeds", [True, False])
def test_large_filter_graph_retries_only_unsupported_file_option(monkeypatch, legacy_succeeds):
    graph = "null," * 2000
    seen = []

    def run_media(cmd):
        seen.append((cmd[1], cmd[2]))
        assert os.path.isfile(cmd[2])
        if cmd[1] == "-/filter_complex":
            return SimpleNamespace(returncode=1, stderr=(
                b"Unrecognized option '/filter_complex'.\n"
                b"Error splitting the argument list: Option not found"
            ))
        assert cmd[1] == "-filter_complex_script"
        return SimpleNamespace(returncode=0 if legacy_succeeds else 1, stderr=b"Invalid graph")

    monkeypatch.setattr(module, "run_media", run_media)
    service = RenderingService.__new__(RenderingService)
    if legacy_succeeds:
        asyncio.run(service._run_cmd(["ffmpeg", "-filter_complex", graph]))
    else:
        with pytest.raises(RenderingError, match="Invalid graph"):
            asyncio.run(service._run_cmd(["ffmpeg", "-filter_complex", graph]))
    assert [option for option, _ in seen] == ["-/filter_complex", "-filter_complex_script"]
    assert seen[0][1] == seen[1][1]
    assert not os.path.exists(seen[0][1])


def test_large_filter_graph_does_not_retry_render_failures(monkeypatch):
    graph = "null," * 2000
    seen = []

    def run_media(cmd):
        seen.append(cmd)
        assert os.path.isfile(cmd[2])
        return SimpleNamespace(returncode=1, stderr=b"A filter failed")

    monkeypatch.setattr(module, "run_media", run_media)
    service = RenderingService.__new__(RenderingService)
    with pytest.raises(RenderingError, match="A filter failed"):
        asyncio.run(service._run_cmd(["ffmpeg", "-filter_complex", graph]))
    assert len(seen) == 1
    assert not os.path.exists(seen[0][2])


def test_cancelled_large_filter_graph_stays_until_worker_finishes(monkeypatch):
    graph = "null," * 2000
    started = threading.Event()
    release = threading.Event()
    seen = []

    def run_media(cmd):
        seen.append(cmd[2])
        started.set()
        assert release.wait(5), "test did not release the FFmpeg worker"
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(module, "run_media", run_media)
    service = RenderingService.__new__(RenderingService)

    async def check():
        task = asyncio.create_task(service._run_cmd(["ffmpeg", "-filter_complex", graph]))
        try:
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert os.path.isfile(seen[0]), "FFmpeg still needs the script after cancellation"
        finally:
            release.set()
        for _ in range(100):
            if not os.path.exists(seen[0]):
                break
            await asyncio.sleep(0.01)
        assert not os.path.exists(seen[0])

    asyncio.run(check())
