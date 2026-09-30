"""
AI Clipping Pipeline - Orchestrator for the AI clipping workflow.

Pipeline stages:
1. Video download (YouTube via yt-dlp, S3, or direct URL)
2. Source context and web research
3. Audio extraction and transcription (MAI Transcribe 2 through OpenRouter)
4. Intelligence planning (frontier LLM via OpenRouter)
5. Clip rendering (smart per-shot 9:16 framing with captions)
6. S3 upload (parallel uploads)
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
from clip_engine.error_policy import NoClipCandidatesError, NoRequestedMomentsError, safe_failure_code, safe_processing_error
from clip_engine.services.source_context import SourceContextService, context_for_prompt, transcription_terms
from clip_engine.services.editorial_evidence import discovery_feedback, overlaps
from clip_engine.services.jev_service import JevService, MODEL as JEV_MODEL
from clip_engine.services.coherence_review import CoherenceReviewer, CoherenceRejected, no_approved_clips_message
from clip_engine.services.editorial_context import analyze_reactions, empty_report, repair_context_boundaries
from clip_engine.services.editorial_vision import EditorialVision
from clip_engine.services.editorial_review import protect_acknowledgments, review_duplicate_candidates, editorial_summary
from clip_engine.services.intelligence_planner import (
    MAX_CLIP_REQUEST_CHARS,
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
    CONTEXTUALIZING = "contextualizing"
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
    # Title card over the top of each rendered clip.
    include_title: bool = True
    callback_url: Optional[str] = None
    start_time_seconds: Optional[float] = None
    end_time_seconds: Optional[float] = None
    banner_platform: Optional[str] = None
    banner_channel_url: Optional[str] = None
    aspect_ratio: str = "9:16"
    keyterms: Optional[list[str]] = None
    # The user's description of the moments to clip; None picks the best moments.
    clip_request: Optional[str] = None
    layout_style: str = LayoutStyle.AUTO
    debug_capture: bool = False
    # "tight" cuts dead air and filler words; "natural" keeps original timing.
    pacing: str = "tight"
    video_speed: float = 1.0
    workflow: str = 'automatic'
    caption_preset: str = 'pop'

    def __post_init__(self):
        validate_video_speed(self.video_speed)
        # Blank means no request, so the run and its no-match error agree with the planner.
        self.clip_request = (self.clip_request or '').strip()[:MAX_CLIP_REQUEST_CHARS] or None
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
    stages: Optional[list[dict]] = None
    diagnostics: Optional[dict] = None


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

    Orchestrates: download -> source context -> transcribe -> plan -> render (smart framing) -> upload
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
        self.source_context_service = SourceContextService(self.settings)
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

        Pipeline: download -> source context -> transcribe -> plan -> render (smart framing) -> upload
        """
        from .job_progress import StageProgress
        self._stage_progress = StageProgress(request.workflow == 'review')
        from .run_diagnostics import CURRENT, RunDiagnostics
        self._diagnostics = RunDiagnostics()
        self._last_live_progress = None
        loop = asyncio.get_running_loop()
        start_time = time.time()
        job_id = request.job_id
        jev_enabled = request.workflow == 'review' or getattr(self.settings, 'jev_enabled', False)
        editorial_service = JevService.from_settings(self.settings, required=request.workflow == 'review')
        coherence_service = JevService(self.settings.openrouter_api_key if jev_enabled else '', max_requests=256, token_budget=1536000)
        work_dir = os.path.join(self.settings.temp_directory, job_id)
        stage_timings: dict[str, float] = {}
        stage_memory_mb: dict[str, float] = {}
        clip_render_durations_seconds: list[float] = []
        clip_upload_durations_seconds: list[float] = []
        clip_layouts: list[dict] = []
        clip_trace_paths: dict[int, str] = {}
        clip_durations_ms: dict[int, int] = {}
        layout_vision_cost = 0.0
        peak_rss_mb = 0.0
        transcription_status = "available"
        visual_frames = []
        saved_local_output: Optional[JobOutput] = None
        current_stage = "setup"
        edit_audit = None

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

        diagnostics_token = CURRENT.set(self._diagnostics)
        heartbeat = asyncio.create_task(self._diagnostic_heartbeat())
        try:
            os.makedirs(work_dir, mode=0o700, exist_ok=True)
            logger.info(f"Starting AI clipping job: {job_id}")
            logger.info("Video source received")
            logger.info(f"Max clips: {request.max_clips}, Duration ranges: {request.duration_ranges}")
            logger.info(
                f"Include captions: {request.include_captions}, layout style: {request.layout_style}, "
                f"pacing: {request.pacing}, clip request: {'set' if request.clip_request else 'none'}"
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
            self.video_downloader.progress_callback = lambda detail, percent, done, total: loop.call_soon_threadsafe(
                lambda: self._update_progress(job_id, JobStatus.DOWNLOADING, 5 + (percent or 0) * .06, detail,
                    stage_percent=percent, completed=done, total=total, unit='bytes'))
            try:
                download_result = await self.video_downloader.download_video(
                    url=request.video_url, output_dir=work_dir)
            finally:
                self.video_downloader.progress_callback = None
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

            # Establish the source's background before hearing or interpreting its
            # speech. It is part of Jev review and of opt-in web research; with
            # both off, automatic clipping plans from the transcript alone.
            source_context = None
            if jev_enabled or getattr(self.settings, 'source_context_web_research', False):
                current_stage = "source_context"
                self._update_progress(job_id, JobStatus.CONTEXTUALIZING, 12, "Researching the source and building context...")
                stage_start = time.perf_counter()
                source_context = await self.source_context_service.build(download_result.metadata)
                stage_timings["source_context"] = time.perf_counter() - stage_start
                if self.local_mode:
                    self._save_local_json(job_id, "source_context", source_context)
            context_brief = context_for_prompt(source_context)
            source_context_cost = source_context['cost_usd'] if source_context else 0.0

            # Step 2: Transcribe audio. Jev reviews setup and payoff anywhere in
            # the source, so it needs all of it; otherwise only the chosen range.
            current_stage = "transcription"
            self._update_progress(
                job_id, JobStatus.TRANSCRIBING, 15,
                "Transcribing the full source for context..." if jev_enabled else "Transcribing audio...",
            )
            stage_start = time.perf_counter()
            previous_transcription_progress = getattr(self.transcription_service, "progress_callback", None)
            self.transcription_service.progress_callback = lambda message: self._update_progress(
                job_id, JobStatus.TRANSCRIBING, 15, message,
            )
            self.transcription_service.detail_callback = lambda done, total: self._update_progress(
                job_id, JobStatus.TRANSCRIBING, 15 + 10 * done / total, f'Transcribing audio, part {done + 1} of {total}…',
                stage_id='transcription', stage_percent=100 * done / total, completed=done, total=total, unit='chunks')
            try:
                transcription_result = await self.transcription_service.transcribe(
                    video_path=download_result.video_path,
                    work_dir=work_dir,
                    keyterms=transcription_terms(request.keyterms, source_context) if source_context else request.keyterms,
                    start_seconds=None if jev_enabled else request.start_time_seconds,
                    end_seconds=None if jev_enabled else effective_end_time,
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
                self.transcription_service.detail_callback = None
            stage_timings["transcription"] = time.perf_counter() - stage_start
            logger.info(f"Transcription complete: {len(transcription_result.segments)} segments")

            if transcription_status != "available":
                self._update_progress(job_id, JobStatus.PLANNING, 25, "Analyzing video frames...")
                stage_start = time.perf_counter()
                visual_frames = await sample_visual_planning_frames(
                    download_result.video_path, video_duration, work_dir,
                    None if jev_enabled else request.start_time_seconds,
                    None if jev_enabled else effective_end_time,
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
            self._update_progress(
                job_id, JobStatus.PLANNING, 30,
                "Finding complete ideas near your preferred range..." if jev_enabled else "Planning viral clips...",
            )
            stage_start = time.perf_counter()
            edit_audit = {'version': 1, 'title': download_result.metadata.title,
                'source_context': source_context,
                'duration_ms': round(video_duration * 1000),
                'preferred_range': [request.start_time_seconds, effective_end_time],
                'transcript': [{'start_ms': t.start_time_ms, 'end_ms': t.end_time_ms, 'text': t.text, 'speaker': t.speaker_label} for t in transcription_result.segments],
                'planner': getattr(self.intelligence_planner, 'audit', {'requests': []}),
                'jev_enabled': jev_enabled, 'candidates': [], 'outcome': 'reviewing' if jev_enabled else 'selecting'}
            def save_edit_audit():
                if self.local_mode:
                    self._save_local_json(job_id, 'edit_audit', edit_audit)
            save_edit_audit()
            planning_args = dict(
                transcript_result=transcription_result,
                video_metadata=download_result.metadata,
                source_context=context_brief,
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
                jev_enabled=jev_enabled,
                clip_request=request.clip_request,
            )
            clip_plan = await self.intelligence_planner.plan_clips(**planning_args)
            edit_audit['planner'] = getattr(self.intelligence_planner, 'audit', {'requests': []})
            stage_timings["planning"] = time.perf_counter() - stage_start
            logger.info(f"Planned {len(clip_plan.segments)} clips")
            if not clip_plan.segments:
                edit_audit['outcome'] = 'no_candidates'
                raise NoRequestedMomentsError() if request.clip_request else NoClipCandidatesError()
            reviewer = CoherenceReviewer(coherence_service, self.settings, transcription_result.segments, round(video_duration * 1000))
            editorial_vision = EditorialVision(self.settings, download_result.video_path, work_dir, round(video_duration * 1000))
            reviewer.source_context = context_brief
            reviewer.visual_observer = editorial_vision.observe if getattr(self.settings, 'jev_visual_context', False) else None
            if request.workflow == 'review':
                if not self.local_mode:
                    raise ValueError('Review projects require local mode')
                from clip_engine.services.manual_editor import prepare_project
                project = await prepare_project(request, clip_plan.segments, transcription_result.segments,
                    download_result, self.rendering_service, reviewer, self._get_local_output_dir(job_id),
                    lambda message, percent=None, stage='preparing': self._update_progress(job_id, JobStatus.PLANNING,
                        {'preparing': 40, 'saving': 80, 'preview': 85}[stage] + (percent or 0) * {'preparing': .4, 'saving': .05, 'preview': .1}[stage], message,
                        stage_id=stage, stage_percent=percent))
                edit_audit['outcome'] = 'ready_for_review'
                save_edit_audit()
                costs = source_context_cost + coherence_service.estimated_cost_usd
                for api in (transcription_result.api_costs, clip_plan.api_costs):
                    costs += getattr(api, 'estimated_cost_usd', 0) if api else 0
                output = JobOutput(job_id=job_id, source_video_url=request.video_url,
                    source_video_title=download_result.metadata.title, source_video_duration_seconds=video_duration,
                    source_video_description=(getattr(download_result.metadata, 'description', '') or '')[:20000],
                    source_video_channel=getattr(download_result.metadata, 'uploader', None),
                    total_clips=0, clips=[], editor_project=True, transcript_url=transcript_upload.s3_url,
                    processing_time_seconds=time.time() - start_time,
                    metrics={'planned_clip_count': len(project['candidates']),
                        'api_costs': {'total_estimated_cost_usd': costs, 'cost_incomplete': True},
                        'diagnostics': self._diagnostics.snapshot(),
                        'pipeline_stages': self._stage_progress.update('completed')})
                self._save_local_json(job_id, 'job_output', asdict(output))
                self._update_progress(job_id, JobStatus.COMPLETED, 100, 'Ready to edit')
                return ClippingJobResult(job_id=job_id, status=JobStatus.COMPLETED, output=output,
                    processing_time_seconds=time.time() - start_time)
            accepted = []
            limit = getattr(self.intelligence_planner, 'discovery_limit', None) or request.max_clips or self.settings.max_clips_absolute
            pending = clip_plan.segments
            for discovery_pass in (1, 2):
                for segment in pending:
                    i = len(edit_audit['candidates'])
                    self._update_progress(job_id, JobStatus.PLANNING, 35,
                        f"Reviewing candidate {i + 1} for coherence (discovery {discovery_pass})..." if jev_enabled else f"Selecting planned clip {i + 1}...",
                        stage_id="reviewing" if jev_enabled else "planning", stage_percent=None)
                    # Reaction protection and boundary expansion belong to Jev
                    # review; without it, planned clips render as planned.
                    segment.editorial = (
                        analyze_reactions(transcription_result.segments, segment.start_time_ms, segment.end_time_ms)
                        if jev_enabled else empty_report()
                    )
                    entry = {'candidate_index': i, 'title': segment.summary or '', 'discovery_pass': discovery_pass,
                        'original_interval': [segment.start_time_ms, segment.end_time_ms],
                        'clip_index': None, 'status': 'reviewing', 'report': segment.editorial}
                    edit_audit['candidates'].append(entry)
                    if len(accepted) >= limit:
                        entry['status'] = 'selection_limit'
                        save_edit_audit()
                        continue
                    if jev_enabled:
                        segment.start_time_ms, segment.end_time_ms = repair_context_boundaries(
                            segment.start_time_ms, segment.end_time_ms, segment.editorial, 0, round(video_duration * 1000), round(video_duration * 1000))
                    else:
                        # Explicit opt-out bypasses review; provider failures never do.
                        reviewer.trace(segment.editorial).update(status='skipped', reason='disabled_by_user',
                            original_interval=entry['original_interval'])
                    if not jev_enabled or await reviewer.prepare(segment, segment.editorial):
                        entry['title'] = segment.summary or ''
                        if any(overlaps([segment.start_time_ms, segment.end_time_ms], [c.start_time_ms, c.end_time_ms]) for c in accepted):
                            entry['status'] = 'overlap_not_selected'
                        else:
                            entry['status'] = 'accepted'
                            accepted.append(segment)
                            if jev_enabled:
                                await protect_acknowledgments(editorial_service, transcription_result.segments,
                                                              segment.start_time_ms, segment.end_time_ms, segment.editorial)
                    else:
                        entry['status'] = 'rejected'
                    save_edit_audit()
                # One bounded search for overlooked moments, not repeated attempts to fill a quota.
                if (not jev_enabled or discovery_pass == 2 or len(accepted) >= limit or not coherence_service.enabled
                        or not any(c['status'] == 'rejected' for c in edit_audit['candidates'])
                        or coherence_service.requests >= coherence_service.max_requests
                        or coherence_service.reserved_tokens >= coherence_service.token_budget
                        or not any((a.get('judgment') or {}).get('status') == 'success'
                            for c in edit_audit['candidates'] for a in c['report'].get('coherence', {}).get('attempts', []))):
                    break
                feedback = discovery_feedback(edit_audit['candidates'], round(video_duration * 1000), edit_audit['preferred_range'])
                edit_audit['discovery'] = {'status': 'searching' if feedback['search_intervals'] else 'exhausted', **feedback}
                if not feedback['search_intervals']:
                    break
                try:
                    extra = await self.intelligence_planner.plan_clips(**{**planning_args,
                        'max_clips': min(8, limit - len(accepted)), 'auto_clip_count': False,
                        'discovery_feedback': feedback})
                    # Also enforce exclusions at the pipeline boundary, including mocked/custom planners.
                    pending = [c for c in extra.segments[:8]
                        if any(overlaps([c.start_time_ms, c.end_time_ms], span) for span in feedback['search_intervals'])
                        and not any(overlaps([c.start_time_ms, c.end_time_ms], old['interval']) for old in feedback['previous_candidates'])]
                    edit_audit['discovery']['status'] = 'completed'
                    if extra.api_costs:
                        if clip_plan.api_costs:
                            for field in ('prompt_tokens', 'completion_tokens', 'total_tokens', 'estimated_cost_usd', 'attempts'):
                                setattr(clip_plan.api_costs, field, getattr(clip_plan.api_costs, field) + getattr(extra.api_costs, field))
                        else:
                            clip_plan.api_costs = extra.api_costs
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # A failed optional search must not discard already approved clips.
                    edit_audit['discovery']['status'] = 'unavailable'
                    pending = []
                edit_audit['planner'] = getattr(self.intelligence_planner, 'audit', {'requests': []})
                save_edit_audit()
                if not pending:
                    break
            clip_plan.segments = accepted
            clip_plan.total_clips = len(accepted)
            if not accepted:
                edit_audit['outcome'] = 'no_approved_clips'
                save_edit_audit()
                raise CoherenceRejected(no_approved_clips_message([entry['report'] for entry in edit_audit['candidates']]))

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
                clips_completed=0, total_clips=total_clips, stage_percent=0,
            )

            render_semaphore = asyncio.Semaphore(self.settings.max_concurrent_renders)
            longform = is_longform(request.aspect_ratio, resolve_clip_duration_bounds(
                request.duration_ranges, request.min_clip_duration_seconds, request.max_clip_duration_seconds,
            )[0])
            clips_finished = 0
            render_fractions = {}
            finished_renders = set()
            last_render_update = [0.0]
            def render_progress(i, detail, percent):
                def report():
                    if i in finished_renders: return
                    if percent is not None:
                        render_fractions[i] = min(.99, max(0, percent / 100))
                    now = time.monotonic()
                    if now - last_render_update[0] < .25: return
                    last_render_update[0] = now
                    fraction = (clips_finished + sum(render_fractions.values())) / total_clips
                    self._update_progress(job_id, JobStatus.RENDERING, 50 + 40 * fraction,
                        f'Clip {i + 1} of {total_clips}: {detail}', clips_finished, total_clips,
                        stage_percent=100 * fraction, completed=clips_finished, total=total_clips, unit='clips')
                loop.call_soon_threadsafe(report)

            async def render_single_clip(i: int, segment: ClipPlanSegment) -> tuple[int, str, ClipPlanSegment]:
                nonlocal layout_vision_cost
                try:
                    return await render_clip_locked(i, segment)
                finally:
                    # Long renders take minutes each: report every finished
                    # (or failed) clip instead of sitting at 50% until all are done.
                    nonlocal clips_finished
                    clips_finished += 1
                    finished_renders.add(i)
                    render_fractions.pop(i, None)
                    self._update_progress(
                        job_id, JobStatus.RENDERING, 50 + 40 * clips_finished / total_clips,
                        f"Rendered {clips_finished} of {total_clips} clip{'s' if total_clips != 1 else ''}",
                        clips_completed=clips_finished, total_clips=total_clips,
                        stage_percent=100 * clips_finished / total_clips, completed=clips_finished, total=total_clips, unit='clips',
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
                        progress_callback=lambda detail, percent=None: render_progress(i, detail, percent),
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
                        include_title=request.include_title,
                        emphasis_words=segment.emphasis_words,
                        banner_platform=request.banner_platform,
                        banner_channel_url=request.banner_channel_url,
                        aspect_ratio=request.aspect_ratio,
                        layout_style=request.layout_style,
                        debug_capture=request.debug_capture,
                        pacing=request.pacing,
                        video_speed=request.video_speed,
                        longform=longform,
                        skip_ranges_ms=segment.skip_ranges_ms,
                        chapters=segment.chapters,
                        editorial_context=segment.editorial,
                        editorial_service=editorial_service if jev_enabled else None,
                        coherence_reviewer=reviewer if jev_enabled else None,
                        # Jev reviews exact source intervals; otherwise keep the
                        # usual audio padding around each clip.
                        apply_padding=not jev_enabled,
                    )

                    render_result = await self.rendering_service.render_clip(render_request)
                    if getattr(render_result, "framing_trace_path", None):
                        clip_trace_paths[i] = render_result.framing_trace_path
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
            for entry in edit_audit['candidates']:
                matched = next(((k, segment) for k, (_, _, segment) in enumerate(successes) if segment.editorial is entry['report']), None)
                if matched:
                    entry.update(status='rendered', clip_index=matched[0])
                elif entry['status'] == 'accepted':
                    entry['status'] = 'rejected' if entry['report'].get('coherence', {}).get('status') == 'rejected' else 'render_failed'
            edit_audit['outcome'] = 'completed' if successes else 'no_approved_clips'
            save_edit_audit()
            if not successes:
                raise failures[0][1]
            rendered_clips = [(path, segment) for _, path, segment in successes]
            if jev_enabled:
                await review_duplicate_candidates(editorial_service, [segment for _, _, segment in successes])
            save_edit_audit()
            # Duplicate review consumes final retained dialogue, after rendering.
            # Update only this job's private trace before copying it to the library.
            for original_index, _, segment in successes:
                trace_path = clip_trace_paths.get(original_index)
                if trace_path and segment.editorial:
                    try:
                        with open(trace_path, encoding='utf-8') as trace_file:
                            trace = json.load(trace_file)
                        trace['editorial'] = segment.editorial
                        from clip_engine.services.framing_trace import save_trace
                        save_trace(trace_path + '.editorial', trace)
                        os.replace(trace_path + '.editorial', trace_path)
                    except Exception:
                        logger.warning('Editorial trace update unavailable')
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
                def save_progress(done, total):
                    loop.call_soon_threadsafe(lambda: self._update_progress(job_id, JobStatus.UPLOADING,
                        90 + 5 * done / total, f'Saving clip {done} of {total}', total_clips, total_clips,
                        stage_percent=100 * done / total, completed=done, total=total, unit='clips'))
                clip_artifacts = await asyncio.to_thread(self._save_clips_locally, job_id, rendered_clips, clip_durations_ms, save_progress)
                if request.debug_capture:
                    output_dir = self._get_local_output_dir(job_id)
                    preview_status = "available"
                    try:
                        await self.rendering_service.capture_framing_source(
                            download_result.video_path, os.path.join(output_dir, "framing-source.mp4"),
                            progress=lambda percent: loop.call_soon_threadsafe(lambda: self._update_progress(
                                job_id, JobStatus.UPLOADING, 95 + .04 * percent, 'Preparing framing preview',
                                stage_id='preview', stage_percent=percent)), duration_ms=round(video_duration * 1000))
                    except Exception:
                        preview_status = "failed"
                        logger.warning("Framing source preview could not be saved")
                    for original, index in new_index.items():
                        trace_path = clip_trace_paths.get(original)
                        if trace_path:
                            try:
                                with open(trace_path, encoding="utf-8") as trace_file:
                                    trace = json.load(trace_file)
                                trace["clip_index"] = index
                                trace["source"].update({"duration_ms": round(video_duration * 1000),
                                                         "preview_status": preview_status})
                                self._save_local_json(job_id, f"clip_{index:02d}.framing", trace, compact=True)
                            except (OSError, ValueError):
                                logger.warning("Framing decisions could not be saved")
                stage_timings["local_save"] = time.perf_counter() - stage_start
                logger.info(f"All {len(clip_artifacts)} clips saved locally")
                # Commit a usable manifest before optional metrics and cost
                # bookkeeping. If that later work fails, the saved clips still
                # form a completed local job.
                base_output = JobOutput(
                    job_id=job_id,
                    source_video_url=request.video_url,
                    source_video_title=download_result.metadata.title,
                    source_video_description=(getattr(download_result.metadata, "description", None) or "")[:20000],
                    source_video_channel=getattr(download_result.metadata, "uploader", None),
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
                        editorial=editorial_summary(segment.editorial),
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
            total_cost = source_context_cost
            if source_context:
                api_costs['source_context'] = {
                    'provider': 'openrouter', 'model': self.settings.source_context_model,
                    'estimated_cost_usd': source_context['cost_usd'],
                    'attempts': len(source_context['requests']), 'cost_incomplete': source_context['cost_incomplete'],
                }

            if transcription_result.api_costs:
                tc = transcription_result.api_costs
                api_costs["transcription"] = {
                    "provider": tc.provider,
                    "model": tc.model,
                    "audio_duration_seconds": round(tc.audio_duration_seconds, 1),
                    "estimated_cost_usd": tc.estimated_cost_usd,
                    "attempts": tc.attempts,
                    "cost_incomplete": tc.cost_incomplete,
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
                    "cost_incomplete": pc.cost_incomplete,
                }
                total_cost += pc.estimated_cost_usd

            if layout_vision_cost:
                api_costs["layout_vision"] = {
                    "provider": "openrouter",
                    "model": self.settings.layout_vision_model,
                    "estimated_cost_usd": round(layout_vision_cost, 6),
                }
                total_cost += layout_vision_cost

            if editorial_service.requests or coherence_service.requests:
                api_costs['editorial'] = {
                    'provider': 'openrouter', 'model': JEV_MODEL,
                    'prompt_tokens': editorial_service.input_tokens + coherence_service.input_tokens,
                    'completion_tokens': editorial_service.output_tokens + coherence_service.output_tokens,
                    'estimated_cost_usd': editorial_service.estimated_cost_usd + coherence_service.estimated_cost_usd,
                    'attempts': editorial_service.requests + coherence_service.requests,
                }
                total_cost += editorial_service.estimated_cost_usd + coherence_service.estimated_cost_usd
            if reviewer.repair_requests:
                api_costs['editorial_repair'] = {'provider': 'openrouter', 'model': self.settings.editorial_repair_model,
                    'estimated_cost_usd': reviewer.repair_cost, 'attempts': reviewer.repair_requests}
                total_cost += reviewer.repair_cost
            if editorial_vision.requests:
                api_costs['editorial_vision'] = {'provider': 'openrouter', 'model': self.settings.layout_vision_model,
                    'estimated_cost_usd': editorial_vision.cost_usd, 'attempts': editorial_vision.requests}
                total_cost += editorial_vision.cost_usd
            api_costs["total_estimated_cost_usd"] = round(total_cost, 6)
            api_costs["cost_incomplete"] = any(section.get("cost_incomplete", False) for section in api_costs.values() if isinstance(section, dict))

            logger.info(f"Job {job_id} total API cost: ${total_cost:.6f}")

            metrics = {
                'diagnostics': self._diagnostics.snapshot(),
                'pipeline_stages': self._stage_progress.update('completed'),
                # Jev plans from the full source; otherwise only the range is analyzed.
                "analysis_duration_seconds": video_duration if jev_enabled else max(
                    0, (effective_end_time if effective_end_time is not None else video_duration)
                    - (request.start_time_seconds or 0),
                ),
                "requested_settings": {
                    "clipping_mode": self.settings.clipping_mode,
                    "planner_model": self.settings.planner_model,
                    "transcription_model": self.settings.transcription_model,
                    "aspect_ratio": request.aspect_ratio,
                    "layout_style": request.layout_style,
                    "layout_vision_enabled": self.settings.layout_vision_enabled,
                    "pacing": request.pacing,
                    "video_speed": request.video_speed,
                    "include_title": request.include_title,
                    "clip_request": request.clip_request,
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
                source_video_description=(getattr(download_result.metadata, "description", None) or "")[:20000],
                source_video_channel=getattr(download_result.metadata, "uploader", None),
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
                "source_video_url": job_output.source_video_url,
                "source_video_description": job_output.source_video_description,
                "source_video_channel": job_output.source_video_channel,
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
            public_error = str(e) if isinstance(e, CoherenceRejected) else safe_processing_error(e)
            if edit_audit is not None:
                edit_audit['planner'] = getattr(self.intelligence_planner, 'audit', {'requests': []})
                if isinstance(e, NoClipCandidatesError): edit_audit['outcome'] = 'no_candidates'
                elif edit_audit['outcome'] == 'reviewing': edit_audit['outcome'] = 'review_failed'
                try: save_edit_audit()
                except Exception: logger.warning('Edit audit could not be saved')

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
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            CURRENT.reset(diagnostics_token)
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

    def _save_local_json(self, job_id: str, name: str, data: dict, compact: bool = False) -> str:
        """Save a JSON artifact to the local output directory."""
        output_dir = self._get_local_output_dir(job_id)
        if name == 'job_output' and getattr(self, '_diagnostics', None):
            data.setdefault('metrics', {})['diagnostics'] = self._diagnostics.snapshot()
        path = os.path.join(output_dir, f"{name}.json")
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=output_dir,
                prefix=f".{name}.", suffix=".tmp", delete=False,
            ) as f:
                temporary_path = f.name
                json.dump(data, f, indent=None if compact else 2, default=str,
                          separators=(",", ":") if compact else None)
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
        progress=None,
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
                editorial=editorial_summary(segment.editorial),
            ))

            if progress: progress(i + 1, len(rendered_clips))

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

    async def _diagnostic_heartbeat(self):
        from dataclasses import replace
        while True:
            await asyncio.sleep(1)
            previous = self._last_live_progress
            if previous and self.progress_callback:
                try:
                    self.progress_callback(replace(previous, stages=self._stage_progress.snapshot(),
                        diagnostics=self._diagnostics.snapshot()))
                except Exception:
                    logger.debug('Live diagnostic update unavailable')

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
        stage_id=None, stage_percent=None, completed=None, total=None, unit=None,
    ) -> None:
        """Update job progress via callback and webhook."""
        tracker = getattr(self, '_stage_progress', None)
        stages = tracker.update(status.value, stage_id, stage_percent, completed, total, unit) if tracker else None
        diagnostics = getattr(self, '_diagnostics', None)
        if diagnostics and tracker and tracker.active:
            diagnostics.stage = tracker.active
        # Scans may decode hundreds of frames in a second. Keep the bridge
        # responsive and below its message-rate limit, while retaining state.
        key = (job_id, status.value, stage_id)
        now = time.monotonic()
        terminal = status.value in ('completed', 'failed', 'cancelled')
        if not terminal and key == getattr(self, '_last_progress_key', None) and now - getattr(self, '_last_progress_at', 0) < .15:
            return
        self._last_progress_key, self._last_progress_at = key, now
        if getattr(self, '_overall_job', None) != job_id:
            self._overall_job, self._overall_progress = job_id, 0
        self._overall_progress = max(self._overall_progress, min(100, progress))
        progress = self._overall_progress
        if self.progress_callback:
            try:
                self._last_live_progress = ClippingJobProgress(
                    job_id=job_id,
                    status=status,
                    progress_percent=progress,
                    current_step=step,
                    clips_completed=clips_completed,
                    total_clips=total_clips,
                    error=error, stages=stages, diagnostics=diagnostics.snapshot() if diagnostics else None,
                )
                self.progress_callback(self._last_live_progress)
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
