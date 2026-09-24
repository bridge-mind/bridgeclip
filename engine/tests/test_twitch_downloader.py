"""Twitch saved videos use guarded native downloads and full-source timestamps."""
import asyncio
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from clip_engine.error_policy import safe_failure_code, safe_processing_error, safe_job_error_text
from clip_engine.services import video_downloader as module

URL = 'https://www.twitch.tv/videos/12345'

@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(module, 'get_settings', lambda: SimpleNamespace(local_mode=True, max_download_duration_seconds=21600))
    return module.VideoDownloaderService()

@pytest.mark.parametrize('host', ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv'])
def test_canonical_vod_hosts(service, host):
    url = f'https://{host}/videos/12345/?t=30s&tracking=secret#x'
    assert service.detect_source_type(url) == 'twitch'
    assert module.twitch_vod_url(url) == URL

@pytest.mark.parametrize('url', ['https://twitch.tv/channel', 'https://twitch.tv/collections/abc', 'https://clips.twitch.tv/Clip', 'https://player.twitch.tv/?video=12345', 'https://twitch.tv/videos/nope', 'https://www.twitch.tv./videos/12345', 'https://user:pass@twitch.tv/videos/12345', 'https://twitch.tv:8443/videos/12345', 'https://twitch.tv:bad/videos/12345'])
def test_other_twitch_pages_never_download_as_html(service, url):
    with pytest.raises(module.VideoDownloadError) as error:
        service.detect_source_type(url)
    assert safe_failure_code(error.value) == 'download.twitch_unsupported'

@pytest.mark.parametrize('url', ['https://twitch.tv.evil.test/videos/12345', 'https://eviltwitch.tv/videos/12345', 'https://example.com/video.mp4'])
def test_exact_host_matching(service, url):
    assert service.detect_source_type(url) == 'direct_url'

@pytest.mark.parametrize('info, reason', [({'is_live': True, 'duration': 10}, 'twitch_not_completed'), ({'live_status': 'is_upcoming', 'duration': 10}, 'twitch_not_completed'), ({'live_status': 'post_live', 'duration': 10}, 'twitch_not_completed'), *[({'duration': value}, 'twitch_duration') for value in [None, 0, -1, float('nan'), float('inf'), 21601]]])
def test_metadata_rejection(service, info, reason):
    with pytest.raises(module.VideoDownloadError) as error:
        service._validate_twitch_info(info, 21600)
    assert error.value.reason == reason
    assert safe_job_error_text(safe_processing_error(error.value)) == safe_processing_error(error.value)


def fake_download(monkeypatch, service, tmp_path, second_info=None, fail=None, progress=None):
    captured = []
    guards = []
    active = set()
    @contextmanager
    def guard(name):
        active.add(name)
        guards.append(name)
        try:
            yield
        finally:
            active.remove(name)
    monkeypatch.setattr(module, 'guarded_public_connections', lambda: guard('network'))
    monkeypatch.setattr(module, 'guarded_ytdlp_children', lambda deadline: guard('children'))
    info = {'title': 'Saved stream', 'duration': 60, 'width': None, 'height': None, 'fps': None, 'was_live': True, 'is_live': None, 'uploader': 'Streamer'}
    class FakeYDL:
        def __init__(self, options):
            self.options = options
            captured.append(options)
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def extract_info(self, url, download=False):
            assert active == {'network', 'children'}
            assert url == URL
            return info
        def download(self, urls):
            assert active == {'network', 'children'}
            assert urls == [URL]
            self.options['match_filter'](second_info or info, incomplete=False)
            Path(self.options['outtmpl'] + '.part').write_bytes(b'partial')
            if fail: raise fail
            for hook in self.options['progress_hooks']:
                hook(progress or {'downloaded_bytes': 7})
            Path(self.options['outtmpl']).write_bytes(b'media')
    monkeypatch.setattr(module.yt_dlp, 'YoutubeDL', FakeYDL)
    probe = module.VideoMetadata('probe', 59, 1280, 720, 30, 'probe', 'ffprobe')
    service._get_video_metadata_ffprobe = AsyncMock(return_value=probe)
    return captured, guards


def test_download_uses_native_guarded_vod_and_actual_probe(service, monkeypatch, tmp_path):
    captured, guards = fake_download(monkeypatch, service, tmp_path)
    result = asyncio.run(service.download_video(URL + '?t=20s', str(tmp_path)))
    assert result.source_type == result.metadata.source_type == 'twitch'
    assert (result.metadata.duration_seconds, result.metadata.width, result.metadata.title, result.metadata.uploader) == (59, 1280, 'Saved stream', 'Streamer')
    assert guards == ['children', 'network', 'children', 'network']
    for options in captured:
        assert options['allowed_extractors'] == ['twitch:vod']
        assert options['proxy'] == ''
        assert options['external_downloader'] == 'native'
        assert options['hls_prefer_native'] is True
        assert 'download_ranges' not in options
    assert captured[-1]['format'] == 'b[vcodec!^=av01]'
    assert captured[-1]['skip_unavailable_fragments'] is False


def test_live_status_is_rechecked_at_download(service, monkeypatch, tmp_path):
    fake_download(monkeypatch, service, tmp_path, second_info={'is_live': True, 'duration': 60})
    with pytest.raises(module.VideoDownloadError) as error:
        asyncio.run(service.download_video(URL, str(tmp_path)))
    assert error.value.reason == 'twitch_not_completed'
    service._get_video_metadata_ffprobe.assert_not_called()

@pytest.mark.parametrize('progress', [{'downloaded_bytes': module.MAX_SOURCE_BYTES + 1}, {'total_bytes_estimate': module.MAX_SOURCE_BYTES + 1}])
def test_oversize_downloads_remove_partials(service, monkeypatch, tmp_path, progress):
    fake_download(monkeypatch, service, tmp_path, progress=progress)
    with pytest.raises(module.VideoDownloadError, match='20 GB'):
        asyncio.run(service.download_video(URL, str(tmp_path)))
    assert not list(tmp_path.iterdir())


def test_unknown_hls_size_still_checks_free_space(service, monkeypatch, tmp_path):
    fake_download(monkeypatch, service, tmp_path)
    monkeypatch.setattr(module.shutil, 'disk_usage', lambda _: SimpleNamespace(free=module.MIN_FREE_BYTES-1))
    with pytest.raises(module.VideoDownloadError) as error:
        asyncio.run(service.download_video(URL, str(tmp_path)))
    assert safe_failure_code(error.value) == 'storage.full'
    assert not list(tmp_path.iterdir())


def test_provider_details_are_sanitized_and_partial_removed(service, monkeypatch, tmp_path):
    fake_download(monkeypatch, service, tmp_path, fail=RuntimeError('HTTP Error 403 https://secret.invalid/token'))
    with pytest.raises(module.VideoDownloadError) as error:
        asyncio.run(service.download_video(URL, str(tmp_path)))
    assert safe_processing_error(error.value) == 'Twitch VOD unavailable'
    assert safe_failure_code(error.value) == 'download.twitch_unavailable'
    assert not list(tmp_path.iterdir())


def test_real_native_hls_download_and_probe(service, monkeypatch, tmp_path):
    """Exercise real yt-dlp fragments, match filter, FFmpeg mux and ffprobe offline.

    Only the fake Twitch metadata response and this fixture server's exact socket
    are substituted. Native-child and network guards stay installed throughout.
    """
    import functools
    import http.server
    import os
    import shutil
    import subprocess
    import threading
    from clip_engine import network_policy
    from yt_dlp.extractor.twitch import TwitchVodIE
    from yt_dlp.downloader.hls import HlsFD

    bundled = Path(__file__).resolve().parents[2] / 'engine-bin'
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg and ffprobe required for native HLS fixture')
    media = tmp_path / 'hls'
    media.mkdir()
    subprocess.run([
        'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-g', '10', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
        str(media / 'vod.m3u8'),
    ], check=True, capture_output=True)
    monkeypatch.setenv('PATH', str(bundled) + os.pathsep + os.environ.get('PATH', ''))
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_): pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(media)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    endpoint = f'http://127.0.0.1:{server.server_port}/vod.m3u8'
    original_check = network_policy._public_socket_address
    contacts = []
    def fixture_socket(sock, address):
        if address[:2] == ('127.0.0.1', server.server_port):
            contacts.append(address)
            return address
        return original_check(sock, address)
    monkeypatch.setattr(network_policy, '_public_socket_address', fixture_socket)
    extractions = []
    def fixture_extract(self, url):
        extractions.append(url)
        return {
            'id': '12345', 'title': 'Native HLS fixture', 'duration': 2, 'was_live': True,
            'formats': [{'url': endpoint, 'format_id': 'source', 'ext': 'mp4', 'protocol': 'm3u8_native',
                         'vcodec': 'avc1.42e01e', 'acodec': 'mp4a.40.2', 'width': 160, 'height': 90}],
        }
    monkeypatch.setattr(TwitchVodIE, '_real_extract', fixture_extract)
    native_download = HlsFD.real_download
    native_calls = []
    def record_native(self, filename, info):
        native_calls.append(info['url'])
        return native_download(self, filename, info)
    monkeypatch.setattr(HlsFD, 'real_download', record_native)
    try:
        result = asyncio.run(service.download_video(URL + '?t=1s', str(tmp_path / 'download')))
        assert extractions == [URL, URL]
        assert native_calls == [endpoint]
        assert len(contacts) >= 3  # manifest and both media fragments
        assert result.source_type == 'twitch'
        assert result.metadata.width == 160
        assert result.metadata.height == 90
        assert 1.9 <= result.metadata.duration_seconds <= 2.3
        assert result.file_size_bytes > 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_default_ports_match_browser_normalization(service):
    assert module.twitch_vod_url('https://twitch.tv:443/videos/12345') == URL
    assert module.twitch_vod_url('http://twitch.tv:80/videos/12345') == URL


def test_missing_metadata_is_an_unavailable_vod(service):
    with pytest.raises(module.VideoDownloadError) as error:
        service._validate_twitch_info(None, 21600)
    assert error.value.reason == 'twitch_unavailable'
