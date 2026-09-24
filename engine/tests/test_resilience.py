"""
Resilience: a failed smart render falls back to the letterbox, and one failed
clip doesn't fail the whole job.
"""

import asyncio
import errno
import json
import os
from types import SimpleNamespace

from clip_engine.services import ai_clipping_pipeline as pipeline_module
from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
from clip_engine.services.intelligence_planner import ClipPlanResponse, ClipPlanSegment
from clip_engine.services.layout_analyzer import Box, ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.rendering_service import RenderingError, RenderingService, RenderRequest, RenderResult
from clip_engine.services.transcription_service import TranscriptionResult, TranscriptSegment, TranscriptWord
from clip_engine.services.s3_upload_service import ClipArtifact, JobOutput


def test_failed_smart_render_falls_back_to_letterbox(monkeypatch, tmp_path):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    service = RenderingService()

    async def dims(_path):
        return 1920, 1080

    async def no_audio(_path):
        return False

    async def two_shot_plan(video, start, window_ms, w, h, style):
        return ClipLayoutPlan(
            shots=[ShotLayout(0, window_ms, LayoutType.TWO_SHOT,
                              people=[Box(0.2, 0.3, 0.1, 0.2), Box(0.7, 0.3, 0.1, 0.2)])],
            source_width=w, source_height=h,
        )

    graphs = []

    async def flaky_ffmpeg(**kwargs):
        graphs.append(kwargs["filter_complex"])
        if len(graphs) == 1:
            raise RenderingError("FFmpeg failed: synthetic")
        open(kwargs["output_path"], "wb").write(b"mp4")

    monkeypatch.setattr(service, "_get_video_dimensions", dims)
    monkeypatch.setattr(service, "_has_audio", no_audio)
    monkeypatch.setattr(service.layout_analyzer, "analyze", two_shot_plan)
    monkeypatch.setattr(service, "_run_ffmpeg_complex", flaky_ffmpeg)

    result = asyncio.run(service.render_clip(RenderRequest(
        video_path="in.mp4", output_path=str(tmp_path / "clip.mp4"),
        start_time_ms=10_000, end_time_ms=20_000, source_width=1920, source_height=1080,
    )))
    assert len(graphs) == 2
    assert "vstack" in graphs[0] and "vstack" not in graphs[1]
    assert result.layout_type == "fit"


def test_one_failed_clip_does_not_fail_the_job(monkeypatch, tmp_path):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))

    pipeline = AIClippingPipeline()
    pipeline.local_mode = True

    async def download(url, output_dir):
        meta = SimpleNamespace(title="Test", duration_seconds=300.0, width=1920, height=1080)
        return SimpleNamespace(video_path=str(tmp_path / "src.mp4"), metadata=meta, file_size_bytes=1)

    async def transcribe(video_path, work_dir, keyterms=None, **_range):
        words = [TranscriptWord("hi", 0, 500)]
        return TranscriptionResult(segments=[TranscriptSegment(0, 500, "hi", words=words)], full_text="hi")

    async def plan(**kwargs):
        segments = [ClipPlanSegment(i * 60_000, i * 60_000 + 30_000, 0.9 - i * 0.1) for i in range(3)]
        return ClipPlanResponse(segments=segments, total_clips=3)

    async def render(request: RenderRequest):
        if request.start_time_ms == 60_000:
            raise RenderingError("FFmpeg failed: synthetic")
        open(request.output_path, "wb").write(b"mp4")
        if request.start_time_ms == 0:
            return RenderResult(output_path=request.output_path, file_size_bytes=3,
                                duration_ms=28_000, layout_type="talking_head")
        return RenderResult(output_path=request.output_path, file_size_bytes=3, duration_ms=27_000,
                            layout_type="fit", render_fallback="letterbox")

    monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
    monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
    monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", plan)
    monkeypatch.setattr(pipeline.rendering_service, "render_clip", render)
    monkeypatch.setattr(settings.__class__, "temp_directory", property(lambda self: str(tmp_path / "work")))
    completed_outputs = []
    monkeypatch.setattr(pipeline, "_update_progress", lambda *args, **kwargs: completed_outputs.append(kwargs["output"]) if kwargs.get("output") else None)

    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url="local.mp4", job_id="job1")))

    assert result.status == JobStatus.COMPLETED, result.error
    assert not (tmp_path / "work" / "job1").exists()
    assert (tmp_path / "out" / "job1" / "job_output.json").exists()
    clips = result.output.clips
    assert [c.clip_index for c in clips] == [0, 1]
    # Durations follow the surviving clips (clip 3 became output #2).
    assert [c.duration_ms for c in clips] == [28_000, 27_000]
    assert result.output.metrics["failed_clip_count"] == 1
    # Layout records are renumbered with their clips, and the fallback reaches the clip.
    layouts = result.output.metrics["clip_layouts"]
    assert [(c["clip_index"], c["layout_type"]) for c in layouts] == [(0, "talking_head"), (1, "fit")]
    assert [c.render_fallback for c in clips] == [None, "letterbox"]
    assert completed_outputs[0]["clips"][1]["render_fallback"] == "letterbox"
    assert result.output.metrics["requested_settings"]["layout_style"] == "auto"
    assert [c["framing_status"] for c in layouts] == ["smart", "fallback"]
    json.dumps(result.output.metrics)  # metrics stay JSON-serializable


def test_saved_local_clips_complete_when_final_bookkeeping_fails(monkeypatch, tmp_path):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(settings.__class__, "temp_directory", property(lambda self: str(tmp_path / "work")))
    pipeline = AIClippingPipeline()
    pipeline.local_mode = True

    async def download(url, output_dir):
        meta = SimpleNamespace(title="Test", duration_seconds=30.0, width=1920, height=1080)
        return SimpleNamespace(video_path=str(tmp_path / "source.mp4"), metadata=meta, file_size_bytes=1)

    async def transcribe(video_path, work_dir, keyterms=None, **_range):
        words = [TranscriptWord("hi", 0, 500)]
        return TranscriptionResult(segments=[TranscriptSegment(0, 500, "hi", words=words)], full_text="hi")

    async def plan(**kwargs):
        segments = [ClipPlanSegment(0, 20_000, 0.8)]
        return ClipPlanResponse(segments=segments, total_clips=1)

    async def render(request):
        open(request.output_path, "wb").write(b"mp4")
        return RenderResult(output_path=request.output_path, file_size_bytes=3, duration_ms=20_000)

    def memory(stage, job_id):
        if stage == "before_manifest_upload":
            raise RuntimeError("synthetic final bookkeeping failure")
        return {"rss": 0.0}

    monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
    monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
    monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", plan)
    monkeypatch.setattr(pipeline.rendering_service, "render_clip", render)
    monkeypatch.setattr(pipeline_module, "log_memory_usage", memory)

    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url="local.mp4", job_id="job1")))
    manifest = json.loads((tmp_path / "out" / "job1" / "job_output.json").read_text())
    assert result.status == JobStatus.COMPLETED
    assert result.output.total_clips == 1
    assert manifest["total_clips"] == 1
    assert (tmp_path / "out" / "job1" / "clip_00.mp4").read_bytes() == b"mp4"


def test_local_manifest_write_is_atomic_and_preserves_previous_result(monkeypatch, tmp_path):
    pipeline = AIClippingPipeline.__new__(AIClippingPipeline)
    pipeline.settings = SimpleNamespace(local_output_dir=str(tmp_path))
    manifest = tmp_path / "job1" / "job_output.json"

    pipeline._save_local_json("job1", "job_output", {"job_id": "first"})
    assert json.loads(manifest.read_text())["job_id"] == "first"
    assert not list(manifest.parent.glob(".job_output.*.tmp"))

    def fail_after_partial_write(data, stream, **kwargs):
        stream.write('{"partial":')
        raise RuntimeError("synthetic write failure")

    monkeypatch.setattr(pipeline_module.json, "dump", fail_after_partial_write)
    try:
        pipeline._save_local_json("job1", "job_output", {"job_id": "second"})
    except RuntimeError:
        pass
    else:
        assert False, "Expected JSON write failure"

    assert json.loads(manifest.read_text())["job_id"] == "first"
    assert not list(manifest.parent.glob(".job_output.*.tmp"))


def test_local_clips_link_on_same_volume_and_copy_across_volumes(monkeypatch, tmp_path):
    pipeline = AIClippingPipeline.__new__(AIClippingPipeline)
    pipeline.settings = SimpleNamespace(local_output_dir=str(tmp_path / "out"))
    segment = ClipPlanSegment(0, 1000, 0.8)
    source = tmp_path / "rendered.mp4"
    source.write_bytes(b"rendered clip")

    pipeline._save_clips_locally("linked", [(str(source), segment)])
    linked = tmp_path / "out" / "linked" / "clip_00.mp4"
    assert os.stat(source).st_ino == os.stat(linked).st_ino
    source.unlink()
    assert linked.read_bytes() == b"rendered clip"

    source.write_bytes(b"copied clip")

    def cross_volume(_source, _destination):
        raise OSError(errno.EXDEV, "Different filesystem")

    monkeypatch.setattr(pipeline_module.os, "link", cross_volume)
    pipeline._save_clips_locally("copied", [(str(source), segment)])
    copied = tmp_path / "out" / "copied" / "clip_00.mp4"
    assert copied.read_bytes() == b"copied clip"
    assert os.stat(source).st_ino != os.stat(copied).st_ino


