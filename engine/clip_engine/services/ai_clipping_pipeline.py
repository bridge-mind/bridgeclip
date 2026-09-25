"""
AI Clipping Pipeline - Orchestrator for the AI clipping workflow.

Pipeline stages:
1. Video download (YouTube via yt-dlp, S3, or direct URL)
2. Audio extraction and transcription (MAI Transcribe 2 through OpenRouter)
3. Intelligence planning (frontier LLM via OpenRouter)
4. Clip rendering (smart per-shot 9:16 framing with captions)
5. S3 upload (parallel uploads)
"""

import asyncio
import errno
import json
import logging
import os
import re
import shutil
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, Callable, Optional

from clip_engine.config import CaptionStyle, LayoutStyle, get_settings, is_longform, resolve_clip_duration_bounds
from clip_engine.services.video_speed import validate_video_speed
from clip_engine.error_policy import safe_failure_code, safe_processing_error
from clip_engine.services.intelligence_planner import (
    ClipPlanResponse,
    ClipPlanSegment,
    IntelligencePlannerService,
)
from clip_engine.services.memory_monitor import (
    force_gc,
    log_memory_usage,
)
from clip_engine.services.rendering_service import (
    RenderRequest,
    RenderResult,
    RenderingService,
)
from clip_engine.services.s3_upload_service import (
    ClipArtifact,
    JobOutput,
    S3UploadService,
    UploadResult,
)
from clip_engine.services.transcription_service import (
    NoAudioTrackError,
    TranscriptionResult,
    TranscriptionService,
)
from clip_engine.services.visual_clip_sampling import has_visual_change, sample_visual_planning_frames
from clip_engine.services.video_downloader import (
    DownloadResult,
    VideoDownloaderService,
)
from clip_engine.services.webhook_service import (
    WebhookService,
    get_webhook_service,
)

logger = logging.getLogger(__name__)


class JobStatus(str, Enum):
    """Status of an AI clipping job."""

    PENDING = "pending"
    DOWNLOADING = "downloading"
    TRANSCRIBING = "transcribing"
    PLANNING = "planning"
    RENDERING = "rendering"
    UPLOADING = "uploading"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class ClippingJobRequest:
    """Request to process a video for AI clipping."""

    video_url: str
    job_id: Optional[str] = None
    external_job_id: Optional[str] = None
    owner_user_id: Optional[str] = None
    max_clips: Optional[int] = None
    auto_clip_count: bool = True
    # Explicit bounds; selected duration_ranges take precedence and the
    # planner falls back to 15-90 s (see resolve_clip_duration_bounds).
    min_clip_duration_seconds: Optional[int] = None
    max_clip_duration_seconds: Optional[int] = None
    duration_ranges: Optional[list[str]] = None
    target_platform: str = "tiktok"
    include_captions: bool = True
    caption_style: Optional[CaptionStyle] = None
    callback_url: Optional[str] = None
    start_time_seconds: Optional[float] = None
    end_time_seconds: Optional[float] = None
    banner_platform: Optional[str] = None
    banner_channel_url: Optional[str] = None
    aspect_ratio: str = "9:16"
    keyterms: Optional[list[str]] = None
    layout_style: str = LayoutStyle.AUTO
    # "tight" cuts dead air and filler words; "natural" keeps original timing.
    pacing: str = "tight"
    video_speed: float = 1.0

    def __post_init__(self):
        validate_video_speed(self.video_speed)
        if self.job_id is None:
            self.job_id = str(uuid.uuid4())
        if not isinstance(self.job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", self.job_id):
            raise ValueError("Invalid job ID")


@dataclass
class ClippingJobProgress:
    """Progress update for a clipping job."""

    job_id: str
    status: JobStatus
    progress_percent: float
    current_step: str
    clips_completed: int = 0
    total_clips: int = 0
    error: Optional[str] = None


@dataclass
class ClippingJobResult:
    """Final result of a clipping job."""

    job_id: str
    status: JobStatus
    output: Optional[JobOutput] = None
    error: Optional[str] = None
    processing_time_seconds: float = 0
    failure_code: Optional[str] = None
    failure_stage: Optional[str] = None
    http_status: Optional[int] = None


class AIClippingPipeline:
    """
    Pipeline for AI-powered video clipping.

    Orchestrates: download -> transcribe -> plan -> render (smart framing) -> upload
    """

    def __init__(
        self,
        progress_callback: Optional[Callable[[ClippingJobProgress], None]] = None,
        webhook_service: Optional[WebhookService] = None,
    ):
        self.settings = get_settings()
        self.progress_callback = progress_callback
        self.webhook_service = webhook_service or get_webhook_service()

        self.video_downloader = VideoDownloaderService()
        self.transcription_service = TranscriptionService()
        self.intelligence_planner = IntelligencePlannerService()
        self.rendering_service = RenderingService()
        self.s3_upload_service = S3UploadService()
        self.local_mode = self.settings.local_mode

        self._current_callback_url: Optional[str] = None
        self._current_external_job_id: Optional[str] = None
        self._current_owner_user_id: Optional[str] = None

    async def process_video(
        self,
        request: ClippingJobRequest,
    ) -> ClippingJobResult:
        """
        Process a video through the full AI clipping pipeline.

        Pipeline: download -> transcribe -> plan -> render (smart framing) -> upload
        """
        start_time = time.time()
        job_id = request.job_id
        work_dir = os.path.join(self.settings.temp_directory, job_id)
        stage_timings: dict[str, float] = {}
        stage_memory_mb: dict[str, float] = {}
        clip_render_durations_seconds: list[float] = []
        clip_upload_durations_seconds: list[float] = []
        clip_layouts: list[dict] = []
        clip_durations_ms: dict[int, int] = {}
        layout_vision_cost = 0.0
        peak_rss_mb = 0.0
        transcription_status = "available"
        visual_frames = []
        saved_local_output: Optional[JobOutput] = None
        current_stage = "setup"

        def capture_memory(stage_name: str) -> dict[str, float]:
            nonlocal peak_rss_mb
            mem = log_memory_usage(stage_name, job_id)
            rss = float(mem.get("rss", 0.0) or 0.0)
            stage_memory_mb[stage_name] = rss
            peak_rss_mb = max(peak_rss_mb, rss)
            return mem

        capture_memory("job_start")

        self._current_callback_url = request.callback_url
        self._current_external_job_id = request.external_job_id
        self._current_owner_user_id = request.owner_user_id

        try:
            os.makedirs(work_dir, mode=0o700, exist_ok=True)
            logger.info(f"Starting AI clipping job: {job_id}")
            logger.info("Video source received")
            logger.info(f"Max clips: {request.max_clips}, Duration ranges: {request.duration_ranges}")
            logger.info(
                f"Include captions: {request.include_captions}, layout style: {request.layout_style}, "
                f"pacing: {request.pacing}"
            )
            logger.info("Webhook configured: %s", bool(self._current_callback_url))

            if request.start_time_seconds is not None or request.end_time_seconds is not None:
                logger.info(
                    f"Time range selection: start={request.start_time_seconds}s, "
                    f"end={request.end_time_seconds}s"
                )

            # Step 1: Download video
            current_stage = "download"
            self._update_progress(job_id, JobStatus.DOWNLOADING, 5, "Downloading video...")
            stage_start = time.perf_counter()
            download_result = await self.video_downloader.download_video(
                url=request.video_url,
                output_dir=work_dir,
            )
            stage_timings["download"] = time.perf_counter() - stage_start
            logger.info(f"Downloaded: {download_result.metadata.title}")

            video_duration = download_result.metadata.duration_seconds
            logger.info(f"Video duration: {video_duration:.1f}s ({video_duration/60:.1f} minutes)")

            effective_end_time = request.end_time_seconds
            if effective_end_time is not None and effective_end_time > video_duration:
                logger.warning(
                    f"end_time_seconds ({effective_end_time}s) exceeds video duration "
                    f"({video_duration:.1f}s), clamping to video end"
                )
                effective_end_time = video_duration
                request.end_time_seconds = effective_end_time

            capture_memory("after_download")

            # Step 2: Transcribe audio
            current_stage = "transcription"
            self._update_progress(job_id, JobStatus.TRANSCRIBING, 15, "Transcribing audio...")
            stage_start = time.perf_counter()
            previous_transcription_progress = getattr(self.transcription_service, "progress_callback", None)
            self.transcription_service.progress_callback = lambda message: self._update_progress(
                job_id, JobStatus.TRANSCRIBING, 15, message,
            )
            try:
                transcription_result = await self.transcription_service.transcribe(
                    video_path=download_result.video_path,
                    work_dir=work_dir,
                    keyterms=request.keyterms,
                    start_seconds=request.start_time_seconds,
                    end_seconds=effective_end_time,
                )
            except NoAudioTrackError:
                logger.info("Source has no audio track; trying visual-only planning")
                transcription_result = TranscriptionResult(segments=[], full_text="", provider="no_audio")
                transcription_status = "no_speech"
            else:
                if not transcription_result.segments:
                    transcription_status = "no_speech"
            finally:
                self.transcription_service.progress_callback = previous_transcription_progress
            stage_timings["transcription"] = time.perf_counter() - stage_start
            logger.info(f"Transcription complete: {len(transcription_result.segments)} segments")

            if transcription_status != "available":
                self._update_progress(job_id, JobStatus.PLANNING, 25, "Analyzing video frames...")
                stage_start = time.perf_counter()
                visual_frames = await sample_visual_planning_frames(
                    download_result.video_path, video_duration, work_dir,
                    request.start_time_seconds, effective_end_time,
                )
                stage_timings["visual_sampling"] = time.perf_counter() - stage_start
                logger.info("Visual-only planning has %s sampled frames", len(visual_frames))
                if not has_visual_change(visual_frames):
                    logger.info("Visual-only planning skipped: insufficient visible change")
                    visual_frames = []

            transcript_data = {
                "segments": [asdict(s) for s in transcription_result.segments],
                "full_text": transcription_result.full_text,
                "language": transcription_result.language,
                "status": transcription_status,
                "captions_available": bool(transcription_result.segments),
            }

            if self.local_mode:
                transcript_url = self._save_local_json(job_id, "transcript", transcript_data)
                transcript_upload = UploadResult(
                    s3_url=transcript_url, bucket="local", key=transcript_url,
                    file_size_bytes=0, content_type="application/json",
                )
            else:
                transcript_upload = await self.s3_upload_service.upload_json_artifact(
                    data=transcript_data,
                    job_id=job_id,
                    artifact_name="transcript",
                    user_id=request.owner_user_id,
                )

            capture_memory("after_transcription")

            # Step 3: Plan clips using AI
            current_stage = "planning"
            self._update_progress(job_id, JobStatus.PLANNING, 30, "Planning viral clips...")
            stage_start = time.perf_counter()
            clip_plan = await self.intelligence_planner.plan_clips(
                transcript_result=transcription_result,
                video_metadata=download_result.metadata,
                max_clips=request.max_clips,
                auto_clip_count=request.auto_clip_count,
                min_duration_seconds=request.min_clip_duration_seconds,
                max_duration_seconds=request.max_clip_duration_seconds,
                duration_ranges=request.duration_ranges,
                target_platform=(
                    "youtube" if request.aspect_ratio == "16:9" and request.target_platform == "tiktok"
                    else request.target_platform
                ),
                frames=visual_frames,
                start_time_seconds=request.start_time_seconds,
                end_time_seconds=request.end_time_seconds,
                aspect_ratio=request.aspect_ratio,
            )
            stage_timings["planning"] = time.perf_counter() - stage_start
            logger.info(f"Planned {len(clip_plan.segments)} clips")
            if not clip_plan.segments:
                raise RuntimeError(
                    "No clip-worthy moments found (visual evidence may be insufficient, "
                    "or the selected time range is too short for the chosen clip length)"
                )

            plan_data = {
                "segments": [asdict(s) for s in clip_plan.segments],
                "total_clips": clip_plan.total_clips,
                "target_platform": clip_plan.target_platform,
                "insights": clip_plan.insights,
                "planning_source": "visual" if visual_frames else "transcript",
            }

            if self.local_mode:
                plan_url = self._save_local_json(job_id, "plan", plan_data)
                plan_upload = UploadResult(
                    s3_url=plan_url, bucket="local", key=plan_url,
                    file_size_bytes=0, content_type="application/json",
                )
            else:
                plan_upload = await self.s3_upload_service.upload_json_artifact(
                    data=plan_data,
                    job_id=job_id,
                    artifact_name="plan",
                    user_id=request.owner_user_id,
                )

            capture_memory("after_planning")

            # Step 4: Render clips (smart framing, parallel)
            current_stage = "rendering"
            clips_dir = os.path.join(work_dir, "clips")
            os.makedirs(clips_dir, exist_ok=True)

            total_clips = len(clip_plan.segments)
            self._update_progress(
                job_id, JobStatus.RENDERING, 50,
                f"Rendering {total_clips} clip{'s' if total_clips != 1 else ''}...",
                clips_completed=0, total_clips=total_clips,
            )

            render_semaphore = asyncio.Semaphore(self.settings.max_concurrent_renders)
            longform = is_longform(request.aspect_ratio, resolve_clip_duration_bounds(
                request.duration_ranges, request.min_clip_duration_seconds, request.max_clip_duration_seconds,
            )[0])
            clips_finished = 0

            async def render_single_clip(i: int, segment: ClipPlanSegment) -> tuple[int, str, ClipPlanSegment]:
                nonlocal layout_vision_cost
                try:
                    return await render_clip_locked(i, segment)
                finally:
                    # Long renders take minutes each: report every finished
                    # (or failed) clip instead of sitting at 50% until all are done.
                    nonlocal clips_finished
                    clips_finished += 1
                    self._update_progress(
                        job_id, JobStatus.RENDERING, 50 + 40 * clips_finished / total_clips,
                        f"Rendered {clips_finished} of {total_clips} clip{'s' if total_clips != 1 else ''}",
                        clips_completed=clips_finished, total_clips=total_clips,
                    )

            async def render_clip_locked(i: int, segment: ClipPlanSegment) -> tuple[int, str, ClipPlanSegment]:
                nonlocal layout_vision_cost
                async with render_semaphore:
                    clip_start = time.perf_counter()
                    output_path = os.path.join(clips_dir, f"clip_{i:02d}.mp4")

                    clip_transcript = self._filter_transcript_for_clip(
                        transcription_result.segments,
                        segment.start_time_ms,
                        segment.end_time_ms,
                    )

                    render_request = RenderRequest(
                        video_path=download_result.video_path,
                        output_path=output_path,
                        start_time_ms=segment.start_time_ms,
                        end_time_ms=segment.end_time_ms,
                        source_width=download_result.metadata.width,
                        source_height=download_result.metadata.height,
                        # Always passed: tight pacing needs word timings even without captions.
                        transcript_segments=clip_transcript,
                        include_captions=request.include_captions and transcription_status == "available",
                        caption_style=request.caption_style,
                        title_text=segment.summary,
                        emphasis_words=segment.emphasis_words,
                        banner_platform=request.banner_platform,
                        banner_channel_url=request.banner_channel_url,
                        aspect_ratio=request.aspect_ratio,
                        layout_style=request.layout_style,
                        pacing=request.pacing,
                        video_speed=request.video_speed,
                        longform=longform,
                        skip_ranges_ms=segment.skip_ranges_ms,
                        chapters=segment.chapters,
                    )

                    render_result = await self.rendering_service.render_clip(render_request)
                    segment.layout_type = render_result.layout_type
                    segment.render_fallback = render_result.render_fallback
                    segment.output_chapters = render_result.chapters
                    segment.subtitle_path = render_result.subtitle_path
                    layout_vision_cost += render_result.layout_cost_usd
                    clip_durations_ms[i] = render_result.duration_ms
                    if render_result.render_fallback:
                        framing_status = "fallback"
                    elif request.aspect_ratio == "16:9" or request.layout_style == LayoutStyle.FIT:
                        framing_status = "classic"
                    elif render_result.layout_type == "fit":
                        framing_status = "whole_frame_auto"
                    else:
                        framing_status = "smart"
                    clip_layouts.append({
                        "clip_index": i,
                        "layout_type": render_result.layout_type,
                        "framing_status": framing_status,
                        "shots": render_result.layout_shots,
                        "pacing_removed_ms": render_result.removed_ms,
                        "render_fallback": render_result.render_fallback,
                    })
                    logger.info(
                        f"Rendered clip {i + 1} ({render_result.layout_type}): "
                        f"{render_result.file_size_bytes / 1024 / 1024:.1f} MB"
                    )
                    clip_render_durations_seconds.append(time.perf_counter() - clip_start)
                    return (i, render_result.output_path, segment)

            render_tasks = [
                render_single_clip(i, segment)
                for i, segment in enumerate(clip_plan.segments)
            ]
            stage_start = time.perf_counter()
            render_results = await asyncio.gather(*render_tasks, return_exceptions=True)
            stage_timings["rendering"] = time.perf_counter() - stage_start

            # One bad clip must not sink the whole job: skip failures, and
            # only fail if nothing rendered.
            failures = [(i, r) for i, r in enumerate(render_results) if isinstance(r, BaseException)]
            successes = sorted(
                (r for r in render_results if not isinstance(r, BaseException)), key=lambda x: x[0],
            )
            for i, error in failures:
                logger.error(f"Clip {i + 1} failed to render, skipping it: {error}")
            if not successes:
                raise failures[0][1]
            rendered_clips = [(path, segment) for _, path, segment in successes]
            # Output clips are renumbered 0..n-1; carry their durations and
            # layout records across so they still line up after a failure.
            new_index = {orig_i: k for k, (orig_i, _, _) in enumerate(successes)}
            clip_durations_ms = {
                new_index[orig_i]: ms for orig_i, ms in clip_durations_ms.items() if orig_i in new_index
            }
            clip_layouts = [
                {**entry, "clip_index": new_index[entry["clip_index"]]}
                for entry in clip_layouts if entry["clip_index"] in new_index
            ]

            logger.info(
                f"{len(rendered_clips)} of {total_clips} clip{'s' if total_clips != 1 else ''} rendered"
                + (f" ({len(failures)} failed)" if failures else "")
            )

            force_gc("after_rendering", job_id)
            capture_memory("after_rendering")

            # Step 5: Upload clips to S3 or save locally
            current_stage = "saving" if self.local_mode else "uploading"
            if self.local_mode:
                self._update_progress(
                    job_id, JobStatus.UPLOADING, 90,
                    "Saving clips locally...",
                    clips_completed=total_clips, total_clips=total_clips,
                )
                stage_start = time.perf_counter()
                clip_artifacts = self._save_clips_locally(job_id, rendered_clips, clip_durations_ms)
                stage_timings["local_save"] = time.perf_counter() - stage_start
                logger.info(f"All {len(clip_artifacts)} clips saved locally")
                # Commit a usable manifest before optional metrics and cost
                # bookkeeping. If that later work fails, the saved clips still
                # form a completed local job.
                base_output = JobOutput(
                    job_id=job_id,
                    source_video_url=request.video_url,
                    source_video_title=download_result.metadata.title,
                    source_video_duration_seconds=download_result.metadata.duration_seconds,
                    total_clips=len(clip_artifacts),
                    clips=clip_artifacts,
                    user_id=request.owner_user_id,
                    transcript_url=transcript_upload.s3_url,
                    plan_url=plan_upload.s3_url,
                    processing_time_seconds=time.time() - start_time,
                    metrics={
                        "planned_clip_count": len(clip_plan.segments),
                        "rendered_clip_count": len(clip_artifacts),
                        "failed_clip_count": len(failures),
                        "uploaded_clip_count": len(clip_artifacts),
                    },
                )
                self._save_local_json(job_id, "job_output", asdict(base_output))
                saved_local_output = base_output
            else:
                self._update_progress(
                    job_id, JobStatus.UPLOADING, 90,
                    "Uploading clips to storage...",
                    clips_completed=total_clips, total_clips=total_clips,
                )
                upload_semaphore = asyncio.Semaphore(self.settings.max_concurrent_uploads)

                async def upload_single_clip(i: int, clip_path: str, segment: ClipPlanSegment) -> ClipArtifact:
                    async with upload_semaphore:
                        clip_start = time.perf_counter()
                        upload_result = await self.s3_upload_service.upload_clip(
                            local_path=clip_path,
                            job_id=job_id,
                            clip_index=i,
                            user_id=request.owner_user_id,
                            metadata={
                                "virality_score": segment.virality_score,
                                "layout_type": segment.layout_type,
                                "start_time_ms": segment.start_time_ms,
                                "end_time_ms": segment.end_time_ms,
                            },
                        )
                        clip_upload_durations_seconds.append(time.perf_counter() - clip_start)

                    return ClipArtifact(
                        clip_index=i,
                        s3_url=upload_result.s3_url,
                        duration_ms=clip_durations_ms.get(i, segment.end_time_ms - segment.start_time_ms),
                        start_time_ms=segment.start_time_ms,
                        end_time_ms=segment.end_time_ms,
                        virality_score=segment.virality_score,
                        layout_type=segment.layout_type,
                        summary=segment.summary,
                        tags=segment.tags or [],
                        render_fallback=segment.render_fallback,
                        description=segment.description,
                        chapters=self._chapter_dicts(segment),
                    )

                upload_tasks = [
                    upload_single_clip(i, clip_path, segment)
                    for i, (clip_path, segment) in enumerate(rendered_clips)
                ]
                stage_start = time.perf_counter()
                clip_artifacts = await asyncio.gather(*upload_tasks)
                stage_timings["uploading"] = time.perf_counter() - stage_start

                clip_artifacts = sorted(clip_artifacts, key=lambda x: x.clip_index)

                logger.info(f"All {len(clip_artifacts)} clips uploaded")

            processing_time = time.time() - start_time
            rendered_output_bytes = sum(os.path.getsize(path) for path, _ in rendered_clips if os.path.isfile(path))
            capture_memory("before_manifest_upload")

            # Build API cost breakdown
            api_costs: dict[str, Any] = {}
            total_cost = 0.0

            if transcription_result.api_costs:
                tc = transcription_result.api_costs
                api_costs["transcription"] = {
                    "provider": tc.provider,
                    "model": tc.model,
                    "audio_duration_seconds": round(tc.audio_duration_seconds, 1),
                    "estimated_cost_usd": tc.estimated_cost_usd,
                    "attempts": tc.attempts,
                }
                total_cost += tc.estimated_cost_usd

            if clip_plan.api_costs:
                pc = clip_plan.api_costs
                api_costs["planning"] = {
                    "provider": pc.provider,
                    "model": pc.model,
                    "prompt_tokens": pc.prompt_tokens,
                    "completion_tokens": pc.completion_tokens,
                    "total_tokens": pc.total_tokens,
                    "estimated_cost_usd": pc.estimated_cost_usd,
                    "attempts": pc.attempts,
                }
                total_cost += pc.estimated_cost_usd

            if layout_vision_cost:
                api_costs["layout_vision"] = {
                    "provider": "openrouter",
                    "model": self.settings.layout_vision_model,
                    "estimated_cost_usd": round(layout_vision_cost, 6),
                }
                total_cost += layout_vision_cost

            api_costs["total_estimated_cost_usd"] = round(total_cost, 6)

            logger.info(f"Job {job_id} total API cost: ${total_cost:.6f}")

            metrics = {
                "requested_settings": {
                    "aspect_ratio": request.aspect_ratio,
                    "layout_style": request.layout_style,
                    "layout_vision_enabled": self.settings.layout_vision_enabled,
                    "pacing": request.pacing,
                    "video_speed": request.video_speed,
                },
                "transcription_status": transcription_status,
                "planning_source": "visual" if visual_frames else "transcript",
                "visual_frame_count": len(visual_frames),
                "captions_status": (
                    "unavailable_without_transcript" if transcription_status != "available"
                    else "enabled" if request.include_captions else "disabled_by_request"
                ),
                "stage_durations_seconds": {
                    stage: round(duration, 3)
                    for stage, duration in stage_timings.items()
                },
                "clip_render_durations_seconds": [round(d, 3) for d in clip_render_durations_seconds],
                "clip_upload_durations_seconds": [round(d, 3) for d in clip_upload_durations_seconds],
                "planned_clip_count": len(clip_plan.segments),
                "rendered_clip_count": len(rendered_clips),
                "failed_clip_count": len(failures),
                "uploaded_clip_count": len(clip_artifacts),
                "source_video_size_bytes": download_result.file_size_bytes,
                "rendered_output_bytes": rendered_output_bytes,
                "peak_rss_mb": round(peak_rss_mb, 1),
                "clip_layouts": sorted(clip_layouts, key=lambda c: c["clip_index"]),
                # False means vertical clips were letterboxed because OpenCV or
                # the face model is missing, not because of the video.
                "smart_framing_available": self.rendering_service.layout_analyzer.available,
                "stage_memory_mb": {
                    stage: round(rss, 1)
                    for stage, rss in stage_memory_mb.items()
                },
                "api_costs": api_costs,
            }

            job_output = JobOutput(
                job_id=job_id,
                source_video_url=request.video_url,
                source_video_title=download_result.metadata.title,
                source_video_duration_seconds=download_result.metadata.duration_seconds,
                total_clips=len(clip_artifacts),
                clips=clip_artifacts,
                user_id=request.owner_user_id,
                transcript_url=transcript_upload.s3_url,
                plan_url=plan_upload.s3_url,
                processing_time_seconds=processing_time,
                metrics=metrics,
            )

            if self.local_mode:
                self._save_local_json(job_id, "job_output", asdict(job_output))
            else:
                await self.s3_upload_service.upload_job_output(job_output)

            webhook_output = {
                "total_clips": len(clip_artifacts),
                "source_video_title": job_output.source_video_title,
                "source_video_duration_seconds": job_output.source_video_duration_seconds,
                "processing_time_seconds": processing_time,
                "metrics": metrics,
                "clips": [
                    {
                        "clip_index": clip.clip_index,
                        "s3_url": clip.s3_url,
                        "duration_ms": clip.duration_ms,
                        "start_time_ms": clip.start_time_ms,
                        "end_time_ms": clip.end_time_ms,
                        "virality_score": clip.virality_score,
                        "layout_type": clip.layout_type,
                        "render_fallback": clip.render_fallback,
                        "summary": clip.summary,
                        "tags": clip.tags or [],
                        "description": clip.description,
                        "chapters": clip.chapters,
                    }
                    for clip in clip_artifacts
                ],
                "transcript_url": job_output.transcript_url,
                "plan_url": job_output.plan_url,
            }

            self._update_progress(
                job_id, JobStatus.COMPLETED, 100,
                "Processing complete!",
                clips_completed=total_clips, total_clips=total_clips,
                output=webhook_output,
            )

            logger.info(f"Job {job_id} metrics: {json.dumps(metrics, sort_keys=True)}")
            logger.info(f"Job {job_id} completed in {processing_time:.1f}s with {len(clip_artifacts)} clips")

            return ClippingJobResult(
                job_id=job_id,
                status=JobStatus.COMPLETED,
                output=job_output,
                processing_time_seconds=processing_time,
            )

        except Exception as e:
            if saved_local_output is not None:
                logger.warning("Local clips saved; final bookkeeping failed (%s)", type(e).__name__)
                self._update_progress(
                    job_id, JobStatus.COMPLETED, 100, "Clips saved locally",
                    clips_completed=saved_local_output.total_clips,
                    total_clips=saved_local_output.total_clips,
                )
                return ClippingJobResult(
                    job_id=job_id,
                    status=JobStatus.COMPLETED,
                    output=saved_local_output,
                    processing_time_seconds=time.time() - start_time,
                )
            failure_code = safe_failure_code(e)
            http_status = getattr(e, "status_code", None)
            if type(http_status) is not int or not 100 <= http_status <= 599:
                http_status = None
            logger.error("Job %s failed at %s: %s (HTTP %s)", job_id, current_stage, failure_code, http_status)
            public_error = safe_processing_error(e)

            self._update_progress(
                job_id, JobStatus.FAILED, 0,
                "Processing failed",
                error=public_error,
            )

            return ClippingJobResult(
                job_id=job_id,
                status=JobStatus.FAILED,
                error=public_error,
                processing_time_seconds=time.time() - start_time,
                failure_code=failure_code,
                failure_stage=current_stage,
                http_status=http_status,
            )

        finally:
            # Completed local clips and JSON have already been copied to the
            # output directory. The work directory can contain a downloaded
            # source and intermediate audio/video, so remove it in both modes.
            if os.path.isdir(work_dir):
                try:
                    shutil.rmtree(work_dir)
                except Exception as e:
                    logger.warning(f"Failed to cleanup work dir: {e}")

            self.webhook_service.clear_job_tracking(job_id)
            self._current_callback_url = None
            self._current_external_job_id = None
            self._current_owner_user_id = None


    def _get_local_output_dir(self, job_id: str) -> str:
        """Get the local output directory for a job, creating it if needed."""
        output_dir = os.path.join(self.settings.local_output_dir, job_id)
        os.makedirs(output_dir, exist_ok=True)
        return output_dir

    def _save_local_json(self, job_id: str, name: str, data: dict) -> str:
        """Save a JSON artifact to the local output directory."""
        output_dir = self._get_local_output_dir(job_id)
        path = os.path.join(output_dir, f"{name}.json")
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=output_dir,
                prefix=f".{name}.", suffix=".tmp", delete=False,
            ) as f:
                temporary_path = f.name
                json.dump(data, f, indent=2, default=str)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temporary_path, path)
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)
        logger.info(f"Saved {name}.json locally: {path}")
        return path

    def _save_clips_locally(
        self,
        job_id: str,
        rendered_clips: list[tuple[str, ClipPlanSegment]],
        durations_ms: Optional[dict[int, int]] = None,
    ) -> list[ClipArtifact]:
        """Copy rendered clips to the local output directory."""
        output_dir = self._get_local_output_dir(job_id)
        artifacts = []

        for i, (clip_path, segment) in enumerate(rendered_clips):
            dest = os.path.join(output_dir, f"clip_{i:02d}.mp4")
            # The work directory is removed after the job. Linking on the same
            # filesystem keeps the saved clip without duplicating its bytes at
            # the point when all rendered clips and the downloaded source are
            # still present. Copy when the output folder is on another volume
            # or its filesystem does not permit hard links.
            try:
                os.link(clip_path, dest)
            except OSError as error:
                if error.errno not in (errno.EXDEV, errno.EPERM, errno.EACCES,
                                       getattr(errno, "ENOTSUP", errno.EPERM),
                                       getattr(errno, "EOPNOTSUPP", errno.EPERM)):
                    raise
                shutil.copy2(clip_path, dest)
            file_size = os.path.getsize(dest)
            logger.info(f"Saved clip_{i:02d}.mp4 ({file_size / 1024 / 1024:.1f} MB): {dest}")

            subtitle_url = None
            if segment.subtitle_path and os.path.isfile(segment.subtitle_path):
                srt_dest = os.path.join(output_dir, f"clip_{i:02d}.srt")
                shutil.copy2(segment.subtitle_path, srt_dest)
                subtitle_url = f"file://{os.path.abspath(srt_dest)}"
            if segment.description or segment.output_chapters:
                self._write_upload_notes(os.path.join(output_dir, f"clip_{i:02d}.youtube.txt"), segment)

            artifacts.append(ClipArtifact(
                clip_index=i,
                s3_url=f"file://{os.path.abspath(dest)}",
                duration_ms=(durations_ms or {}).get(i, segment.end_time_ms - segment.start_time_ms),
                start_time_ms=segment.start_time_ms,
                end_time_ms=segment.end_time_ms,
                virality_score=segment.virality_score,
                layout_type=segment.layout_type,
                summary=segment.summary,
                tags=segment.tags or [],
                render_fallback=segment.render_fallback,
                description=segment.description,
                chapters=self._chapter_dicts(segment),
                subtitle_url=subtitle_url,
            ))

        return artifacts

    @staticmethod
    def _chapter_dicts(segment: ClipPlanSegment) -> Optional[list[dict]]:
        """Chapters on the clip's timeline, or None when there are too few for
        YouTube (it needs three or more, the first at 0:00)."""
        if len(segment.output_chapters) < 3:
            return None
        return [{"time_ms": t_ms, "title": title} for t_ms, title in segment.output_chapters]

    @staticmethod
    def _write_upload_notes(path: str, segment: ClipPlanSegment) -> None:
        """Title, description, chapters and tags ready to paste into an upload."""
        def stamp(ms: int) -> str:
            s = ms // 1000
            return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"

        lines = [segment.summary or "", ""]
        if segment.description:
            lines += [segment.description, ""]
        if len(segment.output_chapters) >= 3:
            lines += [f"{stamp(t_ms)} {title}" for t_ms, title in segment.output_chapters] + [""]
        if segment.tags:
            lines.append("Tags: " + ", ".join(segment.tags))
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write("\n".join(lines).strip() + "\n")
        except OSError as e:
            logger.warning(f"Could not write upload notes: {e}")

    def _filter_transcript_for_clip(
        self,
        all_segments,
        start_time_ms: int,
        end_time_ms: int,
    ):
        """Filter transcript segments that overlap with clip timeframe."""
        filtered = []
        for seg in all_segments:
            if seg.end_time_ms <= start_time_ms:
                continue
            if seg.start_time_ms >= end_time_ms:
                continue
            filtered.append(seg)
        return filtered

    def _update_progress(
        self,
        job_id: str,
        status: JobStatus,
        progress: float,
        step: str,
        clips_completed: int = 0,
        total_clips: int = 0,
        error: Optional[str] = None,
        output: Optional[dict] = None,
    ) -> None:
        """Update job progress via callback and webhook."""
        if self.progress_callback:
            try:
                self.progress_callback(ClippingJobProgress(
                    job_id=job_id,
                    status=status,
                    progress_percent=progress,
                    current_step=step,
                    clips_completed=clips_completed,
                    total_clips=total_clips,
                    error=error,
                ))
            except Exception as e:
                logger.warning(f"Progress callback failed: {e}")

        if self._current_callback_url:
            self._send_webhook(
                job_id=job_id,
                status=status,
                progress=progress,
                step=step,
                clips_completed=clips_completed,
                total_clips=total_clips,
                error=error,
                output=output,
            )

    def _send_webhook(
        self,
        job_id: str,
        status: JobStatus,
        progress: float,
        step: str,
        clips_completed: int = 0,
        total_clips: int = 0,
        error: Optional[str] = None,
        output: Optional[dict] = None,
    ) -> None:
        """Send webhook notification for job status update."""
        event_map = {
            JobStatus.PENDING: "job.started",
            JobStatus.DOWNLOADING: "job.progress",
            JobStatus.TRANSCRIBING: "job.progress",
            JobStatus.PLANNING: "job.progress",
            JobStatus.RENDERING: "job.progress",
            JobStatus.UPLOADING: "job.progress",
            JobStatus.COMPLETED: "job.completed",
            JobStatus.FAILED: "job.failed",
        }
        event = event_map.get(status, "job.progress")

        status_map = {
            JobStatus.PENDING: "queued",
            JobStatus.DOWNLOADING: "running",
            JobStatus.TRANSCRIBING: "running",
            JobStatus.PLANNING: "running",
            JobStatus.RENDERING: "running",
            JobStatus.UPLOADING: "running",
            JobStatus.COMPLETED: "succeeded",
            JobStatus.FAILED: "failed",
        }
        api_status = status_map.get(status, "running")

        is_terminal = status in (JobStatus.COMPLETED, JobStatus.FAILED)
        if not is_terminal and not self.webhook_service.should_send_progress(job_id):
            return

        payload = self.webhook_service.build_payload(
            event=event,
            job_id=job_id,
            status=api_status,
            progress_percent=progress,
            current_step=step,
            external_job_id=self._current_external_job_id,
            owner_user_id=self._current_owner_user_id,
            clips_completed=clips_completed,
            total_clips=total_clips,
            error=error,
            output=output,
        )

        logger.info("Sending webhook event: %s", event)

        try:
            asyncio.create_task(
                self.webhook_service.send(self._current_callback_url, payload)
            )
        except RuntimeError as e:
            logger.warning(f"Could not send webhook (no event loop): {e}")
