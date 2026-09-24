#!/usr/bin/env bash
# Prepare Linux release resources (engine-venv + engine-bin layout).
# Counterpart to prepare-resources.sh, which is macOS-only by design and
# refuses to run off Darwin. This script does not touch any macOS flow.
#
# Status: scaffolding for a future Linux release job. The Linux
# python-build-standalone hashes and .so staging are still TODO (see below).
# Development does NOT need this script: dev uses the system ffmpeg from
# PATH (pipeline-runner falls back to PATH when engine-bin/ is absent) and
# engine/.venv directly.
set -euo pipefail

cd "$(dirname "$0")/.."

target_arch="${1:-$(uname -m)}"
if [[ "$target_arch" == "aarch64" ]]; then target_arch="arm64"; fi
if [[ "$target_arch" == "amd64" ]]; then target_arch="x64"; fi
if [[ "$target_arch" != "arm64" && "$target_arch" != "x64" ]]; then
  echo "Architecture must be arm64 or x64" >&2
  exit 1
fi
if [[ ! -f engine/clip_engine/bridge_contract.py || ! -f engine/requirements.lock ||
      ! -f engine/LICENSE || ! -d engine/assets ]]; then
  echo "The in-repo BridgeClip clipping engine is incomplete" >&2
  exit 1
fi

rm -rf engine-bin engine-venv
mkdir -p engine-bin

# TODO: pin the Linux python-build-standalone hashes. Download the archive
# once, verify it out-of-band, then record the output of
#   sha256sum "$archive"
# in pbs_hash below before using this script in CI. Until then the script
# stops here rather than shipping an unverified interpreter.
if [[ "$target_arch" == "arm64" ]]; then
  pbs_arch="aarch64"
  pbs_hash="TODO-arm64-linux-hash"
else
  pbs_arch="x86_64"
  pbs_hash="TODO-x64-linux-hash"
fi

archive="$(mktemp -t bridgeclip-python).tar.gz"
work_dir="$(mktemp -d -t bridgeclip-resources)"
trap 'rm -f "$archive"; rm -rf "$work_dir"' EXIT
pbs_url="https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14+20260901-${pbs_arch}-unknown-linux-gnu-install_only_stripped.tar.gz"
curl --fail --show-error --location --retry 3 "$pbs_url" -o "$archive"
echo "$pbs_hash  $archive" | sha256sum --check
tar xzf "$archive" -C "$work_dir"
mv "$work_dir/python" engine-venv
engine-venv/bin/python3 -m pip install --require-hashes -r engine/requirements.lock
bash "$(dirname "$0")/stage-python-license.sh" engine-venv

# Linux uses the system FFmpeg (with the libass-backed `ass` filter) instead
# of the macOS-bundled build from build-ffmpeg-mac.sh.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "System ffmpeg not found; install FFmpeg with libass support (Arch: sudo pacman -S ffmpeg)" >&2
  exit 1
fi
if ! ffmpeg -hide_banner -filters 2>/dev/null | grep -qE '(^|[[:space:]])ass( |$)'; then
  echo "System ffmpeg lacks the libass-backed 'ass' filter" >&2
  exit 1
fi
if ! command -v ffprobe >/dev/null 2>&1; then
  echo "System ffprobe not found; install it alongside ffmpeg" >&2
  exit 1
fi
ln -sf "$(command -v ffmpeg)" engine-bin/ffmpeg
ln -sf "$(command -v ffprobe)" engine-bin/ffprobe

# TODO: stage shared-library dependencies for the bundled Python/FFmpeg
# (the equivalent of stage-ffmpeg-libs-mac.sh). Sketch: run
#   ldd engine-venv/bin/python3 "$(command -v ffmpeg)"
# and copy the non-system .so files next to the binaries with a wrapper that
# sets LD_LIBRARY_PATH. Until then, Linux packaging relies on system libs.

cat > engine-bin/yt-dlp <<'SH'
#!/bin/sh
BUNDLE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$BUNDLE_DIR/../engine-venv/bin/python3" -m yt_dlp "$@"
SH
chmod 755 engine-bin/yt-dlp
PYTHONPATH=engine engine-venv/bin/python3 -c 'import cv2, yt_dlp; from clip_engine.bridge_contract import BRIDGE_CONTRACT_VERSION; from clip_engine.services.layout_analyzer import LayoutAnalyzer; assert BRIDGE_CONTRACT_VERSION == 1; assert LayoutAnalyzer().available'
PYTHONPATH=engine engine-venv/bin/python3 -m unittest discover -s bridge -p 'test_*.py'
PYTHONPATH=engine engine-venv/bin/python3 bridge/smoke_smart_render.py engine-bin/ffmpeg
PYTHONPATH=engine engine-venv/bin/python3 bridge/smoke_transcription_audio.py engine-bin
echo "Resources prepared for linux-$target_arch. Review third-party notices before packaging."
