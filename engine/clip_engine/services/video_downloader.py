"""
Video Downloader Service - Downloads videos from YouTube, Twitch or S3.

Uses yt-dlp through guarded Python sockets for YouTube and Twitch and a pinned HTTP
client for direct URLs. Native network handlers and proxies are disabled for
caller-supplied URLs so redirects cannot reach private destinations.
"""

import asyncio
import glob
import json
import logging
import math
import os
import random
import re
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from typing import Literal, Optional
from urllib.parse import unquote, urljoin, urlparse

import boto3
import yt_dlp
from botocore.config import Config as BotocoreConfig

from clip_engine.config import get_settings
from clip_engine.error_policy import is_disk_full
from clip_engine.network_policy import guarded_public_connections, resolve_public_destination
from clip_engine.services.media_process import (guarded_ytdlp_children, run_media,
                                                validate_video_dimensions, MediaProcessError)

logger = logging.getLogger(__name__)

MAX_SOURCE_BYTES = 20 * 1000 ** 3
DOWNLOAD_DEADLINE_SECONDS = 4 * 60 * 60
# Stop a download before it leaves the disk this close to full.
MIN_FREE_BYTES = 1000 ** 3
PROBE_TIMEOUT_SECONDS = 30
MAX_PROBE_OUTPUT_BYTES = 1024 * 1024

# YouTube format selection. Filters only exclude AV1, which the bundled FFmpeg
# cannot decode in software; the sort picks the best remaining stream.
# H.264 tops out at 1080p on YouTube, so 1440p/2160p arrives as VP9.
#
# Vertical clips crop a 9:16 window from 16:9 sources: a 1080p source gives a
# ~608px-wide crop upscaled to 1080x1920, while 2160p gives ~1215px. "res"
# measures the shorter side, so 2160 covers both landscape 4K and vertical
# 2160x3840. SDR is preferred because renders are SDR H.264 without tone mapping.
YOUTUBE_FORMAT_SORT = ["hdr:SDR", "res:2160", "fps"]
YOUTUBE_FORMAT_SELECTORS = [
    # Best separate video + audio streams (the only way to get >720p).
    "bv*[vcodec!^=av01]+ba/b[vcodec!^=av01]",
    # If VP9/Opus fails to merge or convert, retry with H.264 + AAC (native to
    # mp4, up to 1080p), then any non-AV1 stream that already includes audio.
    "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec!^=av01]",
]


TWITCH_HOSTS = {"twitch.tv", "www.twitch.tv", "m.twitch.tv", "go.twitch.tv"}


def twitch_vod_url(url: str) -> Optional[str]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host.rstrip(".") != "twitch.tv" and not host.rstrip(".").endswith(".twitch.tv"):
        return None
    match = re.fullmatch(r"/videos/([0-9]+)/?", parsed.path)
    try:
        valid_port = parsed.port in {None, 443 if parsed.scheme == "https" else 80}
    except ValueError:
        valid_port = False
    if (host not in TWITCH_HOSTS or not match or parsed.scheme not in {"http", "https"}
            or parsed.username or parsed.password or not valid_port):
        raise VideoDownloadError("Unsupported Twitch source", reason="twitch_unsupported")
    return f"https://www.twitch.tv/videos/{match[1]}"


def finite_number(value, default=0):
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (TypeError, ValueError, OverflowError):
        return default


# User-Agent rotation list for avoiding detection
UA_LIST = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:89.0) Gecko/20100101 Firefox/89.0",
]


# Source types for videos
VideoSourceType = Literal["youtube", "twitch", "s3", "direct_url", "local"]


@dataclass
class VideoMetadata:
    """Metadata extracted from downloaded video."""
    
    title: str
    duration_seconds: float
    width: int
    height: int
    fps: float
    format_id: str
    extractor: str
    uploader: Optional[str] = None
    upload_date: Optional[str] = None
    description: Optional[str] = None
    thumbnail_url: Optional[str] = None
    source_type: VideoSourceType = "youtube"


@dataclass
class DownloadResult:
    """Result of video download operation."""
    
    video_path: str
    metadata: VideoMetadata
    file_size_bytes: int
    source_type: VideoSourceType


class VideoDownloaderService:
    """
    Service for downloading videos from various sources.
    
    Supported sources:
    - YouTube URLs (via yt-dlp)
    - S3 URLs or keys (via boto3)
    - Direct video URLs (via httpx)
    
    Features:
    - Downloads video in best available quality up to 2160p
    - Extracts metadata (title, duration, dimensions)
    - Handles various URL formats
    - Configurable via environment variables
    """

    def __init__(self):
        self.settings = get_settings()
        self._s3_client: Optional[boto3.client] = None

        # Log yt-dlp version for diagnostics.
        try:
            logger.info(f"VideoDownloaderService initialized with yt-dlp {yt_dlp.version.__version__}")
        except Exception:
            logger.info("VideoDownloaderService initialized with yt-dlp library")

        logger.info("Guarded Python HTTP handler enabled for YouTube")

        logger.info("YouTube proxy and native networking disabled for destination checks")

    def _get_format_selector(self) -> str:
        """
        Returns the primary format selector: the highest-resolution non-AV1
        stream (up to 2160p, per YOUTUBE_FORMAT_SORT) merged with the best audio.

        IMPORTANT: Excludes AV1 codec (vcodec=av01) because the bundled FFmpeg
        has no software AV1 decoder. H.264 (avc1) and VP9 decode everywhere.
        """
        return YOUTUBE_FORMAT_SELECTORS[0]

    def _build_ytdlp_opts(
        self,
        output_path: Optional[str] = None,
        download: bool = True,
    ) -> dict:
        """
        Build yt-dlp options dictionary for downloading.

        Uses the guarded Python network stack.

        Args:
            output_path: Optional output file path
            download: Whether these options are for downloading (vs just info extraction)

        Returns:
            Dictionary of yt-dlp options
        """
        # Native handlers and proxies can fetch a private redirect without
        # passing through the socket guard. An empty proxy disables yt-dlp's
        # inherited proxy configuration as well.
        opts = {"proxy": "", "external_downloader": "native", "hls_prefer_native": True}

        # Add our custom options - keep it simple to avoid format issues
        opts.update({
            "format": self._get_format_selector(),
            "format_sort": YOUTUBE_FORMAT_SORT,
            "quiet": True,
            "noprogress": True,  # quiet alone still prints [download] bars to stdout
            "no_warnings": True,
            "noplaylist": True,
            "socket_timeout": 30,
            "http_headers": {
                "User-Agent": random.choice(UA_LIST),
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            "nocheckcertificate": False,
            "geo_bypass": True,
        })

        if output_path:
            opts["outtmpl"] = output_path

        if download:
            opts["merge_output_format"] = "mp4"
            opts["postprocessors"] = [
                {
                    'key': 'FFmpegVideoConvertor',
                    'preferedformat': 'mp4',
                }
            ]
            opts["retries"] = 10
            opts["fragment_retries"] = 10
            opts["force_overwrites"] = True
            opts["max_filesize"] = MAX_SOURCE_BYTES

        return opts

    @property
    def s3_client(self) -> boto3.client:
        """Lazy-initialize S3 client."""
        if self._s3_client is None:
            config = {
                "region_name": self.settings.aws_region,
                "config": BotocoreConfig(
                    retries={"max_attempts": 10, "mode": "adaptive"},
                    max_pool_connections=self.settings.s3_max_pool_connections,
                    connect_timeout=self.settings.s3_connect_timeout_seconds,
                    read_timeout=self.settings.s3_read_timeout_seconds,
                ),
            }
            if self.settings.aws_access_key_id and self.settings.aws_secret_access_key:
                config["aws_access_key_id"] = self.settings.aws_access_key_id
                config["aws_secret_access_key"] = self.settings.aws_secret_access_key
            
            self._s3_client = boto3.client("s3", **config)
        
        return self._s3_client

    def detect_source_type(self, url_or_key: str) -> VideoSourceType:
        """
        Detect the source type from URL or key.
        
        Args:
            url_or_key: URL or S3 key
            
        Returns:
            VideoSourceType
        """
        # Local file (desktop app). Only honoured in LOCAL_MODE so the server
        # API can't be pointed at arbitrary files on the host.
        if self.settings.local_mode and (
            url_or_key.startswith("file://") or os.path.isfile(url_or_key)
        ):
            return "local"

        # S3 key (no protocol)
        if not url_or_key.startswith("http"):
            return "s3"
        
        parsed = urlparse(url_or_key)
        
        if twitch_vod_url(url_or_key):
            return "twitch"

        # S3 URL formats
        if parsed.hostname and (
            ".s3." in parsed.hostname or
            parsed.hostname.endswith(".amazonaws.com") or
            parsed.hostname == "s3.amazonaws.com"
        ):
            return "s3"
        
        # YouTube URLs
        host = (parsed.hostname or "").lower()
        if host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"}:
            return "youtube"
        
        # Direct video URL
        return "direct_url"

    async def download_video(
        self,
        url: str,
        output_dir: str,
        output_filename: str = "source.mp4",
        max_duration_seconds: Optional[int] = None,
        s3_bucket: Optional[str] = None,
    ) -> DownloadResult:
        """
        Download a video from various sources.
        
        Args:
            url: Video URL (YouTube, S3, direct) or S3 key
            output_dir: Directory to save the video
            output_filename: Output filename (default: source.mp4)
            max_duration_seconds: Maximum duration to download
            s3_bucket: S3 bucket (required if url is an S3 key)
            
        Returns:
            DownloadResult with path and metadata
            
        Raises:
            VideoDownloadError: If download fails
        """
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, output_filename)
        
        source_type = self.detect_source_type(url)
        logger.info("Detected source type: %s", source_type)

        try:
            if source_type == "local":
                result = await self._use_local_file(url)
            elif source_type == "s3":
                result = await self._download_from_s3(url, output_path, s3_bucket)
            elif source_type == "twitch":
                result = await self._download_from_youtube(twitch_vod_url(url), output_path, output_dir, max_duration_seconds, source_type="twitch")
            elif source_type == "youtube":
                result = await self._download_from_youtube(url, output_path, output_dir, max_duration_seconds)
            else:
                result = await self._download_direct_url(url, output_path)

            duration_limit = min(
                max_duration_seconds or self.settings.max_download_duration_seconds,
                self.settings.max_download_duration_seconds,
            )
            if not 0 < result.metadata.duration_seconds <= duration_limit:
                raise VideoDownloadError("Video duration is invalid or exceeds the allowed limit")
            return result
        except Exception:
            if source_type != "local":
                self._remove_partial_files(output_path)
            raise

    @staticmethod
    def _check_source_size(size: int) -> None:
        if size > MAX_SOURCE_BYTES:
            raise VideoDownloadError("Video exceeds the 20 GB source limit")

    @staticmethod
    def _check_free_space(directory: str, remaining_bytes: int) -> None:
        """Fail early, and say why, rather than filling the disk mid-download."""
        if shutil.disk_usage(directory).free - max(remaining_bytes, 0) < MIN_FREE_BYTES:
            raise VideoDownloadError("No space left on device for this video")

    @staticmethod
    def _download_paths(output_path: str) -> list[str]:
        source_prefix = os.path.splitext(output_path)[0]
        return [
            path for path in glob.glob(glob.escape(source_prefix) + "*")
            if os.path.isfile(path) and (
                path == output_path or path.startswith(output_path + ".")
                or path.startswith(source_prefix + ".f")
            )
        ]

    @classmethod
    def _remove_partial_files(cls, output_path: str) -> None:
        for path in cls._download_paths(output_path):
            os.remove(path)

    async def _download_from_youtube(
        self,
        url: str,
        output_path: str,
        output_dir: str,
        max_duration_seconds: Optional[int] = None,
        source_type: VideoSourceType = "youtube",
    ) -> DownloadResult:
        """
        Download video from YouTube or Twitch using yt-dlp Python library.

        Downloads through guarded Python sockets:
        - Uses flexible format selectors that work reliably
        - Picks the highest-resolution non-AV1 stream (up to 2160p)
        """
        deadline = time.monotonic() + DOWNLOAD_DEADLINE_SECONDS
        # First, get video metadata to check duration.
        metadata = await asyncio.wait_for(
            self._get_video_info(url, deadline=deadline), timeout=DOWNLOAD_DEADLINE_SECONDS
        )

        max_duration = min(max_duration_seconds or self.settings.max_download_duration_seconds, self.settings.max_download_duration_seconds)
        if metadata.duration_seconds > max_duration:
            raise VideoDownloadError(
                f"Video duration ({metadata.duration_seconds}s) exceeds maximum "
                f"allowed duration ({max_duration}s)"
            )

        logger.info("Downloading video from %s", source_type)
        def check_progress(progress: dict) -> None:
            if time.monotonic() > deadline:
                raise VideoDownloadError("Video download deadline exceeded")
            self._check_source_size(int(progress.get("downloaded_bytes") or 0))
            total_bytes = int(progress.get("total_bytes") or progress.get("total_bytes_estimate") or 0)
            self._check_source_size(total_bytes)
            self._check_free_space(
                output_dir, total_bytes - int(progress.get("downloaded_bytes") or 0)
            )
            # yt-dlp downloads video and audio separately, so each stream can
            # be smaller than the limit while their combined files exceed it.
            stored_bytes = sum(
                os.path.getsize(path)
                for path in self._download_paths(output_path)
            )
            self._check_source_size(stored_bytes)

        # Highest available quality first; see YOUTUBE_FORMAT_SELECTORS.
        # CRITICAL: All selectors MUST exclude AV1 (the bundled FFmpeg can't decode it).
        format_selectors = ["b[vcodec!^=av01]"] if source_type == "twitch" else YOUTUBE_FORMAT_SELECTORS

        # Run download in thread pool to not block event loop
        loop = asyncio.get_event_loop()

        def do_download() -> None:
            """Try compatible formats through the guarded Python network stack."""
            logger.info("Attempting video download")

            last_error = None

            for fmt_idx, format_selector in enumerate(format_selectors):
                try:
                    logger.info(f"Format attempt {fmt_idx + 1}/{len(format_selectors)}: {format_selector[:50]}...")

                    ydl_opts = self._build_ytdlp_opts(
                        output_path=output_path,
                        download=True,
                    )
                    if source_type == "twitch":
                        ydl_opts["allowed_extractors"] = ["twitch:vod"]
                        ydl_opts["skip_unavailable_fragments"] = False
                        ydl_opts["match_filter"] = lambda info, *, incomplete=False: self._validate_twitch_info(info, max_duration, incomplete)
                    ydl_opts["format"] = format_selector
                    ydl_opts["progress_hooks"] = [check_progress]
                    ydl_opts["postprocessor_hooks"] = [check_progress]

                    if time.monotonic() > deadline:
                        raise VideoDownloadError("Video download deadline exceeded")

                    with guarded_ytdlp_children(deadline), guarded_public_connections():
                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            ydl.download([url])

                    # If we get here, download succeeded
                    logger.info("Video download succeeded")
                    return

                except VideoDownloadError:
                    raise
                except Exception as e:
                    last_error = e
                    error_str = str(e)

                    # A full disk affects every format selector.
                    if is_disk_full(e):
                        raise

                    # Bot detection will affect every format selector.
                    if "Sign in to confirm" in error_str or "bot" in error_str.lower():
                        logger.warning("Bot detection triggered")
                        raise

                    # Check if it's a format issue - try next selector
                    if "Requested format" in error_str or "No video formats" in error_str:
                        logger.warning("Format not available, trying next")
                        continue

                    # Network and HTTP failures affect every format selector.
                    lowered = error_str.lower()
                    if any(m in lowered for m in ("unable to download", "http error", "timed out", "connection")):
                        logger.warning("Format attempt %d failed at the network level", fmt_idx + 1)
                        raise

                    # For other errors (e.g. merge/conversion), try the next format
                    logger.warning("Format attempt %d failed", fmt_idx + 1)
                    continue

            # All format attempts failed.
            raise last_error or VideoDownloadError("All format attempts failed")

        try:
            await loop.run_in_executor(None, do_download)
        except Exception as e:
            self._remove_partial_files(output_path)
            if isinstance(e, VideoDownloadError):
                raise
            if source_type == "twitch" and not is_disk_full(e):
                raise VideoDownloadError("Twitch VOD download failed", reason="twitch_unavailable") from e
            raise VideoDownloadError(f"Failed to download video: {e}") from e

        # Verify output exists
        if not os.path.isfile(output_path):
            # yt-dlp might have added extension
            possible_paths = [
                output_path,
                f"{output_path}.mp4",
                f"{output_path}.webm",
                f"{output_path}.mkv",
            ]
            for path in possible_paths:
                if os.path.isfile(path):
                    if path != output_path:
                        os.rename(path, output_path)
                    break
            else:
                raise VideoDownloadError(f"Download completed but output file not found: {output_path}")

        file_size = os.path.getsize(output_path)
        try:
            self._check_source_size(file_size)
        except VideoDownloadError:
            self._remove_partial_files(output_path)
            raise
        logger.info(f"Video downloaded: {output_path} ({file_size / 1024 / 1024:.1f} MB)")

        # CRITICAL: Get ACTUAL video metadata using ffprobe after download
        # This ensures we have the real dimensions of the downloaded file,
        # not the pre-download estimates from yt-dlp info
        actual_metadata = await self._get_video_metadata_ffprobe(output_path)
        if time.monotonic() > deadline:
            self._remove_partial_files(output_path)
            raise VideoDownloadError("Video download deadline exceeded")

        # Log the actual downloaded resolution for debugging
        logger.info(
            f"Downloaded video quality: {actual_metadata.width}x{actual_metadata.height} "
            f"@ {actual_metadata.fps}fps ({file_size / 1024 / 1024:.1f} MB)"
        )
        
        # Warn if we got low quality (less than 720p)
        if actual_metadata.height < 720:
            logger.warning(
                f"WARNING: Downloaded video is only {actual_metadata.height}p! "
                "Expected 720p or higher"
            )

        # Preserve useful info from yt-dlp metadata (title, uploader, etc.)
        # but use actual dimensions from ffprobe
        actual_metadata.title = metadata.title
        actual_metadata.uploader = metadata.uploader
        actual_metadata.upload_date = metadata.upload_date
        actual_metadata.description = metadata.description
        actual_metadata.thumbnail_url = metadata.thumbnail_url
        actual_metadata.source_type = source_type

        logger.info(f"Actual video dimensions: {actual_metadata.width}x{actual_metadata.height} @ {actual_metadata.fps}fps")

        return DownloadResult(
            video_path=output_path,
            metadata=actual_metadata,
            file_size_bytes=file_size,
            source_type=source_type,
        )

    async def _download_from_s3(
        self,
        url_or_key: str,
        output_path: str,
        s3_bucket: Optional[str] = None,
    ) -> DownloadResult:
        """Download video from S3."""
        # Parse S3 URL or use key directly
        bucket, key = self._parse_s3_url(url_or_key, s3_bucket)
        
        logger.info("Downloading video from S3")
        
        # Download file
        loop = asyncio.get_event_loop()
        deadline = time.monotonic() + DOWNLOAD_DEADLINE_SECONDS
        downloaded = 0
        progress_lock = threading.Lock()

        def check_progress(chunk_size: int) -> None:
            nonlocal downloaded
            with progress_lock:
                downloaded += chunk_size
                self._check_source_size(downloaded)
            if time.monotonic() > deadline:
                raise VideoDownloadError("Video download deadline exceeded")

        try:
            size = (await loop.run_in_executor(
                None, lambda: self.s3_client.head_object(Bucket=bucket, Key=key)
            )).get("ContentLength")
            if size is not None:
                self._check_source_size(int(size))
            await loop.run_in_executor(
                None,
                lambda: self.s3_client.download_file(bucket, key, output_path, Callback=check_progress),
            )
        except Exception as e:
            self._remove_partial_files(output_path)
            raise VideoDownloadError("Failed to download video from S3") from e
        
        if not os.path.isfile(output_path):
            raise VideoDownloadError(f"S3 download completed but file not found: {output_path}")
        
        file_size = os.path.getsize(output_path)
        self._check_source_size(file_size)
        logger.info(f"S3 video downloaded: {output_path} ({file_size / 1024 / 1024:.1f} MB)")
        
        # Get video metadata using ffprobe
        metadata = await self._get_video_metadata_ffprobe(output_path)
        metadata.source_type = "s3"
        
        return DownloadResult(
            video_path=output_path,
            metadata=metadata,
            file_size_bytes=file_size,
            source_type="s3",
        )

    def _parse_s3_url(
        self,
        url_or_key: str,
        default_bucket: Optional[str] = None,
    ) -> tuple[str, str]:
        """
        Parse S3 URL or key into bucket and key.
        
        Supports formats:
        - s3://bucket/key
        - https://bucket.s3.region.amazonaws.com/key
        - https://s3.region.amazonaws.com/bucket/key
        - just-a-key (uses default bucket)
        """
        # Plain key
        if not url_or_key.startswith("http") and not url_or_key.startswith("s3://"):
            bucket = default_bucket or self.settings.s3_bucket
            return bucket, url_or_key
        
        # s3:// URL
        if url_or_key.startswith("s3://"):
            parts = url_or_key[5:].split("/", 1)
            if len(parts) != 2:
                raise VideoDownloadError(f"Invalid S3 URL: {url_or_key}")
            return parts[0], parts[1]
        
        # HTTP(S) URL
        parsed = urlparse(url_or_key)
        
        # Virtual-hosted style: bucket.s3.region.amazonaws.com/key
        if parsed.hostname and ".s3." in parsed.hostname:
            bucket = parsed.hostname.split(".s3.")[0]
            key = parsed.path.lstrip("/")
            return bucket, key
        
        # Path style: s3.region.amazonaws.com/bucket/key
        if parsed.hostname and parsed.hostname.startswith("s3."):
            path_parts = parsed.path.lstrip("/").split("/", 1)
            if len(path_parts) != 2:
                raise VideoDownloadError(f"Invalid S3 URL: {url_or_key}")
            return path_parts[0], path_parts[1]
        
        raise VideoDownloadError(f"Unable to parse S3 URL: {url_or_key}")

    async def _download_direct_url(
        self,
        url: str,
        output_path: str,
    ) -> DownloadResult:
        """Download video from a direct URL using httpx."""
        import httpx
        
        logger.info("Downloading video from direct URL")
        deadline = time.monotonic() + DOWNLOAD_DEADLINE_SECONDS
        try:
            return await self._stream_direct_url(url, output_path, deadline)
        except Exception:
            self._remove_partial_files(output_path)
            raise

    async def _stream_direct_url(self, url: str, output_path: str, deadline: float) -> DownloadResult:
        import httpx

        async with httpx.AsyncClient(timeout=300, follow_redirects=False, trust_env=False,
                                     limits=httpx.Limits(max_keepalive_connections=0)) as client:
            current_url = url
            for redirect_count in range(6):
                try:
                    destination = await asyncio.to_thread(resolve_public_destination, current_url)
                except ValueError as exc:
                    raise VideoDownloadError("Video destination is not public") from exc

                async with client.stream(
                    "GET", destination.url,
                    headers={"Host": destination.host_header},
                    extensions={"sni_hostname": destination.hostname},
                ) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        location = response.headers.get("location")
                        if not location or redirect_count == 5:
                            raise VideoDownloadError("Video redirect could not be followed")
                        current_url = urljoin(current_url, location)
                        continue
                    response.raise_for_status()

                    content_length = response.headers.get("content-length")
                    if content_length:
                        try:
                            self._check_source_size(int(content_length))
                        except ValueError as exc:
                            raise VideoDownloadError("Invalid source size") from exc

                    with open(output_path, "wb") as f:
                        downloaded = 0
                        async for chunk in response.aiter_bytes():
                            downloaded += len(chunk)
                            self._check_source_size(downloaded)
                            if time.monotonic() > deadline:
                                raise VideoDownloadError("Video download deadline exceeded")
                            f.write(chunk)
                    break
        
        if not os.path.isfile(output_path):
            raise VideoDownloadError(f"Direct download completed but file not found: {output_path}")
        
        file_size = os.path.getsize(output_path)
        self._check_source_size(file_size)
        logger.info(f"Video downloaded: {output_path} ({file_size / 1024 / 1024:.1f} MB)")
        
        # Get video metadata using ffprobe
        metadata = await self._get_video_metadata_ffprobe(output_path)
        metadata.source_type = "direct_url"
        
        return DownloadResult(
            video_path=output_path,
            metadata=metadata,
            file_size_bytes=file_size,
            source_type="direct_url",
        )

    async def _use_local_file(self, path_or_url: str) -> DownloadResult:
        """Use a local video in place (no copy; sources can be many GB)."""
        path = unquote(urlparse(path_or_url).path) if path_or_url.startswith("file://") else path_or_url
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise VideoDownloadError(f"Local video not found: {path}")
        self._check_source_size(os.path.getsize(path))

        metadata = await self._get_video_metadata_ffprobe(path)
        metadata.source_type = "local"
        metadata.title = os.path.splitext(os.path.basename(path))[0]
        logger.info("Using local video (%.1fs)", metadata.duration_seconds)

        return DownloadResult(
            video_path=path,
            metadata=metadata,
            file_size_bytes=os.path.getsize(path),
            source_type="local",
        )

    def _run_ffprobe_sync(self, video_path: str) -> tuple[int, bytes, bytes]:
        """Run ffprobe synchronously (for use with run_in_executor on Windows)."""
        cmd = [
            "ffprobe",
            "-v", "quiet",
            "-print_format", "json",
            "-show_entries", "format=duration,filename,format_name:stream=codec_type,width,height,r_frame_rate",
            "-show_format",
            "-show_streams",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts",
            video_path,
        ]

        try:
            result = run_media(cmd, timeout=PROBE_TIMEOUT_SECONDS, max_output=MAX_PROBE_OUTPUT_BYTES)
            if result.returncode != 0:
                raise VideoDownloadError("Video metadata probe failed")
            return result.returncode, result.stdout, result.stderr
        except MediaProcessError:
            raise VideoDownloadError("Video metadata probe failed") from None

    async def _get_video_metadata_ffprobe(self, video_path: str) -> VideoMetadata:
        """Get video metadata using ffprobe."""
        # Use run_in_executor for Windows compatibility
        # asyncio.create_subprocess_exec doesn't work on Windows without ProactorEventLoop
        loop = asyncio.get_event_loop()
        returncode, stdout, stderr = await loop.run_in_executor(
            None, self._run_ffprobe_sync, video_path
        )
        
        if returncode != 0 or len(stdout) > MAX_PROBE_OUTPUT_BYTES:
            raise VideoDownloadError("Video metadata probe failed")
        
        try:
            info = json.loads(stdout.decode())
            
            # Find video stream
            video_stream = None
            for stream in info.get("streams", []):
                if stream.get("codec_type") == "video":
                    video_stream = stream
                    break
            
            format_info = info.get("format", {})
            
            if not video_stream:
                raise VideoDownloadError("Source has no video stream")
            duration = float(format_info.get("duration", 0))
            width = int(video_stream.get("width", 0))
            height = int(video_stream.get("height", 0))
            if not math.isfinite(duration) or duration <= 0 or width <= 0 or height <= 0:
                raise VideoDownloadError("Invalid video metadata")

            validate_video_dimensions(width, height)

            # Extract FPS from r_frame_rate (e.g., "30/1" -> 30.0)
            fps = 30.0
            if "r_frame_rate" in video_stream:
                fps_str = video_stream["r_frame_rate"]
                if "/" in fps_str:
                    num, den = fps_str.split("/")
                    fps = float(num) / float(den) if float(den) != 0 else 30.0
                else:
                    fps = float(fps_str)
            
            return VideoMetadata(
                title=format_info.get("filename", os.path.basename(video_path)),
                duration_seconds=duration,
                width=width,
                height=height,
                fps=fps,
                format_id=format_info.get("format_name", "mp4"),
                extractor="file",
            )
        except (json.JSONDecodeError, KeyError, TypeError, ValueError, OverflowError) as e:
            raise VideoDownloadError("Invalid video metadata") from e

    @staticmethod
    def _validate_twitch_info(info: dict, max_duration: float, incomplete: bool = False):
        if not isinstance(info, dict):
            raise VideoDownloadError("Twitch VOD unavailable", reason="twitch_unavailable")
        # Archived broadcasts often have was_live=True and is_live=None.
        if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming", "post_live", "processing"}:
            raise VideoDownloadError("Twitch VOD is not completed", reason="twitch_not_completed")
        if incomplete:
            return None
        duration = finite_number(info.get("duration"))
        if not 0 < duration <= max_duration:
            raise VideoDownloadError("Twitch VOD duration is invalid or too long", reason="twitch_duration")
        return None

    async def _get_video_info(self, url: str, deadline: Optional[float] = None) -> VideoMetadata:
        """
        Get video metadata without downloading using yt-dlp Python library.

        Uses guarded Python sockets for metadata requests and redirects.
        """
        logger.debug("Getting video info")
        twitch_url = twitch_vod_url(url)
        if twitch_url:
            url = twitch_url

        # Run in thread pool to not block event loop
        loop = asyncio.get_event_loop()

        def do_extract() -> dict:
            """Extract video info through guarded Python sockets."""
            opts = {"proxy": "", "external_downloader": "native", "hls_prefer_native": True}

            # Add metadata-specific options (no format specification to avoid errors)
            opts.update({
                "skip_download": True,
                "noplaylist": True,
                "socket_timeout": 30,
                "nocheckcertificate": False,
                "geo_bypass": True,
                "quiet": True,
                "no_warnings": True,
            })

            if twitch_url:
                opts["allowed_extractors"] = ["twitch:vod"]
            with guarded_ytdlp_children(deadline), guarded_public_connections():
                with yt_dlp.YoutubeDL(opts) as ydl:
                    return ydl.extract_info(url, download=False)

        try:
            info = await loop.run_in_executor(None, do_extract)
        except Exception as e:
            if twitch_url and not is_disk_full(e):
                raise VideoDownloadError("Twitch VOD unavailable", reason="twitch_unavailable") from e
            error_str = str(e)
            # Provide user-friendly error for YouTube bot detection
            if "Sign in to confirm" in error_str or "bot" in error_str.lower():
                logger.error("YouTube bot detection triggered for metadata")
                raise VideoDownloadError(
                    "YouTube is temporarily blocking this request. Please try again in a few moments, "
                    "or try a different video URL."
                )
            raise VideoDownloadError(f"Failed to get video info: {e}")

        if twitch_url:
            self._validate_twitch_info(info, self.settings.max_download_duration_seconds)

        return VideoMetadata(
            source_type="twitch" if twitch_url else "youtube",
            title=info.get("title", "Unknown"),
            duration_seconds=float(finite_number(info.get("duration"), 0)),
            width=int(finite_number(info.get("width"), 1920)),
            height=int(finite_number(info.get("height"), 1080)),
            fps=float(finite_number(info.get("fps"), 30)),
            format_id=info.get("format_id", "unknown"),
            extractor=info.get("extractor", "unknown"),
            uploader=info.get("uploader"),
            upload_date=info.get("upload_date"),
            description=info.get("description"),
            thumbnail_url=info.get("thumbnail"),
        )

class VideoDownloadError(Exception):
    """Exception raised when video download fails."""
    def __init__(self, message: str, reason: Optional[str] = None):
        super().__init__(message)
        self.reason = reason
