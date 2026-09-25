#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS is required to prepare release resources" >&2
  exit 1
fi

target_arch="${1:-$(uname -m)}"
if [[ "$target_arch" == "aarch64" ]]; then target_arch="arm64"; fi
if [[ "$target_arch" != "arm64" && "$target_arch" != "x64" ]]; then
  echo "Architecture must be arm64 or x64" >&2
  exit 1
fi
host_arch="$(uname -m)"
if [[ ( "$target_arch" == "arm64" && "$host_arch" != "arm64" ) ||
      ( "$target_arch" == "x64" && "$host_arch" != "x86_64" ) ]]; then
  echo "Prepare $target_arch resources on a matching macOS architecture" >&2
  exit 1
fi
if [[ ! -f engine/clip_engine/bridge_contract.py || ! -f engine/requirements.lock ||
      ! -f engine/LICENSE || ! -d engine/assets ]]; then
  echo "The in-repo BridgeClip clipping engine is incomplete" >&2
  exit 1
fi

rm -rf engine-bin engine-venv
mkdir -p engine-bin

if [[ "$target_arch" == "arm64" ]]; then
  pbs_arch="aarch64"
  pbs_hash="81a359f1cfadd4da11766534c5913791cea55f26e1bb902cacd2a531bb1e4b2b"
else
  pbs_arch="x86_64"
  pbs_hash="65b195c9cedc1fef6767f044f9822069adbd1bd9204d424ece4628776fdc04bb"
fi

archive="$(mktemp -t bridgeclip-python).tar.gz"
work_dir="$(mktemp -d -t bridgeclip-resources)"
trap 'rm -f "$archive"; rm -rf "$work_dir"' EXIT
pbs_url="https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14+20260901-${pbs_arch}-apple-darwin-install_only_stripped.tar.gz"
curl --fail --show-error --location --retry 3 "$pbs_url" -o "$archive"
echo "$pbs_hash  $archive" | shasum -a 256 --check
tar xzf "$archive" -C "$work_dir"
mv "$work_dir/python" engine-venv
engine-venv/bin/python3 -m pip install --require-hashes -r engine/requirements.lock
bash "$(dirname "$0")/stage-python-license.sh" engine-venv

bash "$(dirname "$0")/build-ffmpeg-mac.sh" engine-bin

cat > engine-bin/yt-dlp <<'SH'
#!/bin/sh
BUNDLE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$BUNDLE_DIR/../engine-venv/bin/python3" -m yt_dlp "$@"
SH
chmod 755 engine-bin/ffmpeg engine-bin/ffprobe engine-bin/yt-dlp
PYTHONPATH=engine engine-venv/bin/python3 -c 'import cv2, yt_dlp; from clip_engine.bridge_contract import BRIDGE_CONTRACT_VERSION; from clip_engine.services.layout_analyzer import LayoutAnalyzer; assert BRIDGE_CONTRACT_VERSION == 2; assert LayoutAnalyzer().available'
PYTHONPATH=engine engine-venv/bin/python3 -m unittest discover -s bridge -p 'test_*.py'
PYTHONPATH=engine engine-venv/bin/python3 bridge/smoke_smart_render.py engine-bin/ffmpeg
PYTHONPATH=engine engine-venv/bin/python3 bridge/smoke_transcription_audio.py engine-bin
expected_arch="$target_arch"
if [[ "$expected_arch" == "x64" ]]; then expected_arch="x86_64"; fi
for binary in engine-venv/bin/python3 engine-bin/ffmpeg engine-bin/ffprobe engine-bin/*.dylib; do
  [[ "$(file -Lb "$binary")" == *"$expected_arch"* ]] || {
    echo "Architecture mismatch in $binary; expected $target_arch" >&2
    exit 1
  }
done
echo "Resources prepared for $target_arch. Review third-party notices before packaging."
