"""
Transcription Service - Word-timed audio transcription with OpenRouter model recovery.
"""

import asyncio
import base64
import json
import math
import tempfile
import logging
import os
import random
import subprocess
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from clip_engine.config import get_settings
from clip_engine.services.media_process import MEDIA_INPUT_OPTIONS, run_media

logger = logging.getLogger(__name__)


@dataclass
class TranscriptWord:
    """Word-level timing for precise caption display."""
    
    word: str
    start_time_ms: int
    end_time_ms: int


@dataclass
class TranscriptSegment:
    """A segment of transcribed audio with timing."""
    
    start_time_ms: int
    end_time_ms: int
    text: str
    speaker_label: Optional[str] = None
    words: list[TranscriptWord] = field(default_factory=list)
    # Non-speech audio events inside this segment, e.g. "(laughter)". Fed to
    # the clip planner as engagement signals; never rendered as captions.
    audio_events: list[str] = field(default_factory=list)


@dataclass
class TranscriptionApiCosts:
    """Cost tracking for transcription API calls."""

    provider: str = "openrouter"
    model: str = "microsoft/mai-transcribe-2"
    audio_duration_seconds: float = 0.0
    estimated_cost_usd: float = 0.0
    attempts: int = 0
    cost_incomplete: bool = False


TRANSCRIPTION_MODEL = "microsoft/mai-transcribe-2"
BUDGET_TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo"
BUDGET_FALLBACK_MODEL = "openai/whisper-large-v3"
TRANSCRIPTION_ATTEMPTS_PER_MODEL = 2
MAX_TRANSCRIPTION_RETRY_WAIT = 15.0
TRANSCRIPTION_MODEL_NAMES = {
    BUDGET_TRANSCRIPTION_MODEL: "Whisper Turbo",
    BUDGET_FALLBACK_MODEL: "Whisper Large V3",
    TRANSCRIPTION_MODEL: "MAI Transcribe 2",
}
TRANSCRIPTION_CHUNK_SECONDS = 300
# Context kept around a requested time range so sentence boundaries at its edges still resolve.
TRANSCRIPTION_RANGE_PAD_SECONDS = 5.0
MAX_TRANSCRIPTION_AUDIO_BYTES = 12 * 1024 * 1024
MAX_TRANSCRIPTION_RESPONSE_BYTES = 4 * 1024 * 1024
MAI_PRICE_PER_HOUR = 0.10
WHISPER_TURBO_PRICE_PER_HOUR = 0.0108
WHISPER_V3_PRICE_PER_HOUR = 0.0288
WAV_INPUT_OPTIONS = ["-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "wav"]


def _estimate_transcription_cost(duration_seconds: float, model: str = TRANSCRIPTION_MODEL) -> float:
    """Fallback estimate; prefer OpenRouter's actual usage.cost when returned."""
    price = {
        BUDGET_TRANSCRIPTION_MODEL: WHISPER_TURBO_PRICE_PER_HOUR,
        BUDGET_FALLBACK_MODEL: WHISPER_V3_PRICE_PER_HOUR,
    }.get(model, MAI_PRICE_PER_HOUR)
    return round(duration_seconds / 3600.0 * price, 8)


@dataclass
class TranscriptionResult:
    """Result of transcription operation."""
    
    segments: list[TranscriptSegment]
    full_text: str
    language: Optional[str] = None
    duration_seconds: Optional[float] = None
    provider: str = "openrouter"
    model: str = "microsoft/mai-transcribe-2"
    api_costs: Optional[TranscriptionApiCosts] = None


# Sentence-ending punctuation marks
SENTENCE_END_PUNCTUATION = {'.', '!', '?', '。', '！', '？'}

# The planner sees times rounded to 0.1 s, so a clip end it copies from a
# transcript line can land up to 50 ms after the real sentence end. Treat a
# sentence end this close to the requested time as the intended one.
SENTENCE_END_TOLERANCE_MS = 300

# Conservative application limits for vocabulary hints.
KEYTERM_MAX_CHARS = 49
KEYTERM_MAX_WORDS = 5
KEYTERM_MAX_COUNT = 200
KEYTERM_FORBIDDEN_CHARS = set("<>{}[]\\")


def normalize_keyterms(keyterms: Optional[list[str]]) -> list[str]:
    """Clean vocabulary hints before passing them to the provider.

    Trims, drops empties and terms containing forbidden characters or more
    than five words, truncates to under 50 chars, and dedupes
    case-insensitively.
    """
    normalized: list[str] = []
    seen: set[str] = set()
    for term in keyterms or []:
        if not isinstance(term, str):
            continue
        trimmed = " ".join(term.split())[:KEYTERM_MAX_CHARS].strip()
        if not trimmed or any(c in KEYTERM_FORBIDDEN_CHARS for c in trimmed):
            continue
        if len(trimmed.split()) > KEYTERM_MAX_WORDS:
            continue
        key = trimmed.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(trimmed)
        if len(normalized) >= KEYTERM_MAX_COUNT:
            break
    return normalized


def _format_speaker_label(speaker_id: object) -> Optional[str]:
    """MAI speaker indices are zero-based, including a valid speaker 0."""
    if type(speaker_id) is int and speaker_id >= 0:
        return f"S{speaker_id + 1}"
    if isinstance(speaker_id, str) and speaker_id.isdigit():
        return f"S{int(speaker_id) + 1}"
    return None


def find_sentence_end_boundary(
    segments: list[TranscriptSegment],
    timestamp_ms: int,
    max_extension_ms: int = 5000,
    search_direction: str = "forward",
    tolerance_ms: int = SENTENCE_END_TOLERANCE_MS,
) -> int:
    """
    Find the nearest sentence boundary after a given timestamp.
    
    Uses word-level timing and punctuation detection to find natural
    sentence endings, preventing clips from cutting off mid-sentence.
    
    Args:
        segments: List of TranscriptSegment with word-level timing
        timestamp_ms: The timestamp to search from (in milliseconds)
        max_extension_ms: Maximum milliseconds to extend beyond timestamp (default 5000ms = 5s)
        search_direction: "forward" to find end after timestamp, "backward" to find before
        tolerance_ms: Forward search first takes the nearest sentence end within
            this many ms either side of the timestamp (absorbs display rounding)
        
    Returns:
        Adjusted timestamp in milliseconds at sentence boundary,
        or original timestamp if no boundary found within max_extension
    """
    if not segments:
        return timestamp_ms
    
    # Collect all words with their timing from segments that might contain our timestamp
    candidate_words: list[tuple[str, int]] = []  # (word, end_time_ms)
    
    for segment in segments:
        # Only consider segments that could contain words near our timestamp
        segment_start = segment.start_time_ms
        segment_end = segment.end_time_ms
        
        if search_direction == "forward":
            # For forward search, look at segments from timestamp onwards
            if segment_end < timestamp_ms - tolerance_ms:
                continue
            if segment_start > timestamp_ms + max_extension_ms:
                break
        else:
            # For backward search, look at segments before timestamp
            if segment_start > timestamp_ms:
                continue
            if segment_end < timestamp_ms - max_extension_ms:
                continue
        
        # If segment has word-level timing, use it
        if segment.words:
            for word in segment.words:
                candidate_words.append((word.word, word.end_time_ms))
        else:
            # Fall back to segment-level: treat segment text as ending at segment end
            # Check if segment text ends with sentence punctuation
            text = segment.text.strip()
            if text:
                candidate_words.append((text, segment_end))
    
    if not candidate_words:
        return timestamp_ms
    
    if search_direction == "forward":
        # A sentence end right at the requested time is the intended one, even
        # if rounding put it slightly before; don't extend into the next one.
        near = [
            (abs(end_time - timestamp_ms), end_time)
            for word, end_time in candidate_words
            if abs(end_time - timestamp_ms) <= tolerance_ms and _ends_sentence(word)
        ]
        if near:
            return min(near)[1]

        # Find first sentence boundary after timestamp within max_extension
        for word, end_time in candidate_words:
            if end_time < timestamp_ms:
                continue
            if end_time > timestamp_ms + max_extension_ms:
                # Exceeded max extension, return original
                logger.debug(
                    f"Sentence boundary: no boundary found within {max_extension_ms}ms of {timestamp_ms}ms, "
                    f"using original timestamp"
                )
                return timestamp_ms
            
            # Check if word ends with sentence punctuation
            word_stripped = word.rstrip()
            if word_stripped and word_stripped[-1] in SENTENCE_END_PUNCTUATION:
                logger.debug(
                    f"Sentence boundary: found end at {end_time}ms, "
                    f"extended from {timestamp_ms}ms by {end_time - timestamp_ms}ms"
                )
                return end_time
    else:
        # For backward search, find last sentence boundary before timestamp
        last_boundary = None
        for word, end_time in candidate_words:
            if end_time > timestamp_ms:
                continue
            if end_time < timestamp_ms - max_extension_ms:
                continue
            
            word_stripped = word.rstrip()
            if word_stripped and word_stripped[-1] in SENTENCE_END_PUNCTUATION:
                last_boundary = end_time
        
        if last_boundary is not None:
            logger.debug(
                f"Sentence boundary (backward): found end at {last_boundary}ms, "
                f"adjusted from {timestamp_ms}ms"
            )
            return last_boundary
    
    # No sentence boundary found, return original
    return timestamp_ms


def _ends_sentence(word: str) -> bool:
    stripped = word.rstrip()
    return bool(stripped) and stripped[-1] in SENTENCE_END_PUNCTUATION


def last_sentence_end_between(
    segments: list[TranscriptSegment],
    earliest_ms: int,
    latest_ms: int,
) -> Optional[int]:
    """End time of the last sentence finishing inside [earliest_ms, latest_ms].

    Used to shorten an over-long clip to its last complete sentence instead
    of cutting it mid-sentence. Returns None when no sentence ends there.
    """
    last = None
    for segment in segments:
        if segment.end_time_ms < earliest_ms:
            continue
        if segment.start_time_ms > latest_ms:
            break
        timed = [(w.word, w.end_time_ms) for w in segment.words] or [(segment.text, segment.end_time_ms)]
        for word, end_time in timed:
            if earliest_ms <= end_time <= latest_ms and _ends_sentence(word):
                last = end_time
    return last


def next_start_at_or_after(
    segments: list[TranscriptSegment],
    earliest_ms: int,
    sentence_within_ms: int,
) -> Optional[int]:
    """Where a clip that can't start before earliest_ms should start instead.

    The first sentence starting within sentence_within_ms after earliest_ms,
    otherwise the first word starting at or after it (so the clip at least
    doesn't open mid-word). None when nothing starts after earliest_ms.
    """
    first_word = None
    for segment in segments:
        if segment.end_time_ms < earliest_ms:
            continue
        if segment.start_time_ms >= earliest_ms:
            if segment.start_time_ms <= earliest_ms + sentence_within_ms or first_word is None:
                return segment.start_time_ms
            return first_word
        # This sentence straddles earliest_ms: remember its first word after it.
        if first_word is None:
            first_word = next((w.start_time_ms for w in segment.words if w.start_time_ms >= earliest_ms), None)
    return first_word


def find_sentence_start_boundary(
    segments: list[TranscriptSegment],
    timestamp_ms: int,
    max_adjustment_ms: int = 3000,
) -> int:
    """
    Find the nearest sentence/word start boundary before a given timestamp.
    
    This prevents clips from starting mid-word by snapping the start time
    to the beginning of the word or sentence that contains the timestamp.
    
    Args:
        segments: List of TranscriptSegment with word-level timing
        timestamp_ms: The timestamp to search from (in milliseconds)
        max_adjustment_ms: Maximum milliseconds to adjust backward (default 3000ms = 3s)
        
    Returns:
        Adjusted timestamp in milliseconds at word/sentence start,
        or original timestamp if no suitable boundary found
    """
    if not segments:
        return timestamp_ms
    
    # Collect all words with their timing from relevant segments
    all_words: list[tuple[str, int, int]] = []  # (word, start_time_ms, end_time_ms)
    
    for segment in segments:
        segment_start = segment.start_time_ms
        segment_end = segment.end_time_ms
        
        # Only consider segments near our timestamp
        if segment_end < timestamp_ms - max_adjustment_ms:
            continue
        if segment_start > timestamp_ms + 1000:  # Small buffer to catch current word
            break
        
        if segment.words:
            for word in segment.words:
                all_words.append((word.word, word.start_time_ms, word.end_time_ms))
        else:
            # Fall back to segment-level
            all_words.append((segment.text, segment_start, segment_end))
    
    if not all_words:
        return timestamp_ms
    
    # Find the word that contains or is closest before the timestamp
    best_start = None
    best_is_sentence_start = False
    
    for i, (word, start_time, end_time) in enumerate(all_words):
        # Check if this word contains our timestamp (we're cutting mid-word)
        if start_time <= timestamp_ms <= end_time:
            # We're in the middle of this word - snap to its start
            logger.debug(
                f"Start boundary: timestamp {timestamp_ms}ms is mid-word '{word}', "
                f"snapping to word start at {start_time}ms"
            )
            return start_time
        
        # Check if this is just before our timestamp
        if start_time < timestamp_ms and end_time <= timestamp_ms:
            # Check if previous word ended a sentence (so this is a sentence start)
            if i > 0:
                prev_word = all_words[i - 1][0].rstrip()
                if prev_word and prev_word[-1] in SENTENCE_END_PUNCTUATION:
                    # This word starts a new sentence
                    if timestamp_ms - start_time <= max_adjustment_ms:
                        best_start = start_time
                        best_is_sentence_start = True
            
            # If not a sentence start but within range, consider it
            if not best_is_sentence_start and timestamp_ms - start_time <= max_adjustment_ms:
                best_start = start_time
    
    # Also check if timestamp falls between words
    for i, (word, start_time, end_time) in enumerate(all_words):
        if start_time > timestamp_ms:
            # This word starts after our timestamp - we should start at this word
            if start_time - timestamp_ms <= 500:  # Within 500ms after
                logger.debug(
                    f"Start boundary: timestamp {timestamp_ms}ms is between words, "
                    f"snapping to next word start at {start_time}ms"
                )
                return start_time
            break
    
    if best_start is not None:
        if best_is_sentence_start:
            logger.debug(
                f"Start boundary: found sentence start at {best_start}ms, "
                f"adjusted from {timestamp_ms}ms (-{timestamp_ms - best_start}ms)"
            )
        else:
            logger.debug(
                f"Start boundary: snapped to word start at {best_start}ms, "
                f"adjusted from {timestamp_ms}ms (-{timestamp_ms - best_start}ms)"
            )
        return best_start
    
    return timestamp_ms


class TranscriptionService:
    """OpenRouter speech recognition with word timing for captions."""

    def __init__(self):
        self.settings = get_settings()
        self.progress_callback: Optional[Callable[[str], None]] = None

    def _progress(self, message: str) -> None:
        callback = getattr(self, "progress_callback", None)
        if callback:
            try:
                callback(message)
            except Exception:
                logger.warning("Could not report transcription progress")

    async def transcribe(
        self,
        video_path: str,
        work_dir: str,
        language: Optional[str] = None,
        translate_to_english: bool = False,
        keyterms: Optional[list[str]] = None,
        start_seconds: Optional[float] = None,
        end_seconds: Optional[float] = None,
    ) -> TranscriptionResult:
        """
        Transcribe a video file by extracting audio first.

        Args:
            video_path: Path to video file
            work_dir: Working directory for temporary files
            language: Optional language code (auto-detected if not specified)
            translate_to_english: Whether to translate to English
            keyterms: Optional vocabulary biasing list (e.g., brand names,
                product names, jargon) forwarded as MAI phrase hints.
            start_seconds, end_seconds: Optional source window. Only that part
                of the audio (plus a little context) is extracted and sent to
                the provider; timestamps still refer to the full source.

        Returns:
            TranscriptionResult with segments and word-level timing
        """
        if not os.path.isfile(video_path):
            raise TranscriptionError("Video file not found", reason="source_missing")

        window_start = 0.0
        if start_seconds is not None and start_seconds > 0:
            window_start = max(0.0, start_seconds - TRANSCRIPTION_RANGE_PAD_SECONDS)
        window_end = None if end_seconds is None else max(window_start, end_seconds + TRANSCRIPTION_RANGE_PAD_SECONDS)

        # Extract audio from video
        audio_path = os.path.join(work_dir, "audio_extracted.wav")
        await self._extract_audio_from_video(video_path, audio_path, window_start, window_end)

        try:
            return await self.transcribe_audio(
                audio_path=audio_path,
                language=language,
                translate_to_english=translate_to_english,
                keyterms=keyterms,
                timeline_offset_seconds=window_start,
            )
        finally:
            # Cleanup extracted audio
            if os.path.exists(audio_path):
                try:
                    os.remove(audio_path)
                except Exception:
                    pass

    async def _extract_audio_from_video(
        self, video_path: str, audio_path: str, start_seconds: float = 0.0, end_seconds: Optional[float] = None,
    ) -> None:
        """Extract 16 kHz PCM WAV, which MAI Transcribe 2 accepts through OpenRouter.

        OpenRouter's MAI provider rejects the AAC/M4A produced here with HTTP 400.
        Audio stays at its original speed so timestamps map directly to video.
        A window trims the source before decoding; the output then starts at
        `start_seconds` of the source and the caller shifts timestamps back.
        """
        logger.info(f"Extracting audio from video: {video_path}")

        cmd = [
            "ffmpeg", "-nostdin", "-nostats", "-v", "error",
            "-y",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts",
            *(["-ss", f"{start_seconds:.3f}"] if start_seconds > 0 else []),
            *(["-t", f"{end_seconds - start_seconds:.3f}"] if end_seconds is not None else []),
            "-i", video_path,
            "-map", "0:a:0",  # Match the track used by the render graph.
            "-vn",  # No video
            # Materialize silence at delayed starts/packet gaps so word times
            # remain on the video's clock in the PCM sent to the API.
            "-af", "aresample=16000:async=1:first_pts=0:min_hard_comp=0.001",
            "-acodec", "pcm_s16le",
            "-ar", "16000",  # 16kHz sample rate
            "-ac", "1",  # Mono
            audio_path,
        ]

        # Use run_in_executor for Windows compatibility
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: run_media(cmd)
        )

        if result.returncode != 0:
            # An audio-less video is a valid input for visual-only planning.
            # Confirm that case with ffprobe; other FFmpeg errors must fail.
            try:
                streams = run_media(
                    ["ffprobe", "-v", "error", "-select_streams", "a",
                     "-show_entries", "stream=index", "-of", "csv=p=0", *MEDIA_INPUT_OPTIONS, video_path],
                    timeout=10,
                )
                if streams.returncode == 0 and not streams.stdout.strip():
                    raise NoAudioTrackError("This video has no audio track")
            except (OSError, subprocess.SubprocessError):
                pass
            error_msg = result.stderr.decode() if result.stderr else "Unknown error"
            raise TranscriptionError(f"Failed to extract audio from video: {error_msg}", reason="audio_extraction_failed")

        if not os.path.exists(audio_path):
            raise TranscriptionError("Audio extraction produced no output file", reason="audio_extraction_empty")

        logger.info(f"Audio extracted to: {audio_path}")

    async def transcribe_audio(
        self,
        audio_path: str,
        language: Optional[str] = None,
        translate_to_english: bool = False,
        keyterms: Optional[list[str]] = None,
        timeline_offset_seconds: float = 0.0,
    ) -> TranscriptionResult:
        """Transcribe bounded chunks and retain timestamps on the source timeline.

        `timeline_offset_seconds` is where the audio file starts within the
        source video, so timestamps come back on the video's clock.
        """
        if not os.path.isfile(audio_path):
            raise TranscriptionError("Audio file not found", reason="audio_missing")
        if not self.settings.openrouter_api_key:
            raise TranscriptionProviderError("auth")
        if translate_to_english:
            raise TranscriptionError("Audio translation is not supported", reason="translation_unsupported")
        duration = await asyncio.to_thread(self._audio_duration, audio_path)
        segments: list[TranscriptSegment] = []
        costs = TranscriptionApiCosts(model="")
        detected_language = None
        primary = self.settings.transcription_model
        # Keep the recovered model for the rest of this run. Retrying an
        # unavailable model for each chunk causes repeated failures and costs.
        models = list(dict.fromkeys((primary, BUDGET_FALLBACK_MODEL, TRANSCRIPTION_MODEL, BUDGET_TRANSCRIPTION_MODEL)))
        if getattr(self.settings, "clipping_mode", "quality") == "advanced":
            models = [primary]
        chunk_count = max(1, math.ceil(duration / TRANSCRIPTION_CHUNK_SECONDS))
        with tempfile.TemporaryDirectory(prefix="clip-transcribe-", dir=os.path.dirname(audio_path)) as work:
            for index in range(chunk_count):
                core_start = index * TRANSCRIPTION_CHUNK_SECONDS
                core_end = min(duration, core_start + TRANSCRIPTION_CHUNK_SECONDS)
                # Overlap gives words spanning a cut context. Each word belongs to
                # just one chunk, selected by its midpoint on the source timeline.
                start = max(0.0, core_start - 1.0)
                end = min(duration, core_end + 1.0)
                chunk_path = audio_path
                if chunk_count > 1:
                    chunk_path = os.path.join(work, "chunk.wav")
                    await asyncio.to_thread(self._extract_chunk, audio_path, chunk_path, start, end - start)
                self._progress(f"Transcribing audio, part {index + 1} of {chunk_count}...")
                parsed = await self._transcribe_chunk(chunk_path, language, keyterms, end - start, models, costs)
                detected_language = detected_language or parsed.language
                for segment in parsed.segments:
                    words = []
                    for word in segment.words:
                        midpoint = (word.start_time_ms + word.end_time_ms) / 2000 + start
                        if core_start <= midpoint < core_end:
                            shift_ms = round((start + timeline_offset_seconds) * 1000)
                            words.append(TranscriptWord(word.word, word.start_time_ms + shift_ms, word.end_time_ms + shift_ms))
                    if words:
                        # Diarization IDs only identify speakers within one API
                        # request; don't imply the same identity across chunks.
                        label = segment.speaker_label
                        if label and chunk_count > 1:
                            label = f"C{index + 1}{label}"
                        segments.append(TranscriptSegment(words[0].start_time_ms, words[-1].end_time_ms,
                                                          " ".join(w.word for w in words), label, words))
        costs.estimated_cost_usd = round(costs.estimated_cost_usd, 8)
        return TranscriptionResult(
            segments=segments, full_text=" ".join(segment.text for segment in segments),
            language=detected_language, duration_seconds=duration,
            model=costs.model,
            api_costs=costs,
        )

    async def _transcribe_chunk(
        self, path: str, language: Optional[str], keyterms: Optional[list[str]],
        duration: float, models: list[str], costs: TranscriptionApiCosts,
    ) -> TranscriptionResult:
        """Bounded recovery of one chunk without replaying completed chunks.

        Invalid keys and insufficient credit fail immediately. Transient
        errors get one cancellable retry per model, then another timed-word
        model. A long Retry-After skips this model instead of retrying early.
        """
        while models:
            model = models[0]
            name = TRANSCRIPTION_MODEL_NAMES.get(model, "transcription model")
            for attempt in range(TRANSCRIPTION_ATTEMPTS_PER_MODEL):
                try:
                    costs.attempts += 1
                    response = await self._request_transcript(path, language, keyterms, model)
                    # A 200 response can be billed even if its words are unusable.
                    # Include that cost before parsing or trying another model.
                    charge = self._response_cost(response, duration, model)
                    costs.estimated_cost_usd += charge.estimated_cost_usd
                    costs.cost_incomplete = costs.cost_incomplete or charge.cost_incomplete
                    costs.audio_duration_seconds += charge.audio_duration_seconds
                    seen = costs.model.split(" + ") if costs.model else []
                    if model not in seen:
                        costs.model = " + ".join([*seen, model])
                    return self._parse_openrouter_response(response, duration, model)
                except TranscriptionError as error:
                    transient = error.reason in {"rate_limit", "network"}
                    recoverable = transient or error.reason in {
                        "bad_request", "unavailable", "missing_word_timestamps", "invalid_response",
                    }
                    if not recoverable:
                        raise
                    logger.warning("Transcription attempt failed: model=%s, reason=%s, status=%s, attempt=%d",
                                   model, error.reason, getattr(error, "status_code", None), attempt + 1)
                    delay = max(2.0 + random.uniform(0, 0.5), getattr(error, "retry_after_seconds", None) or 0)
                    if transient and attempt + 1 < TRANSCRIPTION_ATTEMPTS_PER_MODEL and delay <= MAX_TRANSCRIPTION_RETRY_WAIT:
                        self._progress(f"{name} is temporarily busy. Retrying in {math.ceil(delay)} seconds...")
                        await asyncio.sleep(delay)
                        continue
                    if len(models) == 1:
                        raise
                    models.pop(0)
                    next_name = TRANSCRIPTION_MODEL_NAMES.get(models[0], "another transcription model")
                    self._progress(f"Trying {next_name} for transcription...")
                    logger.info("Switching transcription model: %s -> %s", model, models[0])
                    break
        raise TranscriptionError("No transcription model available")

    @staticmethod
    def _response_cost(response: dict, duration: float, model: str) -> TranscriptionApiCosts:
        usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
        billed = usage.get("seconds")
        if not _nonnegative_number(billed):
            billed = duration
        cost = usage.get("cost")
        incomplete = False
        if not _nonnegative_number(cost):
            incomplete = model not in (TRANSCRIPTION_MODEL, BUDGET_TRANSCRIPTION_MODEL, BUDGET_FALLBACK_MODEL)
            cost = 0.0 if incomplete else _estimate_transcription_cost(billed, model)
        return TranscriptionApiCosts(model=model, audio_duration_seconds=billed, estimated_cost_usd=cost, cost_incomplete=incomplete)

    @staticmethod
    def _audio_duration(path: str) -> float:
        try:
            result = run_media(
                ["ffprobe", "-v", "error", *WAV_INPUT_OPTIONS,
                 "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
                timeout=10, check=True,
            )
            duration = float(result.stdout)
            if not math.isfinite(duration) or not 0 < duration <= 6 * 3600 + 1:
                raise ValueError()
            return duration
        except (OSError, ValueError, subprocess.SubprocessError):
            raise TranscriptionError("Could not determine audio duration", reason="audio_duration_unknown") from None

    @staticmethod
    def _extract_chunk(source: str, destination: str, start: float, duration: float) -> None:
        try:
            run_media(
                ["ffmpeg", "-v", "error", "-nostdin", "-y", *WAV_INPUT_OPTIONS,
                 "-ss", str(start), "-i", source, "-t", str(duration), "-vn",
                 "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1", destination],
                timeout=120, check=True,
            )
        except (OSError, subprocess.SubprocessError):
            raise TranscriptionError("Could not prepare audio for transcription", reason="audio_chunk_failed") from None

    async def _request_transcript(self, audio_path: str, language: Optional[str], keyterms: Optional[list[str]], model: Optional[str] = None) -> dict:
        import httpx
        if os.path.getsize(audio_path) > MAX_TRANSCRIPTION_AUDIO_BYTES:
            raise TranscriptionError("Transcription audio chunk is too large", reason="audio_chunk_too_large")
        audio = await asyncio.to_thread(Path(audio_path).read_bytes)
        model = model or getattr(getattr(self, "settings", None), "transcription_model", TRANSCRIPTION_MODEL)
        payload = {
            "model": model,
            "input_audio": {"data": base64.b64encode(audio).decode("ascii"), "format": Path(audio_path).suffix.lstrip(".").lower()},
            "response_format": "verbose_json", "timestamp_granularities": ["segment", "word"],
        }
        phrases = normalize_keyterms(keyterms)
        if model == TRANSCRIPTION_MODEL:
            azure: dict = {"diarization": {"enabled": self.settings.transcription_diarize}}
            if phrases:
                azure["phraseList"] = {"phrases": phrases}
            payload["provider"] = {"options": {"azure": azure}}
        elif phrases and model in (BUDGET_TRANSCRIPTION_MODEL, BUDGET_FALLBACK_MODEL, "openai/whisper-1"):
            # Groq accepts a prompt hint for Whisper. Other providers may
            # ignore this option; word timings remain required either way.
            payload["provider"] = {"options": {"groq": {"prompt": "Expected vocabulary: " + ", ".join(phrases)}}}
        if language and language != "auto":
            payload["language"] = language
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=15.0), follow_redirects=False) as client:
                async with client.stream(
                    "POST", "https://openrouter.ai/api/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {self.settings.openrouter_api_key}", "Accept-Encoding": "identity"}, json=payload,
                ) as response:
                    if response.status_code != 200:
                        raise _provider_failure(response.status_code, response.headers.get("Retry-After"))
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise TranscriptionProviderError("invalid_response", response.status_code)
                    body = bytearray()
                    async for chunk in response.aiter_raw():
                        if len(chunk) > MAX_TRANSCRIPTION_RESPONSE_BYTES - len(body):
                            raise TranscriptionProviderError("response_too_large", response.status_code)
                        body.extend(chunk)
                    result = json.loads(body)
                    if not isinstance(result, dict):
                        raise TranscriptionProviderError("invalid_response", response.status_code)
                    if result.get("error"):
                        # Some upstream failures arrive in a successful HTTP envelope.
                        error = result["error"]
                        code = error.get("code") if isinstance(error, dict) else None
                        if type(code) is int and 400 <= code <= 599:
                            raise _provider_failure(code, response.headers.get("Retry-After"))
                        raise TranscriptionProviderError("invalid_response", response.status_code)
                    return result
        except (httpx.TimeoutException, httpx.NetworkError):
            raise TranscriptionProviderError("network") from None
        except (ValueError, RecursionError):
            raise TranscriptionProviderError("invalid_response") from None
        except httpx.HTTPError:
            raise TranscriptionProviderError("network") from None

    def _parse_openrouter_response(self, response: dict, audio_duration: float, model: Optional[str] = None) -> TranscriptionResult:
        """Parse provider word timings without inventing timestamps."""
        model = model or getattr(getattr(self, "settings", None), "transcription_model", TRANSCRIPTION_MODEL)
        text = response.get("text")
        if not isinstance(text, str):
            raise TranscriptionProviderError("invalid_response")
        raw_words = response.get("words") or []
        if not isinstance(raw_words, list) or (text.strip() and not raw_words):
            raise TranscriptionError("Transcription response did not include word timestamps", reason="missing_word_timestamps")
        segments: list[TranscriptSegment] = []
        words: list[TranscriptWord] = []
        speaker = None

        def flush() -> None:
            if words:
                segments.append(TranscriptSegment(words[0].start_time_ms, words[-1].end_time_ms,
                                                  " ".join(word.word for word in words), speaker, list(words)))
                words.clear()

        for raw in raw_words:
            if not isinstance(raw, dict) or not isinstance(raw.get("word"), str):
                raise TranscriptionProviderError("invalid_response")
            word = raw["word"].strip()
            start, end = raw.get("start"), raw.get("end")
            if (not word or not _nonnegative_number(start) or not _nonnegative_number(end)
                    or end < start or end > audio_duration + 1):
                raise TranscriptionProviderError("invalid_response")
            label = _format_speaker_label(raw.get("speaker"))
            if words and (label != speaker or start * 1000 - words[-1].end_time_ms > 2000):
                flush()
            speaker = label
            words.append(TranscriptWord(word, round(start * 1000), round(end * 1000)))
            if word[-1] in SENTENCE_END_PUNCTUATION:
                flush()
        flush()
        return TranscriptionResult(
            segments=segments, full_text=text.strip(),
            language=response.get("language") if isinstance(response.get("language"), str) else None,
            duration_seconds=audio_duration,
            model=model,
            api_costs=self._response_cost(response, audio_duration, model),
        )


def _nonnegative_number(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0



class TranscriptionError(Exception):
    """Exception raised when transcription fails."""

    def __init__(self, message: str, *, reason: str = "unknown"):
        self.reason = reason
        super().__init__(message)


class NoAudioTrackError(TranscriptionError):
    """FFprobe confirmed that the source has no audio stream."""


class TranscriptionProviderError(TranscriptionError):
    """A safe classification of an OpenRouter transcription failure, without response details."""

    def __init__(self, reason: str, status_code: int | None = None, retry_after_seconds: float | None = None):
        self.status_code = status_code
        self.retry_after_seconds = retry_after_seconds
        super().__init__(reason, reason=reason)


def _retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            when = parsedate_to_datetime(value)
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            seconds = (when - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return None
    return max(0.0, seconds) if math.isfinite(seconds) else None


def _provider_failure(status: int, retry_after: str | None = None) -> TranscriptionProviderError:
    if status in (401, 403):
        reason = "auth"
    elif status == 402:
        reason = "quota"
    elif status == 429:
        reason = "rate_limit"
    elif status in (408, 425) or status >= 500:
        reason = "network"
    elif status in (400, 422):
        reason = "bad_request"
    elif status == 404:
        reason = "unavailable"
    else:
        reason = "rejected"
    return TranscriptionProviderError(reason, status, _retry_after_seconds(retry_after))
