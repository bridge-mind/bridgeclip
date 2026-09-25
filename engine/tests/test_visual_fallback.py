"""Offline coverage for visual-only planning when speech is unavailable."""

import asyncio
import json
from types import SimpleNamespace

from PIL import Image
import pytest

from clip_engine.services import ai_clipping_pipeline as pipeline_module
from clip_engine.services import visual_clip_sampling
from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
from clip_engine.services.intelligence_planner import ClipPlanResponse, ClipPlanSegment, IntelligencePlannerService, VisionFrame
from clip_engine.services.rendering_service import RenderResult, RenderingService
from clip_engine.services.transcription_service import NoAudioTrackError, TranscriptionProviderError, TranscriptionResult, TranscriptionService


def test_visual_sampler_bounds_count_and_selected_range(monkeypatch, tmp_path):
    called = []

    def fake_sample(video_path, output, timestamp):
        called.append(timestamp)
        output.write_bytes(b"j" * 1200)
        return True

    monkeypatch.setattr(visual_clip_sampling, "_sample_one", fake_sample)
    frames = asyncio.run(visual_clip_sampling.sample_visual_planning_frames(
        "source.mp4", 3_600, str(tmp_path), 120, 240,
    ))
    assert len(frames) == 8
    assert all(120_000 < frame.timestamp_ms < 240_000 for frame in frames)
    assert len(called) == len(frames)

    long_frames = asyncio.run(visual_clip_sampling.sample_visual_planning_frames(
        "source.mp4", 3_600, str(tmp_path),
    ))
    assert len(long_frames) == visual_clip_sampling.MAX_PLANNING_FRAMES
    times = [frame.timestamp_ms / 1000 for frame in long_frames]
    assert times == sorted(times)
    assert all(0 < second < 3_600 for second in times)
    assert sum(right - left <= 45 for left, right in zip(times, times[1:])) >= 16


def test_visual_change_gate_rejects_still_frames(tmp_path):
    frames = []
    for index, shade in enumerate((32, 32, 32)):
        path = tmp_path / f"still_{index}.jpg"
        Image.new("RGB", (64, 36), (shade, shade, shade)).save(path)
        frames.append(VisionFrame(index * 1000, str(path), 64, 36))
    assert visual_clip_sampling.has_visual_change(frames) is False

    changed = tmp_path / "changed.jpg"
    Image.new("RGB", (64, 36), (200, 200, 200)).save(changed)
    frames[-1] = VisionFrame(2000, str(changed), 64, 36)
    assert visual_clip_sampling.has_visual_change(frames) is True


def test_visual_change_requires_nearby_frames(tmp_path):
    frames = []
    for index, (second, shade) in enumerate(((10, 32), (20, 32), (2_000, 200))):
        path = tmp_path / f"distant_{index}.jpg"
        Image.new("RGB", (64, 36), (shade, shade, shade)).save(path)
        frames.append(VisionFrame(second * 1000, str(path), 64, 36))
    assert visual_clip_sampling.has_visual_change(frames) is False


def test_no_audio_track_is_confirmed_before_visual_fallback(monkeypatch, tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    calls = []

    def fake_run(command, **kwargs):
        calls.append(command[0])
        return SimpleNamespace(returncode=1 if command[0] == "ffmpeg" else 0,
                               stdout=b"", stderr=b"No output stream")

    monkeypatch.setattr("clip_engine.services.transcription_service.run_media", fake_run)
    service = TranscriptionService.__new__(TranscriptionService)
    with pytest.raises(NoAudioTrackError):
        asyncio.run(service._extract_audio_from_video(str(source), str(tmp_path / "audio.mp3")))
    assert calls == ["ffmpeg", "ffprobe"]


@pytest.mark.parametrize("status, reason", [(401, "auth"), (429, "rate_limit"), (None, "network")])
def test_provider_errors_are_classified_without_exposing_response(monkeypatch, tmp_path, status, reason):
    import httpx

    source = tmp_path / "audio.mp3"
    source.write_bytes(b"audio")

    def respond(request):
        if status is None:
            raise httpx.ConnectError("private provider response", request=request)
        return httpx.Response(status, json={"error": "private provider response"})

    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport, **kwargs))
    service = TranscriptionService.__new__(TranscriptionService)
    service.settings = SimpleNamespace(openrouter_api_key="test-key", transcription_diarize=True)
    with pytest.raises(TranscriptionProviderError) as raised:
        asyncio.run(service._request_transcript(str(source), None, None))
    assert raised.value.reason == reason
    assert "private provider response" not in str(raised.value)


def test_visual_only_planner_uses_duration_and_rejects_unsupported_clip(monkeypatch, tmp_path):
    planner = IntelligencePlannerService()
    frames = []
    for index, second in enumerate((10, 20, 30, 40)):
        path = tmp_path / f"{index}.jpg"
        path.write_bytes(b"j" * 1200)
        frames.append(VisionFrame(second * 1000, str(path), 512, 288))

    messages_seen = []

    async def fake_call(**kwargs):
        messages_seen.extend(kwargs["messages"])
        body = json.dumps({"insights": "Visual demonstration", "clips": [
            {"start_time": 10, "end_time": 40, "summary": "Visible Result", "emphasis": ["invented"]},
            {"start_time": 45, "end_time": 75, "summary": "Unsupported Result"},
        ]})
        return ({"choices": [{"message": {"content": body}, "finish_reason": "stop"}]},
                {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20, "cost": 0.01})

    monkeypatch.setattr(planner, "_call_openrouter", fake_call)
    result = asyncio.run(planner.plan_clips(
        TranscriptionResult(segments=[], full_text=""),
        video_metadata=SimpleNamespace(duration_seconds=60), frames=frames,
        min_duration_seconds=15, max_duration_seconds=45,
    ))
    assert len(result.segments) == 1
    assert (result.segments[0].start_time_ms, result.segments[0].end_time_ms) == (10_000, 40_000)
    assert result.segments[0].emphasis_words == []
    assert "No usable speech transcript" in messages_seen[1]["content"][0]["text"]
    assert "approximately 60 seconds" in messages_seen[1]["content"][0]["text"]


@pytest.mark.parametrize("no_audio", [False, True])
@pytest.mark.parametrize("speed", [1, 1.5])
@pytest.mark.parametrize("trim", [(None, None, 60), (10, 50, 40), (10, 90, 50)])
def test_visual_fallback_completes_without_captions_and_discloses_status(monkeypatch, tmp_path, no_audio, speed, trim):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(type(settings), "temp_directory", property(lambda self: str(tmp_path / "work")))
    pipeline = AIClippingPipeline()
    pipeline.local_mode = True

    async def download(url, output_dir):
        return SimpleNamespace(
            video_path=str(tmp_path / "source.mp4"), file_size_bytes=1,
            metadata=SimpleNamespace(title="Silent demo", duration_seconds=60, width=1920, height=1080),
        )

    async def transcribe(video_path, work_dir, keyterms=None, **_range):
        if no_audio:
            raise NoAudioTrackError("no audio stream")
        return TranscriptionResult(segments=[], full_text="")

    async def sample(*args):
        return [VisionFrame(t * 1000, "sample.jpg", 512, 288) for t in (10, 20, 30)]

    async def plan(**kwargs):
        assert len(kwargs["frames"]) == 3
        assert not kwargs["transcript_result"].segments
        return ClipPlanResponse([ClipPlanSegment(t, t + 20_000, 0.8, summary="Visible action") for t in (10_000, 30_000)], total_clips=2)

    async def render(request):
        assert request.video_speed == speed
        assert request.include_captions is False
        assert request.transcript_segments == []
        with open(request.output_path, "wb") as output:
            output.write(b"mp4")
        return RenderResult(request.output_path, 3, round(20_000 / speed), layout_type="fit")

    monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
    monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
    monkeypatch.setattr(pipeline_module, "sample_visual_planning_frames", sample)
    monkeypatch.setattr(pipeline_module, "has_visual_change", lambda frames: True)
    monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", plan)
    monkeypatch.setattr(pipeline.rendering_service, "render_clip", render)

    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url="x", job_id="visual-test", video_speed=speed, start_time_seconds=trim[0], end_time_seconds=trim[1])))
    assert result.status == JobStatus.COMPLETED
    assert result.output.metrics["transcription_status"] == "no_speech"
    assert result.output.metrics["planning_source"] == "visual"
    assert result.output.metrics["requested_settings"]["video_speed"] == speed
    assert result.output.metrics["analysis_duration_seconds"] == trim[2]
    assert len(result.output.clips) == 2
    assert all(clip.duration_ms == round(20_000 / speed) for clip in result.output.clips)
    assert result.output.metrics["captions_status"] == "unavailable_without_transcript"
    transcript = json.loads((tmp_path / "out" / "visual-test" / "transcript.json").read_text())
    assert transcript["captions_available"] is False


@pytest.mark.parametrize("reason, expected", [
    ("auth", "Transcription authentication failed"),
    ("quota", "Transcription account credit limit reached"),
    ("network", "Transcription service unavailable"),
])
def test_provider_failure_stops_before_visual_planning(monkeypatch, tmp_path, reason, expected):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(type(settings), "temp_directory", property(lambda self: str(tmp_path / "work")))
    pipeline = AIClippingPipeline()
    pipeline.local_mode = True

    async def download(url, output_dir):
        return SimpleNamespace(
            video_path=str(tmp_path / "source.mp4"), file_size_bytes=1,
            metadata=SimpleNamespace(title="Demo", duration_seconds=60, width=1920, height=1080),
        )

    async def transcribe(**kwargs):
        raise TranscriptionProviderError(reason)

    async def forbidden(*args, **kwargs):
        pytest.fail("provider failure must not trigger paid visual planning")

    monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
    monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
    monkeypatch.setattr(pipeline_module, "sample_visual_planning_frames", forbidden)
    monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", forbidden)
    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url="x", job_id=f"provider-{reason}")))
    assert result.status == JobStatus.FAILED
    assert result.error == expected
