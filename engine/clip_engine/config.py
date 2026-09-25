"""
Configuration module using Pydantic Settings for environment variable management.

Only essential environment variables are exposed. All other settings are hardcoded
for consistency and simplicity.
"""

import os
from functools import lru_cache
from typing import List, Literal, Optional

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh")


# ============================================================
# ASPECT RATIO PRESETS
# ============================================================

class AspectRatioType:
    """
    Output aspect ratio identifiers.

    VERTICAL (9:16): Standard for TikTok, Reels, Shorts - uses face tracking and smart cropping.
    HORIZONTAL (16:9): For YouTube and LinkedIn - simpler center-crop with captions.
    """
    VERTICAL = "9:16"    # 1080x1920 - TikTok, Reels, Shorts (default)
    HORIZONTAL = "16:9"  # 1920x1080 - YouTube, LinkedIn


def get_output_dimensions(aspect_ratio: str) -> tuple[int, int]:
    """
    Get output dimensions for a given aspect ratio.

    Args:
        aspect_ratio: One of AspectRatioType constants ('9:16' or '16:9')

    Returns:
        Tuple of (width, height) in pixels
    """
    if aspect_ratio == AspectRatioType.HORIZONTAL:
        return (1920, 1080)
    # Default to vertical
    return (1080, 1920)


# Standard 16:9 heights a landscape render may use, largest first.
LANDSCAPE_HEIGHTS = (2160, 1440, 1080)


def get_landscape_dimensions(source_width: int, source_height: int) -> tuple[int, int]:
    """16:9 output size that keeps the source's detail: 4K, 1440p or 1080p.

    Picks the largest standard height the source can fill without upscaling
    (a 4:3 or vertical source is judged by the 16:9 frame it would fill), and
    never goes below 1080p.
    """
    if source_width <= 0 or source_height <= 0:
        return (1920, 1080)
    fillable = min(source_height, source_width * 9 / 16)
    for height in LANDSCAPE_HEIGHTS:
        if fillable >= height * 0.98:
            return (height * 16 // 9, height)
    return (1920, 1080)


# ============================================================
# CLIP DURATION PRESETS
# ============================================================

# User-facing clip length presets: key -> (min_s, max_s, prompt description).
DURATION_RANGES: dict[str, tuple[int, int, str]] = {
    "xshort": (10, 30, "10-30 seconds (quick, punchy clips)"),
    "short": (30, 60, "30-60 seconds (short clips)"),
    "medium": (60, 120, "1-2 minutes (moderate length clips)"),
    "long": (120, 300, "2-5 minutes (longer, in-depth clips)"),
    "xlong": (300, 600, "5-10 minutes (extra long clips)"),
    "extended": (600, 900, "10-15 minutes (extended clips)"),
    "feature": (900, 1800, "15-30 minutes (feature-length edits)"),
    # Legacy keys (still accepted)
    "landscape_short": (60, 120, "1-2 minutes (short landscape clips)"),
    "landscape_medium": (120, 300, "2-5 minutes (medium landscape clips)"),
    "landscape_long": (300, 600, "5-10 minutes (long landscape clips)"),
    "landscape_extended": (600, 1200, "10-20 minutes (extended landscape clips)"),
}
DEFAULT_CLIP_DURATION_SECONDS = (15, 90)

# 16:9 clips at least this long are planned, paced and rendered as longform
# episodes (YouTube-style) rather than as horizontal shorts.
LONGFORM_MIN_SECONDS = 300


def is_longform(aspect_ratio: str, min_clip_seconds: int) -> bool:
    """Whether a job's clips are longform edits (16:9 and 5+ minutes each)."""
    return aspect_ratio == AspectRatioType.HORIZONTAL and min_clip_seconds >= LONGFORM_MIN_SECONDS


def resolve_clip_duration_bounds(
    duration_ranges: Optional[list[str]] = None,
    min_seconds: Optional[int] = None,
    max_seconds: Optional[int] = None,
) -> tuple[int, int]:
    """(min_s, max_s) that the router, prompt and parser must all agree on.

    Selected presets win and span their union (short + long -> 30-300 s).
    Otherwise explicit bounds apply, then the 15-90 s default. A minimum on
    its own gets a max of at least twice itself, so clips have room to end
    on a sentence instead of all being cut at exactly the minimum.
    """
    known = [DURATION_RANGES[r] for r in duration_ranges or [] if r in DURATION_RANGES]
    if known:
        return min(k[0] for k in known), max(k[1] for k in known)
    low = min_seconds if min_seconds is not None else DEFAULT_CLIP_DURATION_SECONDS[0]
    if max_seconds is not None:
        high = max_seconds
    else:
        high = max(DEFAULT_CLIP_DURATION_SECONDS[1], 2 * low)
    return low, max(low, high)


class LayoutStyle:
    """How clips are framed for 9:16 output."""

    AUTO = "auto"  # detect each shot's layout and switch mid-clip
    FILL = "fill"  # always fill the frame, following the speaker
    FIT = "fit"    # classic: whole frame over a blurred background

    ALL = (AUTO, FILL, FIT)


def get_available_layout_styles() -> list[dict]:
    """Framing styles with UI metadata."""
    return [
        {
            "id": LayoutStyle.AUTO,
            "name": "Smart",
            "description": "Detects each shot and picks the best framing: speaker close-up, "
                           "two-person split, or screen with webcam. Switches mid-clip when the video does.",
        },
        {
            "id": LayoutStyle.FILL,
            "name": "Full Frame",
            "description": "Always fills the vertical frame and follows the speaker.",
        },
        {
            "id": LayoutStyle.FIT,
            "name": "Classic",
            "description": "Shows the whole original frame over a blurred background.",
        },
    ]


class CaptionStyle:
    """Caption styling configuration.

    Captions render as stacked ASS layers per event (backing box, soft shadow,
    glow, active-word pill, then the crisp face), so every effect is a real
    blurred bitmap instead of an offset copy of the text. `font_name` must be a
    family or full face name shipped in assets/fonts (e.g. "Montserrat Black");
    those faces carry their own weight, so `bold` stays off to avoid faux bold.
    """

    font_name: str = "Montserrat Black"
    font_size: int = 84
    bold: bool = False
    italic: bool = False
    uppercase: bool = True
    letter_spacing: int = 0
    position: Literal["top", "center", "bottom"] = "bottom"
    alignment: Literal["left", "center", "right"] = "center"
    max_words_per_line: int = 3
    word_by_word_highlight: bool = True

    primary_color: str = "#FFFFFF"
    highlight_color: str = "#FFE234"
    outline_color: str = "#000000"
    outline_width: int = 6

    # Soft drop shadow under the text (opacity 0 disables)
    shadow_color: str = "#000000"
    shadow_opacity: float = 0.6
    shadow_blur: int = 10
    shadow_offset: int = 7
    # Extra width of the shadow beyond the stroke; a wide spread reads as a halo
    shadow_spread: int = 2

    # Words not yet spoken: "show" (full group visible), "dim" (translucent)
    # or "hide" (revealed as spoken)
    future_words: Literal["show", "dim", "hide"] = "show"
    dim_opacity: float = 0.45

    # Pop the group in (scale overshoot) when it first appears
    entrance_pop: bool = True

    # Karaoke: color sweeps across each word as it's spoken (\kf)
    karaoke_fill: bool = False

    # Fade the active word from primary to highlight instead of switching
    color_transition: bool = False

    # Rounded pill behind the active word (best with uppercase text)
    highlight_box_color: Optional[str] = None
    highlight_box_padding: int = 16

    # Blurred bloom around the text (None disables)
    glow_color: Optional[str] = None
    glow_opacity: float = 0.8
    glow_radius: int = 8
    glow_blur: int = 14
    glow_active_only: bool = True

    # Rounded translucent plate behind the whole line (None disables)
    line_box_color: Optional[str] = None
    line_box_opacity: float = 0.6
    line_box_padding: int = 22

    # Keyword emphasis: planner-chosen punch words render in this color
    # (None disables). Chosen per preset to contrast with the highlight.
    emphasis_color: Optional[str] = None


# ============================================================
# CAPTION PRESETS
# ============================================================

class CaptionPreset:
    """Available caption preset identifiers."""

    POP = "pop"
    SPOTLIGHT = "spotlight"
    IMPACT = "impact"
    GLOW = "glow"
    BOXED = "boxed"
    SWEEP = "sweep"
    EDITORIAL = "editorial"
    HYPE = "hype"
    PUNCH = "punch"
    NEON = "neon"
    HEADLINE = "headline"
    PAPER = "paper"
    SUBTLE = "subtle"


DEFAULT_CAPTION_PRESET = CaptionPreset.POP


def get_caption_preset(preset_id: str) -> CaptionStyle:
    """Get a CaptionStyle for a given preset ID."""
    builders = {
        CaptionPreset.POP: _create_pop_style,
        CaptionPreset.SPOTLIGHT: _create_spotlight_style,
        CaptionPreset.IMPACT: _create_impact_style,
        CaptionPreset.GLOW: _create_glow_style,
        CaptionPreset.BOXED: _create_boxed_style,
        CaptionPreset.SWEEP: _create_sweep_style,
        CaptionPreset.EDITORIAL: _create_editorial_style,
        CaptionPreset.HYPE: _create_hype_style,
        CaptionPreset.PUNCH: _create_punch_style,
        CaptionPreset.NEON: _create_neon_style,
        CaptionPreset.HEADLINE: _create_headline_style,
        CaptionPreset.PAPER: _create_paper_style,
        CaptionPreset.SUBTLE: _create_subtle_style,
    }

    builder = builders.get(preset_id)
    if builder is None:
        valid_presets = list(builders.keys())
        raise ValueError(f"Unknown caption preset: {preset_id}. Valid presets: {valid_presets}")

    return builder()


def get_available_presets() -> list[dict]:
    """Get list of available caption presets with metadata."""
    return [
        {
            "id": CaptionPreset.POP,
            "name": "Pop",
            "description": "Heavy white type, yellow active word and a springy pop-in - the all-rounder",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#FFE234"},
        },
        {
            "id": CaptionPreset.SPOTLIGHT,
            "name": "Spotlight",
            "description": "The spoken word rides a rounded violet pill - modern creator look",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#7C5CFF"},
        },
        {
            "id": CaptionPreset.IMPACT,
            "name": "Impact",
            "description": "Tall condensed type, two words at a time, revealed as spoken",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#FFD60A"},
        },
        {
            "id": CaptionPreset.GLOW,
            "name": "Glow",
            "description": "Clean white type with a cyan bloom on the active word - tech & gaming",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#7DF9FF"},
        },
        {
            "id": CaptionPreset.BOXED,
            "name": "Boxed",
            "description": "Translucent rounded plate behind the line - readable on any footage",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#FFD23F"},
        },
        {
            "id": CaptionPreset.SWEEP,
            "name": "Sweep",
            "description": "Color sweeps through each word in time with the voice",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#FF5FA2"},
        },
        {
            "id": CaptionPreset.EDITORIAL,
            "name": "Editorial",
            "description": "Italic serif in sentence case with upcoming words dimmed - podcasts & stories",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#FFE6B8"},
        },
        {
            "id": CaptionPreset.HYPE,
            "name": "Hype",
            "description": "Extra-heavy stroke, hard shadow and an electric green active word - high energy",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#39FF6A"},
        },
        {
            "id": CaptionPreset.PUNCH,
            "name": "Punch",
            "description": "One oversized word at a time, revealed as spoken - fast cuts and hooks",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#FFFFFF"},
        },
        {
            "id": CaptionPreset.NEON,
            "name": "Neon",
            "description": "Magenta bloom on the spoken word - music, nightlife & lifestyle",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#FF9CEB"},
        },
        {
            "id": CaptionPreset.HEADLINE,
            "name": "Headline",
            "description": "The spoken word lands on a red news-style tag",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#E5202E"},
        },
        {
            "id": CaptionPreset.PAPER,
            "name": "Paper",
            "description": "Dark sentence-case type on a white card - clean & educational",
            "preview_colors": {"primary": "#111111", "highlight": "#6D28D9"},
        },
        {
            "id": CaptionPreset.SUBTLE,
            "name": "Subtle",
            "description": "Light sentence case, no stroke, upcoming words dimmed - interviews & vlogs",
            "preview_colors": {"primary": "#FFFFFF", "highlight": "#C4F1FF"},
        },
    ]


def _create_pop_style() -> CaptionStyle:
    """Pop: the default. Montserrat Black with a crisp stroke over a soft shadow."""
    s = CaptionStyle()
    s.emphasis_color = "#3DFF8B"
    return s


def _create_spotlight_style() -> CaptionStyle:
    """Spotlight: the active word sits on a violet pill, text stays white."""
    s = CaptionStyle()
    s.font_name = "Poppins Black"
    s.font_size = 80
    s.highlight_color = "#FFFFFF"
    s.outline_width = 5
    s.highlight_box_color = "#7C5CFF"
    s.highlight_box_padding = 16
    s.emphasis_color = "#FFE234"
    return s


def _create_impact_style() -> CaptionStyle:
    """Impact: tall condensed Anton, two words per line, hard 3D-style shadow."""
    s = CaptionStyle()
    s.font_name = "Anton"
    s.font_size = 124
    s.letter_spacing = 1
    s.max_words_per_line = 2
    s.highlight_color = "#FFD60A"
    s.outline_width = 7
    s.shadow_opacity = 0.9
    s.shadow_blur = 1
    s.shadow_offset = 10
    s.future_words = "hide"
    s.emphasis_color = "#FF4D4D"
    return s


def _create_glow_style() -> CaptionStyle:
    """Glow: no stroke, soft shadow for legibility, cyan bloom on the active word."""
    s = CaptionStyle()
    s.font_name = "Montserrat ExtraBold"
    s.font_size = 80
    s.highlight_color = "#7DF9FF"
    s.outline_width = 0
    s.shadow_opacity = 0.75
    s.shadow_blur = 12
    s.shadow_offset = 4
    s.shadow_spread = 5
    s.glow_color = "#00C8FF"
    s.glow_opacity = 0.85
    s.glow_radius = 8
    s.glow_blur = 16
    s.emphasis_color = "#FF6BD6"
    return s


def _create_boxed_style() -> CaptionStyle:
    """Boxed: white text on a translucent black plate, yellow active word."""
    s = CaptionStyle()
    s.font_name = "Archivo Black"
    s.font_size = 70
    s.highlight_color = "#FFD23F"
    s.outline_width = 0
    s.shadow_opacity = 0.0
    s.line_box_color = "#000000"
    s.line_box_opacity = 0.62
    s.line_box_padding = 22
    s.emphasis_color = "#4ADE80"
    return s


def _create_sweep_style() -> CaptionStyle:
    """Sweep: karaoke fill from white to pink as each word is spoken."""
    s = CaptionStyle()
    s.font_name = "Poppins ExtraBold"
    s.font_size = 76
    s.max_words_per_line = 4
    s.highlight_color = "#FF5FA2"
    s.outline_width = 5
    s.karaoke_fill = True
    s.entrance_pop = False
    s.dim_opacity = 1.0
    s.emphasis_color = "#FFE234"
    return s


def _create_editorial_style() -> CaptionStyle:
    """Editorial: large italic serif, sentence case, upcoming words dimmed."""
    s = CaptionStyle()
    s.font_name = "Instrument Serif Italic"
    s.font_size = 112
    s.italic = True
    s.uppercase = False
    s.max_words_per_line = 4
    s.highlight_color = "#FFE6B8"
    s.outline_width = 0
    s.shadow_opacity = 0.9
    s.shadow_blur = 20
    s.shadow_offset = 3
    s.shadow_spread = 8
    s.future_words = "dim"
    s.dim_opacity = 0.6
    s.entrance_pop = False
    return s


def _create_hype_style() -> CaptionStyle:
    """Hype: Montserrat Black with an extra-heavy stroke, hard shadow, green active word."""
    s = CaptionStyle()
    s.font_size = 88
    s.highlight_color = "#39FF6A"
    s.outline_width = 8
    s.shadow_opacity = 0.95
    s.shadow_blur = 1
    s.shadow_offset = 9
    s.color_transition = True
    s.emphasis_color = "#FFE234"
    return s


def _create_punch_style() -> CaptionStyle:
    """Punch: one oversized Anton word at a time."""
    s = CaptionStyle()
    s.font_name = "Anton"
    s.font_size = 150
    s.letter_spacing = 1
    s.max_words_per_line = 1
    s.highlight_color = "#FFFFFF"
    s.outline_width = 8
    s.shadow_opacity = 0.9
    s.shadow_blur = 1
    s.shadow_offset = 12
    s.emphasis_color = "#FF3B30"
    return s


def _create_neon_style() -> CaptionStyle:
    """Neon: no stroke, soft shadow, magenta bloom and pink active word."""
    s = CaptionStyle()
    s.font_name = "Poppins ExtraBold"
    s.font_size = 78
    s.highlight_color = "#FF9CEB"
    s.outline_width = 0
    s.shadow_opacity = 0.75
    s.shadow_blur = 12
    s.shadow_offset = 4
    s.shadow_spread = 5
    s.glow_color = "#FF2EC4"
    s.glow_opacity = 0.9
    s.glow_radius = 9
    s.glow_blur = 18
    s.emphasis_color = "#7DF9FF"
    return s


def _create_headline_style() -> CaptionStyle:
    """Headline: Archivo Black, the active word sits on a red news-style tag."""
    s = CaptionStyle()
    s.font_name = "Archivo Black"
    s.font_size = 72
    s.highlight_color = "#FFFFFF"
    s.outline_width = 4
    s.highlight_box_color = "#E5202E"
    s.highlight_box_padding = 14
    s.emphasis_color = "#FFD23F"
    return s


def _create_paper_style() -> CaptionStyle:
    """Paper: dark sentence-case type on an almost-opaque white card."""
    s = CaptionStyle()
    s.font_name = "Poppins ExtraBold"
    s.font_size = 68
    s.uppercase = False
    s.max_words_per_line = 4
    s.primary_color = "#111111"
    s.highlight_color = "#6D28D9"
    s.outline_width = 0
    s.shadow_opacity = 0.0
    s.line_box_color = "#FFFFFF"
    s.line_box_opacity = 0.94
    s.line_box_padding = 22
    s.entrance_pop = False
    s.emphasis_color = "#DB2777"
    return s


def _create_subtle_style() -> CaptionStyle:
    """Subtle: lighter sentence case, halo shadow instead of stroke, upcoming words dimmed."""
    s = CaptionStyle()
    s.font_name = "Montserrat ExtraBold"
    s.font_size = 70
    s.uppercase = False
    s.max_words_per_line = 4
    s.highlight_color = "#C4F1FF"
    s.outline_width = 0
    s.shadow_opacity = 0.85
    s.shadow_blur = 16
    s.shadow_offset = 3
    s.shadow_spread = 6
    s.future_words = "dim"
    s.dim_opacity = 0.55
    s.entrance_pop = False
    s.color_transition = True
    return s


class Settings(BaseSettings):
    model_config = SettingsConfigDict(case_sensitive=False)
    """
    Application settings.

    Only essential configuration is loaded from environment variables.
    All processing/rendering settings are hardcoded for consistency.
    """

    # ============================================================
    # ENVIRONMENT VARIABLES (minimal set)
    # ============================================================

    # Application
    app_name: str = "BridgeClip"
    debug: bool = False
    log_level: str = "INFO"

    # AWS S3
    aws_region: str = "us-east-1"
    aws_access_key_id: Optional[str] = None
    aws_secret_access_key: Optional[str] = None
    s3_bucket: str = "bridgeclip-media"

    # API Keys (required)
    openrouter_api_key: Optional[str] = None

    # Security - API authentication
    bridgeclip_api_key: Optional[str] = None  # API key for authenticating incoming requests
    bridgeclip_cors_origins: str = ""  # Comma-separated browser origins; empty disables CORS
    bridgeclip_webhook_allowed_hosts: str = ""  # Exact HTTPS hostnames; empty disables callbacks
    bridgeclip_webhook_secret: Optional[str] = None  # Secret for signing outgoing webhooks

    # Local mode - skip S3 uploads, save clips to local_output_dir instead
    local_mode: bool = False
    local_output_dir: str = "./output"

    # yt-dlp Configuration
    # Comma-separated list of proxy URLs for rotation and failover
    # Example: "socks5h://user:pass@host1:port,socks5h://user:pass@host2:port"
    ytdlp_proxies: Optional[str] = None

    # Legacy single proxy (deprecated, use ytdlp_proxies instead)
    ytdlp_proxy: Optional[str] = None

    def get_proxy_list(self) -> List[str]:
        """
        Get list of configured proxies.

        Prioritizes YTDLP_PROXIES (comma-separated) over legacy YTDLP_PROXY.
        Returns empty list if no proxies configured.
        """
        # Prefer new multi-proxy format
        if self.ytdlp_proxies:
            return [p.strip() for p in self.ytdlp_proxies.split(",") if p.strip()]

        # Fall back to legacy single proxy
        if self.ytdlp_proxy:
            return [self.ytdlp_proxy.strip()]

        return []

    # Performance tuning (configurable for ECS scaling)
    max_workers: int = 4  # Max concurrent jobs (set to vCPU count for optimal performance)
    max_render_workers: int = 2  # Max concurrent FFmpeg render processes (reduced for 8GB Fargate)

    # Fargate optimization mode (for 4 vCPU / 8 GB RAM containers)
    # When True, applies memory-conservative settings to prevent OOM on long videos
    fargate_mode: bool = True  # Enable for Fargate/ECS deployment

    # ============================================================
    # AI MODELS (override via env to swap models without a release)
    # ============================================================

    # Clip planner (OpenRouter slugs). PLANNER_FALLBACK_MODELS is a
    # comma-separated list OpenRouter tries in order if the primary errors,
    # is rate limited, or is down. Defaults chosen 2026-09 from the Artificial
    # Analysis Intelligence Index (v4.3) and a live A/B on a real transcript:
    # Opus 5.5 @ medium was fastest (~11s) and the most discriminating scorer
    # at ~$0.07 per 20 min of video. Fallbacks are cross-vendor. Every model in
    # the chain must accept the configured reasoning effort.
    planner_model: str = "anthropic/claude-opus-5.5"
    planner_fallback_models: str = "google/gemini-3.8-flash,openai/gpt-6-sol"
    # none | minimal | low | medium | high | xhigh
    planner_reasoning_effort: str = "medium"
    # Includes reasoning tokens; 100 clips of JSON is ~15k on its own.
    planner_max_output_tokens: int = 32000

    # Layout vision: classifies each shot's framing and locates webcam/screen
    # overlays from one keyframe per distinct setup. Gemini 3.8 Flash has the
    # best native box localization per dollar (AA MMMU-Pro 0.856, ~$0.001/frame).
    layout_vision_enabled: bool = True
    layout_vision_model: str = "google/gemini-3.8-flash"
    layout_vision_fallback_models: str = "anthropic/claude-opus-5.5"
    layout_vision_reasoning_effort: str = "low"

    # Selected by the desktop bridge per process before settings are loaded.
    clipping_mode: Literal["quality", "economy", "advanced"] = "quality"
    advanced_transcription_model: str = ""
    planner_supports_images: bool = True
    planner_input_price: Optional[float] = None
    planner_output_price: Optional[float] = None
    transcription_diarize: bool = True

    @field_validator("planner_reasoning_effort", "layout_vision_reasoning_effort")
    @classmethod
    def _validate_reasoning_effort(cls, value: str, info) -> str:
        effort = value.strip().lower()
        if effort not in REASONING_EFFORTS:
            raise ValueError(
                f"{info.field_name.upper()} must be one of {', '.join(REASONING_EFFORTS)}"
            )
        return effort

    @staticmethod
    def _split_models(models: str, primary: str) -> List[str]:
        return [m.strip() for m in models.split(",") if m.strip() and m.strip() != primary]

    def get_planner_fallback_models(self) -> List[str]:
        """Fallback planner models, excluding blanks and the primary."""
        if self.clipping_mode == "advanced":
            return []
        return self._split_models(self.planner_fallback_models, self.planner_model)

    def get_layout_vision_fallback_models(self) -> List[str]:
        """Fallback layout-vision models, excluding blanks and the primary."""
        return self._split_models(self.layout_vision_fallback_models, self.layout_vision_model)

    # ============================================================
    # HARDCODED SETTINGS (not configurable via env vars)
    # ============================================================

    # Processing settings
    @property
    def frame_interval_seconds(self) -> float:
        return 2.0

    @property
    def max_concurrent_jobs(self) -> int:
        return self.max_workers  # Use configurable env var

    @property
    def max_concurrent_renders(self) -> int:
        # Desktop (local mode): scale with cores; each render keeps ~6 busy.
        # Fargate mode: sequential renders to avoid 100% CPU spikes.
        # Normal mode: use configured value (default 2).
        if self.local_mode:
            return max(1, min(4, (os.cpu_count() or 4) // 6))
        if self.fargate_mode:
            return 1
        return self.max_render_workers

    @property
    def max_concurrent_uploads(self) -> int:
        """Bound parallel S3 uploads to avoid thread and bandwidth spikes."""
        return 2 if self.fargate_mode else 4

    @property
    def s3_max_pool_connections(self) -> int:
        """HTTP connection pool size for AWS SDK clients."""
        return 16 if self.fargate_mode else 32

    @property
    def s3_transfer_max_concurrency(self) -> int:
        """Multipart worker count used by boto3 transfer manager."""
        return 2 if self.fargate_mode else 4

    @property
    def s3_connect_timeout_seconds(self) -> int:
        return 10

    @property
    def s3_read_timeout_seconds(self) -> int:
        return 120

    @property
    def temp_directory(self) -> str:
        return os.environ["BRIDGECLIP_WORK_ROOT"]

    @property
    def workspace_root(self) -> str:
        return "/tmp/ai-clipping-agent"

    # API settings
    @property
    def api_timeout_seconds(self) -> int:
        return 300

    @property
    def webhook_timeout_seconds(self) -> float:
        return 10.0

    @property
    def webhook_max_retries(self) -> int:
        return 3

    @property
    def webhook_retry_delay_seconds(self) -> float:
        return 1.0

    @property
    def webhook_min_interval_seconds(self) -> float:
        return 2.0

    @property
    def webhook_max_connections(self) -> int:
        return 16 if self.fargate_mode else 32

    @property
    def webhook_max_keepalive_connections(self) -> int:
        return 8 if self.fargate_mode else 16

    @property
    def webhook_max_concurrent_requests(self) -> int:
        return 4 if self.fargate_mode else 8

    @property
    def max_video_duration_seconds(self) -> int:
        return 21600  # 6 hours max (credit-guarded in API)

    # yt-dlp Configuration
    @property
    def ytdlp_path(self) -> str:
        return "yt-dlp"

    @property
    def ytdlp_cookies_from_browser(self) -> Optional[str]:
        return None

    @property
    def max_download_duration_seconds(self) -> int:
        return 21600  # 6 hours max (credit-guarded in API)

    # Transcription uses the same OpenRouter key as planning.
    @property
    def transcription_provider(self) -> str:
        return "openrouter"

    @property
    def transcription_model(self) -> str:
        if self.clipping_mode == "advanced":
            if not self.advanced_transcription_model:
                raise ValueError("Choose a transcription model in Advanced mode")
            return self.advanced_transcription_model
        return "openai/whisper-large-v3-turbo" if self.clipping_mode == "economy" else "microsoft/mai-transcribe-2"

    # OpenRouter / LLM Configuration
    @property
    def openrouter_base_url(self) -> str:
        return "https://openrouter.ai/api/v1"

    # Clip Planning Configuration
    @property
    def max_suggested_clips(self) -> int:
        # Upper bound for auto-selected clip counts (used in scaling curve)
        return 50

    # Clip count scaling based on video duration
    @property
    def clip_scaling_enabled(self) -> bool:
        """Enable automatic clip count scaling based on video duration."""
        return True

    @property
    def clips_per_minute_ratio(self) -> float:
        """Target clips per minute of video (e.g., 0.5 = 1 clip per 2 minutes)."""
        return 0.5

    @property
    def min_clips(self) -> int:
        """Minimum number of clips regardless of video length."""
        return 3

    @property
    def clip_count_tau_minutes(self) -> float:
        """Controls how quickly auto clip counts grow with duration."""
        return 45.0

    @property
    def transcript_density_target_wpm(self) -> float:
        """Target words-per-minute for neutral clip count scaling."""
        return 160.0

    @property
    def transcript_density_min_factor(self) -> float:
        """Lower bound for transcript density adjustment."""
        return 0.8

    @property
    def transcript_density_max_factor(self) -> float:
        """Upper bound for transcript density adjustment."""
        return 1.25

    @property
    def max_clips_absolute(self) -> int:
        """Hard cap on maximum clips to prevent excessive processing."""
        return 100

    # Sentence boundary snapping configuration
    @property
    def sentence_snapping_enabled(self) -> bool:
        """Enable snapping clip start/end times to word/sentence boundaries."""
        return True

    @property
    def sentence_extension_max_seconds(self) -> float:
        """Maximum seconds to extend a clip end to reach sentence boundary."""
        return 5.0
    
    @property
    def start_boundary_max_adjustment_seconds(self) -> float:
        """Maximum seconds to adjust clip start backwards to reach word boundary."""
        return 3.0
    
    @property
    def audio_padding_ms(self) -> int:
        """
        Audio padding in milliseconds to add before start and after end.
        This provides a small buffer to avoid cutting mid-syllable due to 
        timing precision issues. Applied during rendering.
        """
        return 150  # 150ms padding for smoother word boundaries

    # Rendering Configuration
    @property
    def target_output_width(self) -> int:
        return 1080

    @property
    def target_output_height(self) -> int:
        return 1920

    @property
    def ffmpeg_preset(self) -> str:
        return "veryfast"

    @property
    def ffmpeg_crf(self) -> int:
        return 20

    def get_caption_style(self) -> CaptionStyle:
        """Caption style used when a request names no preset or custom style."""
        return get_caption_preset(DEFAULT_CAPTION_PRESET)

    def get_ytdlp_extra_args(self) -> list[str]:
        """Parse yt-dlp extra arguments (none by default)."""
        return []


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
