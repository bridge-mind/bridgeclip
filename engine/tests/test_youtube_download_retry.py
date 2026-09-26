"""A YouTube 403 on freshly extracted media URLs is retried with a new extraction."""
import asyncio
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from clip_engine.services import video_downloader as module

URL = 'https://www.youtube.com/watch?v=qY3_rbtMtm4'
FORBIDDEN = 'ERROR: unable to download video data: HTTP Error 403: Forbidden'


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(module, 'get_settings', lambda: SimpleNamespace(local_mode=True, max_download_duration_seconds=21600))
    return module.VideoDownloaderService()


def fake_youtube(monkeypatch, service, failures):
    """Each yt-dlp run raises the next failure, then writes the media once they run out."""
    runs, sleeps = [], []
    monkeypatch.setattr(module, 'guarded_public_connections', nullcontext)
    monkeypatch.setattr(module, 'guarded_ytdlp_children', lambda deadline: nullcontext())
    monkeypatch.setattr(module.time, 'sleep', sleeps.append)
    metadata = module.VideoMetadata('Talk', 60, 1280, 720, 30, 'youtube', 'Channel')
    service._get_video_info = AsyncMock(return_value=metadata)
    service._get_video_metadata_ffprobe = AsyncMock(return_value=metadata)
    failures = list(failures)

    class FakeYDL:
        def __init__(self, options):
            self.options = options
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def download(self, urls):
            runs.append(self.options['format'])
            Path(self.options['outtmpl'] + '.part').write_bytes(b'partial')
            if failures:
                raise module.yt_dlp.utils.DownloadError(failures.pop(0))
            Path(self.options['outtmpl']).write_bytes(b'media')
    monkeypatch.setattr(module.yt_dlp, 'YoutubeDL', FakeYDL)
    return runs, sleeps


def test_one_forbidden_media_url_is_retried_with_fresh_extraction(service, monkeypatch, tmp_path):
    runs, sleeps = fake_youtube(monkeypatch, service, [FORBIDDEN])
    asyncio.run(service.download_video(URL, str(tmp_path)))
    assert runs == [module.YOUTUBE_FORMAT_SELECTORS[0]] * 2
    assert sleeps == [2]
    assert (tmp_path / 'source.mp4').read_bytes() == b'media'


def test_persistent_forbidden_fails_after_bounded_retries(service, monkeypatch, tmp_path):
    runs, sleeps = fake_youtube(monkeypatch, service, [FORBIDDEN] * 5)
    with pytest.raises(module.VideoDownloadError):
        asyncio.run(service.download_video(URL, str(tmp_path)))
    assert len(runs) == module.YOUTUBE_TRANSIENT_ATTEMPTS
    assert sleeps == [2, 5]
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('error', ['ERROR: unable to download video data: HTTP Error 404: Not Found',
                                   'ERROR: unable to download webpage: HTTP Error 429: Too Many Requests'])
def test_missing_video_or_rate_limit_is_not_retried(service, monkeypatch, tmp_path, error):
    runs, sleeps = fake_youtube(monkeypatch, service, [error])
    with pytest.raises(module.VideoDownloadError):
        asyncio.run(service.download_video(URL, str(tmp_path)))
    assert len(runs) == 1 and sleeps == []


@pytest.mark.parametrize('message, transient', [
    (FORBIDDEN, True),
    ('ERROR: unable to download video data: HTTP Error 503: Service Unavailable', True),
    ('ERROR: unable to download video data: <urlopen error timed out>', True),
    ('Connection reset by peer', True),
    ('ERROR: unable to download video data: HTTP Error 408: Request Timeout', True),
    ('ERROR: unable to download video data: HTTP Error 404: Not Found', False),
    ('ERROR: unable to download webpage: HTTP Error 429: Too Many Requests', False),
    ('ERROR: Postprocessing: Conversion failed!', False),
])
def test_transient_classification(message, transient):
    assert module.is_transient_download_error(message) is transient
