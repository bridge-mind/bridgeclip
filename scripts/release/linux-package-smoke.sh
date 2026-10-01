#!/usr/bin/env bash
# Install one Linux package on a clean distribution and prove the installed app
# works: it starts as an ordinary user, its renderer runs inside the Chromium
# sandbox, every startup tool check passes, and the shipped clipping runtime
# renders a captioned clip.
#
#   bash scripts/release/linux-package-smoke.sh dist/BridgeClip-<version>-linux-x64.<deb|rpm|AppImage>
#
# Run as root inside a disposable container (apt, dnf or zypper; the AppImage
# on Ubuntu 24.04). The container must allow the namespaces Chromium's sandbox
# creates, as a desktop does: docker run --security-opt seccomp=unconfined on a
# host that permits unprivileged user namespaces. The AppImage runs with
# APPIMAGE_EXTRACT_AND_RUN because containers have no FUSE.
set -euo pipefail

readonly SMOKE_USER=bridgeclip-smoke
readonly DISPLAY_NUMBER=:99
readonly STARTUP_TIMEOUT_SECONDS=90
readonly QUIT_TIMEOUT_SECONDS=20
readonly REQUIRED_TOOL_CHECKS=(python pythonDeps ffmpeg ffmpegCaptions ffprobe ytdlp engine bridgeRunner)

package=$(realpath "$1")
repo=$(cd "$(dirname "$0")/../.." && pwd)
log() { echo "=== $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

install_packages() {
  if command -v apt-get >/dev/null; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif command -v dnf >/dev/null; then
    dnf install -y -q "$@"
  elif command -v zypper >/dev/null; then
    zypper --non-interactive --quiet install --allow-unsigned-rpm "$@"
  else
    fail "no supported package manager"
  fi
}

case "$package" in
  *.deb)
    log "Install $(basename "$package") and its dependencies"
    install_packages "$package" xvfb procps
    app=/opt/BridgeClip/bridgeclip ;;
  *.rpm)
    log "Install $(basename "$package") and its dependencies"
    if command -v dnf >/dev/null; then install_packages "$package" xorg-x11-server-Xvfb procps-ng shadow-utils util-linux
    else install_packages "$package" xorg-x11-server-Xvfb procps shadow util-linux; fi
    app=/opt/BridgeClip/bridgeclip ;;
  *.AppImage)
    # An AppImage declares no dependencies. Install the libraries an Ubuntu
    # 24.04 desktop already has, and no libfuse2.
    log "Prepare $(basename "$package")"
    install -m 0755 "$package" /usr/local/bin/bridgeclip.AppImage
    command -v apt-get >/dev/null || fail "AppImage smoke tests run on Ubuntu 24.04"
    install_packages libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libsecret-1-0 xdg-utils xvfb procps
    app=/usr/local/bin/bridgeclip.AppImage ;;
  *) fail "unsupported package: $package" ;;
esac

id "$SMOKE_USER" >/dev/null 2>&1 || useradd --create-home "$SMOKE_USER"
home=$(getent passwd "$SMOKE_USER" | cut -d: -f6)
logs="$home/.config/BridgeClip/logs"

log "Start BridgeClip as $SMOKE_USER with the Chromium sandbox"
Xvfb "$DISPLAY_NUMBER" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
xvfb=$!
trap 'kill "$xvfb" 2>/dev/null || true' EXIT
runuser -u "$SMOKE_USER" -- env -i HOME="$home" PATH=/usr/local/bin:/usr/bin:/bin DISPLAY="$DISPLAY_NUMBER" \
  APPIMAGE_EXTRACT_AND_RUN=1 BRIDGECLIP_DISABLE_AUTO_UPDATE=1 "$app" >"$home/app-output.log" 2>&1 &
launcher=$!

checks=""
for _ in $(seq "$STARTUP_TIMEOUT_SECONDS"); do
  checks=$(grep -hs '"event":"system.checkTools"' "$logs"/*.log | tail -1 || true)
  [[ -n "$checks" ]] && break
  kill -0 "$launcher" 2>/dev/null || { cat "$home/app-output.log"; fail "BridgeClip exited during startup"; }
  sleep 1
done
[[ -n "$checks" ]] || { cat "$home/app-output.log"; fail "no startup tool check within ${STARTUP_TIMEOUT_SECONDS}s"; }

renderers=0
for pid in $(pgrep -u "$SMOKE_USER" -f -- '--type=renderer'); do
  renderers=$((renderers + 1))
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q -- '--no-sandbox' && fail "renderer $pid runs with --no-sandbox"
  [[ "$(grep '^Seccomp:' "/proc/$pid/status" | cut -f2)" == 2 ]] || fail "renderer $pid has no seccomp sandbox"
done
(( renderers > 0 )) || fail "no renderer process found"
echo "Sandboxed renderers: $renderers"

for check in "${REQUIRED_TOOL_CHECKS[@]}"; do
  grep -q "\"$check\":true" <<<"$checks" || fail "startup check $check did not pass: $checks"
done
echo "Startup tool checks passed: ${REQUIRED_TOOL_CHECKS[*]}"

pkill -TERM -u "$SMOKE_USER" -f -- "$app" || true
for _ in $(seq "$QUIT_TIMEOUT_SECONDS"); do
  pgrep -u "$SMOKE_USER" >/dev/null || break
  sleep 1
done
pkill -KILL -u "$SMOKE_USER" || true

log "Verify the installed clipping runtime"
if [[ "$package" == *.AppImage ]]; then
  resources_root=$(runuser -u "$SMOKE_USER" -- mktemp -d)
  (cd "$resources_root" && runuser -u "$SMOKE_USER" -- /usr/local/bin/bridgeclip.AppImage --appimage-extract >/dev/null)
  resources="$resources_root/squashfs-root/resources"
else
  resources=/opt/BridgeClip/resources
fi
runuser -u "$SMOKE_USER" -- env -i HOME="$home" PATH=/usr/bin:/bin \
  "$resources/engine-venv/bin/python3" "$repo/scripts/release/verify-runtime.py" "$resources"
log "$(basename "$package") passed"
