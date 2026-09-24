"""Callback replies are untrusted even when the destination is approved."""

import asyncio
from unittest.mock import patch

import httpx
import pytest

from clip_engine.network_policy import PinnedDestination
from clip_engine.services.webhook_service import WebhookPayload, WebhookService


class LargeReply(httpx.AsyncByteStream):
    def __init__(self):
        self.reads = 0
        self.closed = False

    async def __aiter__(self):
        self.reads += 1
        yield b"x" * (16 * 1024 * 1024)

    async def aclose(self):
        self.closed = True


@pytest.mark.parametrize("status", [204, 503])
def test_webhook_uses_status_without_reading_response_body(status):
    body = LargeReply()

    async def handle(request):
        assert request.headers["host"] == "callback.example"
        return httpx.Response(status, stream=body)

    async def run():
        service = object.__new__(WebhookService)
        service._allowed_hosts = "callback.example"
        service._webhook_secret = None
        service._send_semaphore = asyncio.Semaphore(1)
        service.max_retries = 1
        service._client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        payload = WebhookPayload(
            event="job.completed", timestamp="2026-09-24T00:00:00Z", job_id="job-1",
            status="completed", progress_percent=100, current_step="done",
        )
        destination = PinnedDestination(
            "https://8.8.8.8/notify", "callback.example", "callback.example",
        )
        try:
            with patch("clip_engine.services.webhook_service.resolve_public_destination", return_value=destination):
                return await service.send("https://callback.example/notify", payload)
        finally:
            await service._client.aclose()

    result = asyncio.run(run())
    assert result.success is (status == 204)
    assert result.status_code == (204 if status == 204 else None)
    assert body.reads == 0
    assert body.closed
