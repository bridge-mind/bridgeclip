"""Stable outward-facing job errors without exception details or source URLs."""

import errno

TWITCH_ERRORS = {
    "twitch_unsupported": "Unsupported Twitch source",
    "twitch_not_completed": "Twitch VOD is not completed",
    "twitch_duration": "Twitch VOD duration is invalid or too long",
    "twitch_unavailable": "Twitch VOD unavailable",
}

DISK_FULL_ERRNOS = {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}
DISK_FULL_MARKERS = ("no space left on device", "disk quota exceeded")


def is_disk_full(error: BaseException) -> bool:
    """True when the error, or one it was raised from, reports a full disk.

    Downloads, transcription and renders wrap OSError and FFmpeg output in their
    own exception types, so check the whole chain and the message text.
    """
    seen = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, OSError) and current.errno in DISK_FULL_ERRNOS:
            return True
        if any(marker in str(current).lower() for marker in DISK_FULL_MARKERS):
            return True
        current = current.__cause__ or current.__context__
    return False


def safe_processing_error(error: Exception) -> str:
    """Classify an internal exception for API responses and webhooks."""
    if is_disk_full(error):
        return "Not enough disk space to save clips"
    if isinstance(error, TimeoutError):
        return "Processing timed out"
    if type(error).__name__ == "VisualPlanningUnsupportedError":
        return "Selected planner requires a video with speech"
    if type(error).__name__ == "VideoDownloadError":
        return TWITCH_ERRORS.get(getattr(error, "reason", None), "Video download failed")
    if type(error).__name__ == "TranscriptionProviderError":
        return {
            "auth": "Transcription authentication failed",
            "quota": "Transcription account credit limit reached",
            "rate_limit": "Transcription providers are temporarily rate limited",
            "network": "Transcription service unavailable",
            "bad_request": "Transcription request rejected by provider",
            "unavailable": "Transcription service unavailable",
            "rejected": "Transcription request rejected by provider",
            "invalid_response": "Transcription response was invalid",
            "response_too_large": "Transcription response was too large",
        }.get(getattr(error, "reason", None), "Transcription failed")
    if type(error).__name__ == "TranscriptionError":
        return {
            "audio_extraction_failed": "Audio extraction failed",
            "audio_extraction_empty": "Audio extraction failed",
            "audio_duration_unknown": "Audio duration could not be determined",
            "audio_chunk_failed": "Transcription audio preparation failed",
            "audio_chunk_too_large": "Transcription audio chunk exceeded the size limit",
            "missing_word_timestamps": "Transcription response lacked word timestamps",
        }.get(getattr(error, "reason", None), "Transcription failed")
    if type(error).__name__ == "RenderingError":
        message = str(error).lower()
        if "no space left on device" in message or "disk quota exceeded" in message:
            return "Not enough disk space to save clips"
        return "Video render failed"
    if isinstance(error, RuntimeError) and str(error).startswith("No clip-worthy moments found ("):
        return "No clip-worthy moments found"
    return "Processing failed"


def safe_failure_code(error: Exception) -> str:
    """Small fixed code suitable for job records and logs; never include raw provider text."""
    if is_disk_full(error):
        return "storage.full"
    if type(error).__name__ == "VisualPlanningUnsupportedError":
        return "planning.images_unsupported"
    if type(error).__name__ in {"TranscriptionError", "TranscriptionProviderError"}:
        reason = getattr(error, "reason", "unknown")
        if reason in {
            "auth", "quota", "rate_limit", "network", "bad_request", "unavailable", "rejected", "invalid_response",
            "response_too_large", "source_missing", "audio_extraction_failed",
            "audio_extraction_empty", "audio_missing", "translation_unsupported",
            "audio_duration_unknown", "audio_chunk_failed", "audio_chunk_too_large",
            "missing_word_timestamps",
        }:
            return f"transcription.{reason}"
        return "transcription.unknown"
    if type(error).__name__ == "VideoDownloadError":
        reason = getattr(error, "reason", None)
        return f"download.{reason}" if reason in TWITCH_ERRORS else "download.failed"
    if type(error).__name__ == "RenderingError":
        return "render.failed"
    return "pipeline.failed"


def safe_job_error_text(error: str | None) -> str | None:
    """Only expose known, fixed messages from stored job state."""
    if error is None:
        return None
    if error in TWITCH_ERRORS.values():
        return error
    if error in {
        "Processing timed out", "Video download failed", "No clip-worthy moments found",
        "Selected planner requires a video with speech",
        "Processing failed", "Job cancelled", "Transcription authentication failed",
        "Transcription quota or rate limit reached", "Transcription service unavailable",
        "Transcription providers are temporarily rate limited",
        "Transcription account credit limit reached",
        "Transcription failed",
        "Transcription request rejected by provider", "Transcription response was invalid",
        "Transcription response was too large", "Audio extraction failed",
        "Audio duration could not be determined", "Transcription audio preparation failed",
        "Transcription audio chunk exceeded the size limit",
        "Transcription response lacked word timestamps",
        "Video render failed",
    }:
        return error
    return "Processing failed"
