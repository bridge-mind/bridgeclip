"""Offline recovery regressions: no credentials, paid requests, or real sleeps."""

import asyncio
import json
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from clip_engine.error_policy import safe_failure_code, safe_job_error_text, safe_processing_error
from clip_engine.services import transcription_service as stt


TURBO = stt.BUDGET_TRANSCRIPTION_MODEL
WHISPER = stt.BUDGET_FALLBACK_MODEL
MAI = stt.TRANSCRIPTION_MODEL


def reply(text="Hello.", start=.1, end=.5, cost=0.001):
    return {"text": text, "words": [{"word": text, "start": start, "end": end}],
            "usage": {"seconds": 2, "cost": cost}}


@pytest.fixture
def service(monkeypatch):
    svc = stt.TranscriptionService.__new__(stt.TranscriptionService)
    svc.settings = SimpleNamespace(transcription_model=TURBO, openrouter_api_key="test-key", transcription_diarize=True)
    svc.progress_callback = None
    monkeypatch.setattr(stt.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(stt.random, "uniform", lambda *_: 0)
    return svc


def transcribe(service, monkeypatch, tmp_path, responses, duration=2):
    path = tmp_path / "source.wav"
    path.write_bytes(b"offline audio")
    request = AsyncMock(side_effect=responses)
    monkeypatch.setattr(service, "_request_transcript", request)
    monkeypatch.setattr(service, "_audio_duration", lambda _: duration)
    monkeypatch.setattr(service, "_extract_chunk", lambda *a: None)
    result = asyncio.run(service.transcribe_audio(str(path)))
    return result, [c.args[3] for c in request.call_args_list]


def test_rate_limit_retries_then_uses_budget_fallback(service, monkeypatch, tmp_path):
    messages = []
    service.progress_callback = messages.append
    limited = stt.TranscriptionProviderError("rate_limit", 429, 4)
    result, models = transcribe(service, monkeypatch, tmp_path, [limited, limited, reply()])
    assert models == [TURBO, TURBO, WHISPER]
    stt.asyncio.sleep.assert_awaited_once_with(4)
    assert result.model == WHISPER
    assert result.api_costs.attempts == 3
    assert result.segments[0].words[0].start_time_ms == 100
    assert any("Retrying" in m for m in messages)
    assert any("Whisper Large V3" in m for m in messages)


def test_transient_error_recovers_without_changing_model(service, monkeypatch, tmp_path):
    result, models = transcribe(service, monkeypatch, tmp_path,
                                [stt.TranscriptionProviderError("network", 503), reply()])
    assert models == [TURBO, TURBO]
    assert result.model == TURBO
    assert result.api_costs.estimated_cost_usd == .001


def test_long_retry_after_does_not_retry_a_model_early(service, monkeypatch, tmp_path):
    result, models = transcribe(service, monkeypatch, tmp_path,
                                [stt.TranscriptionProviderError("rate_limit", 429, 120), reply()])
    assert models == [TURBO, WHISPER]
    stt.asyncio.sleep.assert_not_awaited()
    assert result.full_text == "Hello."


def test_mai_is_last_resort_when_both_budget_models_fail(service, monkeypatch, tmp_path):
    error = stt.TranscriptionProviderError("rate_limit", 429)
    result, models = transcribe(service, monkeypatch, tmp_path, [error, error, error, error, reply()])
    assert models == [TURBO, TURBO, WHISPER, WHISPER, MAI]
    assert result.model == MAI


def test_quality_can_recover_on_a_budget_model(service, monkeypatch, tmp_path):
    service.settings.transcription_model = MAI
    error = stt.TranscriptionProviderError("network", 503)
    result, models = transcribe(service, monkeypatch, tmp_path, [error, error, reply()])
    assert models == [MAI, MAI, WHISPER]
    assert result.model == WHISPER


@pytest.mark.parametrize("error", [
    stt.TranscriptionProviderError("auth", 401), stt.TranscriptionProviderError("auth", 403),
    stt.TranscriptionProviderError("quota", 402), stt.TranscriptionProviderError("rejected", 307),
    stt.TranscriptionProviderError("response_too_large", 200),
    stt.TranscriptionError("too large", reason="audio_chunk_too_large"),
])
def test_fatal_errors_do_not_retry_or_switch(service, monkeypatch, tmp_path, error):
    with pytest.raises(stt.TranscriptionError) as caught:
        transcribe(service, monkeypatch, tmp_path, [error, reply()])
    assert caught.value is error
    assert service._request_transcript.await_count == 1
    stt.asyncio.sleep.assert_not_awaited()


def test_all_busy_models_stop_after_six_requests(service, monkeypatch, tmp_path):
    with pytest.raises(stt.TranscriptionProviderError) as caught:
        transcribe(service, monkeypatch, tmp_path, [stt.TranscriptionProviderError("rate_limit", 429)] * 7)
    assert service._request_transcript.await_count == 6
    assert caught.value.reason == "rate_limit"
    assert safe_failure_code(caught.value) == "transcription.rate_limit"
    assert "temporarily rate limited" in safe_processing_error(caught.value)


def test_auth_failure_on_fallback_stops_recovery(service, monkeypatch, tmp_path):
    with pytest.raises(stt.TranscriptionProviderError, match="auth"):
        transcribe(service, monkeypatch, tmp_path,
                   [stt.TranscriptionProviderError("unavailable", 404), stt.TranscriptionProviderError("auth", 401), reply()])
    assert service._request_transcript.await_count == 2


def test_unusable_billed_responses_are_included_in_cost(service, monkeypatch, tmp_path):
    missing = {"text": "Hello", "usage": {"seconds": 2, "cost": .002}}
    invalid = reply(start=3, end=1, cost=.003)
    result, models = transcribe(service, monkeypatch, tmp_path, [missing, invalid, reply(cost=0)])
    assert models == [TURBO, WHISPER, MAI]
    assert result.model == f"{TURBO} + {WHISPER} + {MAI}"
    assert result.api_costs.estimated_cost_usd == .005
    assert result.api_costs.audio_duration_seconds == 6
    assert result.api_costs.attempts == 3
    assert result.full_text == "Hello."


def test_all_models_missing_timing_do_not_invent_captions(service, monkeypatch, tmp_path):
    with pytest.raises(stt.TranscriptionError) as caught:
        transcribe(service, monkeypatch, tmp_path, [{"text": "spoken words"}] * 3)
    assert caught.value.reason == "missing_word_timestamps"
    assert service._request_transcript.await_count == 3


def test_recovery_keeps_completed_chunks_and_source_offsets(service, monkeypatch, tmp_path):
    missing = stt.TranscriptionProviderError("unavailable", 404)
    result, models = transcribe(service, monkeypatch, tmp_path, [
        reply("First.", .1, .5), missing, reply("Second.", 1.3, 1.8), reply("Tail.", 1.1, 1.5),
    ], duration=601)
    assert models == [TURBO, TURBO, WHISPER, WHISPER]
    assert [s.start_time_ms for s in result.segments] == [100, 300300, 600100]
    assert result.full_text == "First. Second. Tail."
    assert result.api_costs.estimated_cost_usd == .003
    assert result.api_costs.attempts == 4
    assert list(tmp_path.iterdir()) == [tmp_path / "source.wav"]


def test_silence_does_not_trigger_fallback(service, monkeypatch, tmp_path):
    result, models = transcribe(service, monkeypatch, tmp_path, [{"text": "", "usage": {"cost": 0}}])
    assert models == [TURBO]
    assert result.segments == []
    assert result.api_costs.estimated_cost_usd == 0


def test_cancellation_during_backoff_stops_all_requests(service, monkeypatch, tmp_path):
    monkeypatch.setattr(stt.asyncio, "sleep", AsyncMock(side_effect=asyncio.CancelledError))
    with pytest.raises(asyncio.CancelledError):
        transcribe(service, monkeypatch, tmp_path, [stt.TranscriptionProviderError("rate_limit", 429), reply()])
    assert service._request_transcript.await_count == 1


@pytest.mark.parametrize("value,expected", [(None, None), ("", None), ("5", 5), ("0", 0),
                                          ("-2", 0), ("nan", None), ("inf", None), ("bad header", None)])
def test_retry_after_seconds(value, expected):
    assert stt._retry_after_seconds(value) == expected


def test_retry_after_http_date():
    future = datetime.now(timezone.utc) + timedelta(seconds=10)
    assert 8 <= stt._retry_after_seconds(format_datetime(future, usegmt=True)) <= 10


def test_credit_failure_has_distinct_safe_message():
    error = stt.TranscriptionProviderError("quota", 402)
    message = safe_processing_error(error)
    assert message == "Transcription account credit limit reached"
    assert safe_job_error_text(message) == message
    assert safe_job_error_text("Transcription quota or rate limit reached") != "Processing failed"


class Body(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks, self.reads, self.closed = chunks, 0, False

    async def __aiter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk

    async def aclose(self):
        self.closed = True


def request(service, monkeypatch, tmp_path, *, status=200, body=None, headers=None):
    audio = tmp_path / "request.wav"
    audio.write_bytes(b"test audio")
    body = body or Body([json.dumps(reply()).encode()])
    calls = []
    real_client = httpx.AsyncClient

    async def handle(req):
        assert req.headers["accept-encoding"] == "identity"
        calls.append(json.loads(req.content))
        return httpx.Response(status, stream=body, headers=headers)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    result = asyncio.run(service._request_transcript(str(audio), "en", ["BridgeClip"], WHISPER))
    return result, calls, body


@pytest.mark.parametrize("status,reason", [(429, "rate_limit"), (402, "quota"), (401, "auth"),
                                          (403, "auth"), (503, "network"), (408, "network"),
                                          (404, "unavailable"), (400, "bad_request"), (422, "bad_request"), (307, "rejected")])
def test_http_classification_and_private_response_not_read(service, monkeypatch, tmp_path, status, reason):
    body = Body([b"private-provider-details"])
    with pytest.raises(stt.TranscriptionProviderError) as caught:
        request(service, monkeypatch, tmp_path, status=status, body=body, headers={"retry-after": "7"})
    assert caught.value.reason == reason
    assert caught.value.status_code == status
    assert caught.value.retry_after_seconds == 7
    assert "private" not in str(caught.value)
    assert body.closed and body.reads == 0


def test_fallback_model_request_retains_word_timing_contract(service, monkeypatch, tmp_path):
    _, calls, body = request(service, monkeypatch, tmp_path)
    payload = calls[0]
    assert payload["model"] == WHISPER
    assert payload["timestamp_granularities"] == ["segment", "word"]
    assert payload["response_format"] == "verbose_json"
    assert payload["provider"]["options"]["groq"]["prompt"] == "Expected vocabulary: BridgeClip"
    assert "azure" not in payload["provider"]["options"]
    assert body.closed


def test_error_inside_200_response_preserves_rate_limit(service, monkeypatch, tmp_path):
    body = Body([b'{"error":{"code":429,"message":"private detail"}}'])
    with pytest.raises(stt.TranscriptionProviderError) as caught:
        request(service, monkeypatch, tmp_path, body=body, headers={"retry-after": "3"})
    assert caught.value.reason == "rate_limit"
    assert caught.value.status_code == 429
    assert caught.value.retry_after_seconds == 3


def test_compressed_reply_rejected_before_reading(service, monkeypatch, tmp_path):
    body = Body([b"compressed data"])
    with pytest.raises(stt.TranscriptionProviderError, match="invalid_response"):
        request(service, monkeypatch, tmp_path, body=body, headers={"content-encoding": "gzip"})
    assert body.closed and body.reads == 0


def test_oversized_stream_is_bounded_and_closed(service, monkeypatch, tmp_path):
    monkeypatch.setattr(stt, "MAX_TRANSCRIPTION_RESPONSE_BYTES", 1024)
    body = Body([b"x" * 600, b"x" * 600, b"must not read"])
    with pytest.raises(stt.TranscriptionProviderError, match="response_too_large"):
        request(service, monkeypatch, tmp_path, body=body)
    assert body.closed and body.reads == 2
