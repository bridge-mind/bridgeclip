#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS is required to build bundled FFmpeg" >&2
  exit 1
fi

# BridgeClip engine burns captions with the ASS filter. A build without libass appears
# healthy until every captioned render fails, including the fallback render.
if ! command -v pkg-config >/dev/null || ! pkg-config --exists libass; then
  echo "Install pkg-config and libass before building FFmpeg" >&2
  exit 1
fi

if [[ "$(uname -m)" == "x86_64" ]] && ! command -v nasm >/dev/null; then
  echo "Install nasm before building Intel FFmpeg" >&2
  exit 1
fi

output_dir="${1:-engine-bin}"
version="8.1.3"
source_hash="7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3"
source_url="https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz"
work_dir="$(mktemp -d -t bridgeclip-ffmpeg)"
trap 'rm -rf "$work_dir"' EXIT

curl --fail --show-error --location --retry 3 "$source_url" -o "$work_dir/ffmpeg.tar.xz"
echo "$source_hash  $work_dir/ffmpeg.tar.xz" | shasum -a 256 --check
tar xJf "$work_dir/ffmpeg.tar.xz" -C "$work_dir"

pushd "$work_dir/ffmpeg-$version" >/dev/null
./configure \
  --disable-gpl --disable-nonfree --disable-version3 --disable-autodetect \
  --disable-network --disable-doc --disable-debug --disable-ffplay \
  --enable-static --disable-shared \
  --enable-libass --enable-zlib --enable-videotoolbox --enable-audiotoolbox
make -s -j3 ffmpeg ffprobe
popd >/dev/null

mkdir -p "$output_dir"
cp "$work_dir/ffmpeg-$version/ffmpeg" "$work_dir/ffmpeg-$version/ffprobe" "$output_dir/"
bash "$(dirname "$0")/stage-ffmpeg-libs-mac.sh" "$output_dir"
cp "$work_dir/ffmpeg-$version/COPYING.LGPLv2.1" "$output_dir/FFMPEG-LICENSE"
cp "$work_dir/ffmpeg.tar.xz" "$output_dir/FFMPEG-SOURCE.tar.xz"
cat > "$output_dir/FFMPEG-SOURCE.txt" <<EOF
FFmpeg $version source: $source_url
Source SHA-256: $source_hash
The complete source archive is included as FFMPEG-SOURCE.tar.xz.
Built with GPL and nonfree components disabled. The exact build configuration
is available from ffmpeg -version and scripts/build-ffmpeg-mac.sh in BridgeClip.
EOF

configuration="$("$output_dir/ffmpeg" -version | sed -n '3p')"
for required in --disable-gpl --disable-nonfree --disable-version3; do
  [[ "$configuration" == *"$required"* ]] || { echo "Missing $required" >&2; exit 1; }
done
for forbidden in --enable-gpl --enable-nonfree --enable-version3; do
  [[ "$configuration" != *"$forbidden"* ]] || { echo "Forbidden $forbidden" >&2; exit 1; }
done
for filter in ass crop overlay pad setsar gblur lutyuv vstack concat; do
  "$output_dir/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "[[:space:]]${filter}[[:space:]]" >/dev/null || {
    echo "Missing FFmpeg filter: $filter" >&2; exit 1;
  }
done
"$output_dir/ffmpeg" -hide_banner -encoders 2>/dev/null | grep h264_videotoolbox >/dev/null || {
  echo "Missing macOS H.264 encoder" >&2; exit 1;
}
"$output_dir/ffmpeg" -hide_banner -decoders 2>/dev/null | grep -E '[[:space:]]png[[:space:]]' >/dev/null || {
  echo "Missing PNG decoder for title-card overlays" >&2; exit 1;
}

smoke_ass="$(mktemp -t bridgeclip-captions).ass"
trap 'rm -rf "$work_dir"; rm -f "$smoke_ass"' EXIT
cat > "$smoke_ass" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 240
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:00.20,Default,,0,0,0,,Caption smoke test
ASS
"$output_dir/ffmpeg" -v error -f lavfi -i color=c=black:s=320x240:r=24 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 0.2 \
  -vf "ass=$smoke_ass" \
  -af 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo' \
  -f null - >/dev/null

echo "FFmpeg, bundled caption libraries, and ffprobe built and verified."
