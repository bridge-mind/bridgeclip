#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Pass the packaged BridgeClip.app path}"
target_arch="${2:?Pass arm64 or x64}"
case "$target_arch" in
  arm64) mach_arch="arm64" ;;
  x64) mach_arch="x86_64" ;;
  *) echo "Architecture must be arm64 or x64" >&2; exit 1 ;;
esac

resources="$app_path/Contents/Resources"
node - "$app_path" <<'JS'
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses')
getCurrentFuseWire(process.argv[2]).then((wire) => {
  for (const [name, expected] of Object.entries({
    RunAsNode: 48,
    EnableNodeOptionsEnvironmentVariable: 48,
    EnableNodeCliInspectArguments: 48,
    EnableEmbeddedAsarIntegrityValidation: 49,
    OnlyLoadAppFromAsar: 49
  })) {
    if (wire[FuseV1Options[name]] !== expected) throw new Error(`Unsafe packaged Electron fuse: ${name}`)
  }
}).catch((error) => { console.error(error.message); process.exitCode = 1 })
JS
for required in \
  bridge/bridge_runner.py bridge/smoke_smart_render.py bridge/smoke_transcription_audio.py \
  engine/clip_engine/bridge_contract.py engine/LICENSE engine/THIRD_PARTY_NOTICES.md \
  engine-venv/bin/python3 engine-venv/PYTHON-LICENSE \
  engine-bin/ffmpeg engine-bin/ffprobe engine-bin/yt-dlp \
  engine-bin/FFMPEG-LICENSE engine-bin/FFMPEG-SOURCE.tar.xz \
  engine-bin/BUNDLED_LIBRARIES.txt \
  LICENSE THIRD_PARTY_NOTICES.md Geist-OFL.txt RENDERER-THIRD-PARTY-LICENSES.txt; do
  [[ -s "$resources/$required" ]] || {
    echo "Missing packaged resource: $required" >&2
    exit 1
  }
done
[[ -d "$resources/engine-bin/THIRD_PARTY_LICENSES" ]] || {
  echo "Missing packaged FFmpeg library notices" >&2
  exit 1
}
if find "$resources/engine-bin/THIRD_PARTY_LICENSES" -name 'LICENSE-REFERENCE.txt' -print -quit | grep -q .; then
  echo "Packaged FFmpeg library has a reference instead of license text" >&2
  exit 1
fi

for binary in "$resources/engine-venv/bin/python3" \
  "$resources/engine-bin/ffmpeg" "$resources/engine-bin/ffprobe" \
  "$resources/engine-bin/"*.dylib; do
  [[ "$(file -Lb "$binary")" == *"$mach_arch"* ]] || {
    echo "Wrong packaged binary architecture: $(basename "$binary")" >&2
    exit 1
  }
done
while IFS= read -r -d '' binary; do
  binary_info="$(file -Lb "$binary")"
  [[ "$binary_info" == *"Mach-O"* && "$binary_info" == *"$mach_arch"* ]] || {
    echo "Wrong packaged Python extension architecture: $(basename "$binary")" >&2
    exit 1
  }
done < <(find "$resources/engine-venv" -type f \( -name '*.so' -o -name '*.dylib' \) -print0)

for binary in "$resources/engine-bin/ffmpeg" "$resources/engine-bin/ffprobe" \
  "$resources/engine-bin/"*.dylib; do
  while IFS= read -r dependency; do
    case "$dependency" in
      /System/Library/*|/usr/lib/*) ;;
      @loader_path/*)
        [[ -f "$resources/engine-bin/${dependency#@loader_path/}" ]] || {
          echo "Missing packaged binary dependency in $(basename "$binary")" >&2
          exit 1
        }
        ;;
      *) echo "Nonportable packaged binary dependency in $(basename "$binary")" >&2; exit 1 ;;
    esac
  done < <(otool -L "$binary" | awk 'NR > 1 { print $1 }')
done

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$resources/engine" "$resources/engine-venv/bin/python3" -c \
  'import cv2, yt_dlp; from clip_engine.bridge_contract import BRIDGE_CONTRACT_VERSION; from clip_engine.services.layout_analyzer import LayoutAnalyzer; assert BRIDGE_CONTRACT_VERSION == 2; assert LayoutAnalyzer().available'
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$resources/engine" "$resources/engine-venv/bin/python3" \
  "$resources/bridge/smoke_smart_render.py" "$resources/engine-bin/ffmpeg"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$resources/engine" "$resources/engine-venv/bin/python3" \
  "$resources/bridge/smoke_transcription_audio.py" "$resources/engine-bin"

smoke_ass="$(mktemp -t bridgeclip-packaged-captions).ass"
trap 'rm -f "$smoke_ass"' EXIT
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
Dialogue: 0,0:00:00.00,0:00:00.20,Default,,0,0,0,,Packaged caption smoke test
ASS
"$resources/engine-bin/ffmpeg" -v error \
  -f lavfi -i color=c=black:s=320x240:r=24 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 0.2 \
  -vf "ass=$smoke_ass" \
  -af 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo' \
  -f null - >/dev/null
echo "Packaged clipping resources passed for $target_arch."
