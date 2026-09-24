"""MAI transcription contract tests, using no credentials or paid requests."""

import asyncio
import base64
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


SOURCE = Path(__file__).resolve().parents[1] / "engine/clip_engine/services/transcription_service.py"
spec = importlib.util.spec_from_file_location("mai_transcription_under_test", SOURCE)
stt = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = stt
with patch.dict(sys.modules, {
    "clip_engine.config": types.SimpleNamespace(get_settings=lambda: types.SimpleNamespace(
        openrouter_api_key="test-openrouter", transcription_diarize=True,
        transcription_model="microsoft/mai-transcribe-2")),
    "clip_engine.services.media_process": types.SimpleNamespace(
        MEDIA_INPUT_OPTIONS=[], run_media=lambda *args, **kwargs: None),
}):
    spec.loader.exec_module(stt)


class TranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.service = stt.TranscriptionService()

    def test_word_times_speaker_zero_and_actual_cost_are_preserved(self):
        result = self.service._parse_openrouter_response({
            "text": "Hello there. Hi!", "language": "en", "duration": 6.4,
            "words": [
                {"word": "Hello", "start": 0.2, "end": 0.5, "speaker": 0},
                {"word": "there.", "start": 0.5, "end": 1.2, "speaker": 0},
                {"word": "Hi!", "start": 1.5, "end": 2.1, "speaker": 1},
            ], "usage": {"seconds": 6.4, "cost": 0.000178},
        }, 6.4)
        self.assertEqual([s.speaker_label for s in result.segments], ["S1", "S2"])
        self.assertEqual(result.segments[0].words[0].start_time_ms, 200)
        self.assertEqual(result.segments[1].end_time_ms, 2100)
        self.assertEqual(result.provider, "openrouter")
        self.assertEqual(result.model, "microsoft/mai-transcribe-2")
        self.assertEqual(result.api_costs.estimated_cost_usd, 0.000178)

    def test_silence_is_valid_but_speech_without_word_times_is_not(self):
        self.assertEqual(self.service._parse_openrouter_response({"text": ""}, 2).segments, [])
        with self.assertRaisesRegex(stt.TranscriptionError, "word timestamps"):
            self.service._parse_openrouter_response({"text": "hello"}, 2)

    def test_rejects_invalid_word_timestamps(self):
        for start, end in [(float("nan"), 1), (True, 1), (-1, 1), (2, 1), (0, 100)]:
            with self.subTest(start=start, end=end), self.assertRaises(stt.TranscriptionProviderError):
                self.service._parse_openrouter_response({"text": "hello", "words": [
                    {"word": "hello", "start": start, "end": end}
                ]}, 2)

    def test_zero_cost_is_not_replaced_by_an_estimate(self):
        result = self.service._parse_openrouter_response({"text": "", "usage": {"cost": 0, "seconds": 2}}, 2)
        self.assertEqual(result.api_costs.estimated_cost_usd, 0)
        self.assertEqual(stt._estimate_transcription_cost(3600), 0.1)
        self.assertEqual(stt._estimate_transcription_cost(3600, stt.BUDGET_TRANSCRIPTION_MODEL), 0.0108)
        self.assertEqual(stt._estimate_transcription_cost(3600, stt.BUDGET_FALLBACK_MODEL), 0.0288)

    def test_chunk_overlap_offsets_and_speaker_scope(self):
        responses = [
            {"text": "First edge", "words": [{"word": "First", "start": .1, "end": .3, "speaker": 0},
                                               {"word": "edge", "start": 299.8, "end": 300.2, "speaker": 0}]},
            {"text": "edge next", "words": [{"word": "edge", "start": .8, "end": 1.2, "speaker": 0},
                                              {"word": "next", "start": 1.3, "end": 2, "speaker": 0}]},
            {"text": "tail", "words": [{"word": "tail", "start": .9, "end": 1.5, "speaker": 0}]},
        ]
        with tempfile.TemporaryDirectory() as work:
            source = Path(work) / "source.wav"
            source.write_bytes(b"audio")
            with patch.object(self.service, "_audio_duration", return_value=601), \
                 patch.object(self.service, "_extract_chunk") as extract, \
                 patch.object(self.service, "_request_transcript", new=AsyncMock(side_effect=responses)):
                result = asyncio.run(self.service.transcribe_audio(str(source)))
            self.assertEqual(result.full_text, "First edge next tail")
            self.assertEqual([s.speaker_label for s in result.segments], ["C1S1", "C2S1", "C3S1"])
            self.assertEqual(result.segments[1].words[0].start_time_ms, 299800)
            self.assertEqual(result.segments[-1].end_time_ms, 600500)
            self.assertEqual(extract.call_count, 3)
            self.assertEqual(list(Path(work).iterdir()), [source])

    def test_range_window_is_extracted_once_and_shifted_onto_the_source_clock(self):
        response = {"text": "mid word", "words": [{"word": "mid", "start": .5, "end": .9, "speaker": 0},
                                                  {"word": "word", "start": 1.0, "end": 1.4, "speaker": 0}]}
        with tempfile.TemporaryDirectory() as work:
            video = Path(work) / "source.mp4"
            video.write_bytes(b"video")
            extracted = []

            async def extract(video_path, audio_path, start_seconds=0.0, end_seconds=None):
                extracted.append((start_seconds, end_seconds))
                Path(audio_path).write_bytes(b"audio")

            with patch.object(self.service, "_extract_audio_from_video", new=extract), \
                 patch.object(self.service, "_audio_duration", return_value=70), \
                 patch.object(self.service, "_request_transcript", new=AsyncMock(return_value=response)):
                result = asyncio.run(self.service.transcribe(str(video), work, start_seconds=600, end_seconds=660))
            self.assertEqual(extracted, [(595.0, 665.0)])
            self.assertEqual(result.segments[0].words[0].start_time_ms, 595500)
            self.assertEqual(result.segments[0].end_time_ms, 596400)
            self.assertEqual(list(Path(work).iterdir()), [video])

    def test_economy_tries_other_budget_model_when_word_timestamps_are_unavailable(self):
        fallback = {"text": "Hello", "words": [{"word": "Hello", "start": 0.1, "end": 0.5}]}
        for first in (stt.TranscriptionProviderError("bad_request", 400), {"text": "Hello"}):
            with self.subTest(first=type(first).__name__), tempfile.TemporaryDirectory() as work:
                source = Path(work) / "source.wav"
                source.write_bytes(b"audio")
                self.service.settings.transcription_model = stt.BUDGET_TRANSCRIPTION_MODEL
                request = AsyncMock(side_effect=[first, fallback])
                with patch.object(self.service, "_audio_duration", return_value=2), \
                     patch.object(self.service, "_request_transcript", new=request):
                    result = asyncio.run(self.service.transcribe_audio(str(source)))
                self.assertEqual([call.args[3] for call in request.call_args_list],
                                 [stt.BUDGET_TRANSCRIPTION_MODEL, stt.BUDGET_FALLBACK_MODEL])
                self.assertIn(stt.BUDGET_FALLBACK_MODEL, result.model)
                self.assertIn(stt.BUDGET_FALLBACK_MODEL, result.api_costs.model)
                self.assertEqual(result.full_text, "Hello")

    def test_mixed_economy_fallback_reports_both_models_and_combined_cost(self):
        whisper = {"text": "first", "words": [{"word": "first", "start": 0.1, "end": 0.5}],
                   "usage": {"seconds": 300, "cost": 0.0009}}
        mai = {"text": "last", "words": [{"word": "last", "start": 1.1, "end": 1.5}],
               "usage": {"seconds": 3, "cost": 0.000083}}
        with tempfile.TemporaryDirectory() as work:
            source = Path(work) / "source.wav"
            source.write_bytes(b"audio")
            self.service.settings.transcription_model = stt.BUDGET_TRANSCRIPTION_MODEL
            request = AsyncMock(side_effect=[whisper, {"text": "last", "usage": {"seconds": 3, "cost": 0.000009}}, mai])
            with patch.object(self.service, "_audio_duration", return_value=302), \
                 patch.object(self.service, "_extract_chunk"), \
                 patch.object(self.service, "_request_transcript", new=request):
                result = asyncio.run(self.service.transcribe_audio(str(source)))
        expected = f"{stt.BUDGET_TRANSCRIPTION_MODEL} + {stt.BUDGET_FALLBACK_MODEL}"
        self.assertEqual(result.model, expected)
        self.assertEqual(result.api_costs.model, expected)
        # The response discarded for missing timestamps was billed too.
        self.assertEqual(result.api_costs.estimated_cost_usd, 0.000992)
        self.assertEqual(result.api_costs.audio_duration_seconds, 306)
        self.assertEqual([call.args[3] for call in request.call_args_list],
                         [stt.BUDGET_TRANSCRIPTION_MODEL, stt.BUDGET_TRANSCRIPTION_MODEL, stt.BUDGET_FALLBACK_MODEL])

    def test_request_shape_and_sanitized_http_failures(self):
        calls = []

        class Response:
            status_code = 200
            headers = {}
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def aiter_raw(self): yield json.dumps({"text": ""}).encode()

        response = Response()

        class Client:
            def __init__(self, **kwargs): calls.append(kwargs)
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def stream(self, *args, **kwargs):
                calls.append((args, kwargs))
                return response

        class HTTPError(Exception): pass
        httpx = types.SimpleNamespace(AsyncClient=Client, Timeout=lambda *a, **k: 90,
                                      TimeoutException=HTTPError, NetworkError=HTTPError, HTTPError=HTTPError)
        with tempfile.TemporaryDirectory() as work, patch.dict(sys.modules, {"httpx": httpx}):
            audio = Path(work) / "audio.wav"
            audio.write_bytes(b"test audio")
            asyncio.run(self.service._request_transcript(str(audio), "en", ["BridgeClip", "BridgeClip"]))
            args, request = calls[-1]
            self.assertEqual(args, ("POST", "https://openrouter.ai/api/v1/audio/transcriptions"))
            self.assertEqual(request["headers"]["Authorization"], "Bearer test-openrouter")
            self.assertFalse(calls[0]["follow_redirects"])
            payload = request["json"]
            self.assertEqual(payload["model"], "microsoft/mai-transcribe-2")
            self.assertEqual(base64.b64decode(payload["input_audio"]["data"]), b"test audio")
            self.assertEqual(payload["input_audio"]["format"], "wav")
            self.assertEqual(payload["timestamp_granularities"], ["segment", "word"])
            self.assertEqual(payload["provider"]["options"]["azure"], {
                "diarization": {"enabled": True}, "phraseList": {"phrases": ["BridgeClip"]},
            })
            self.service.settings.transcription_model = stt.BUDGET_TRANSCRIPTION_MODEL
            asyncio.run(self.service._request_transcript(str(audio), "en", ["BridgeClip"]))
            budget_payload = calls[-1][1]["json"]
            self.assertEqual(budget_payload["model"], stt.BUDGET_TRANSCRIPTION_MODEL)
            self.assertNotIn("azure", budget_payload.get("provider", {}).get("options", {}))
            self.assertEqual(budget_payload["provider"]["options"]["groq"]["prompt"], "Expected vocabulary: BridgeClip")
            self.assertEqual(self.service._parse_openrouter_response({"text": ""}, 3600).api_costs.model, stt.BUDGET_TRANSCRIPTION_MODEL)
            for status, reason in [(400, "bad_request"), (401, "auth"), (403, "auth"), (402, "quota"), (429, "rate_limit"), (503, "network"), (307, "rejected")]:
                response.status_code = status
                with self.subTest(status=status), self.assertRaises(stt.TranscriptionProviderError) as caught:
                    asyncio.run(self.service._request_transcript(str(audio), None, None))
                self.assertEqual(caught.exception.reason, reason)
                self.assertEqual(caught.exception.status_code, status)


if __name__ == "__main__":
    unittest.main()
