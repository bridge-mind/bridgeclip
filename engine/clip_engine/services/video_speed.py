"""Export speed on the edited timeline; source analysis stays at original speed."""

import math


def validate_video_speed(speed: float) -> float:
    if type(speed) not in (int, float) or not math.isfinite(speed) or not 1 <= speed <= 2:
        raise ValueError("Video speed must be between 1x and 2x")
    return speed


def scaled_duration_ms(duration_ms: int, speed: float) -> int:
    return round(duration_ms / validate_video_speed(speed))


def speed_video_filter(speed: float, fps: str) -> str:
    validate_video_speed(speed)
    if speed == 1:
        return "null"
    # Use a fine time base before scaling, then return to the export frame grid.
    return f"settb=AVTB,setpts=(PTS-STARTPTS)/{speed:.8g},fps={fps}:start_time=0:round=near"


def speed_audio_filter(speed: float, duration_ms: int) -> str:
    validate_video_speed(speed)
    if speed == 1:
        return ""
    # atempo preserves pitch. Its overlap windows can leave a short tail;
    # bound/pad samples to the requested duration before rebuilding the clock.
    samples = round(duration_ms * 48 / speed)
    return f"atempo={speed:.8g},apad=whole_len={samples},atrim=end_sample={samples},"
