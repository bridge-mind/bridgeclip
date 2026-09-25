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


def test_server_retains_configured_x264():
    service = RenderingService.__new__(RenderingService)
    service.settings = SimpleNamespace(local_mode=False, ffmpeg_preset="fast", ffmpeg_crf=21)
    args = service._video_codec_args()
    assert args[:6] == ["-c:v", "libx264", "-preset", "fast", "-crf", "21"]
