"""The desktop bundle must never require an absent GPL encoder or a GPU."""
from types import SimpleNamespace
import pytest
from clip_engine.services.rendering_service import RenderingService


@pytest.mark.parametrize("platform,encoder", [("darwin", "h264_videotoolbox"), ("win32", "libopenh264"), ("linux", "libopenh264")])
def test_desktop_encoder_matches_lgpl_bundle(monkeypatch, platform, encoder):
    monkeypatch.setattr("clip_engine.services.rendering_service.sys.platform", platform)
    service = RenderingService.__new__(RenderingService)
    service.settings = SimpleNamespace(local_mode=True)
    args = service._video_codec_args(1920, 1080, "60")
    assert args[args.index("-c:v") + 1] == encoder
    assert args[args.index("-b:v") + 1] == "18M"
    assert args[args.index("-g") + 1] == "120"
    assert "-crf" not in args
    if platform == "darwin":
        assert args[args.index("-allow_sw") + 1] == "1"


def test_server_retains_configured_x264():
    service = RenderingService.__new__(RenderingService)
    service.settings = SimpleNamespace(local_mode=False, ffmpeg_preset="fast", ffmpeg_crf=21)
    args = service._video_codec_args()
    assert args[:6] == ["-c:v", "libx264", "-preset", "fast", "-crf", "21"]


@pytest.mark.parametrize("available,expected", [("libx264", "libx264"), ("libx264 libopenh264", "libopenh264")])
def test_system_ffmpeg_remains_usable_for_local_development(monkeypatch, available, expected):
    monkeypatch.setattr("clip_engine.services.rendering_service.sys.platform", "linux")
    monkeypatch.setattr("clip_engine.services.rendering_service.shutil.which", lambda _: "/test/ffmpeg")
    monkeypatch.setattr("clip_engine.services.rendering_service.run_media", lambda *a, **kw: SimpleNamespace(stdout=available.encode()))
    service = RenderingService.__new__(RenderingService)
    service.settings = SimpleNamespace(local_mode=True, ffmpeg_preset="fast", ffmpeg_crf=21)
    service._verify_ffmpeg()
    assert service._video_codec_args()[1] == expected
