#!/usr/bin/env bash
set -euo pipefail

# Copy Homebrew-linked caption libraries beside ffmpeg and rewrite their load
# commands. FFmpeg's own libraries are statically linked, while libass and its
# dependencies are shipped as dylibs so the app works without Homebrew.
output_dir="${1:-engine-bin}"
queue=("$output_dir/ffmpeg" "$output_dir/ffprobe")
notices_dir="$output_dir/THIRD_PARTY_LICENSES"
mkdir -p "$notices_dir"
: > "$output_dir/BUNDLED_LIBRARIES.txt"

# Require libass as a dylib so its own dependency list and license inventory
# are visible to this staging pass. A silently static libass would be omitted.
if ! otool -L "$output_dir/ffmpeg" | grep -E '/libass[.][0-9]+[.]dylib' >/dev/null; then
  echo "FFmpeg must link a redistributable libass dylib" >&2
  exit 1
fi

for ((index=0; index<${#queue[@]}; index++)); do
  target="${queue[$index]}"
  while IFS= read -r dependency; do
    [[ -n "$dependency" ]] || continue
    name="$(basename "$dependency")"
    bundled="$output_dir/$name"
    if [[ ! -f "$bundled" ]]; then
      cp -L "$dependency" "$bundled"
      chmod u+w "$bundled"
      install_name_tool -id "@loader_path/$name" "$bundled"
      queue+=("$bundled")

      cellar_root="$(brew --cellar)"
      resolved="$(realpath "$dependency")"
      [[ "$resolved" == "$cellar_root/"* ]] || {
        echo "Bundled library is outside Homebrew Cellar: $dependency" >&2
        exit 1
      }
      relative="${resolved#"$cellar_root/"}"
      formula="${relative%%/*}"
      version_path="${relative#*/}"
      version="${version_path%%/*}"
      [[ -n "$formula" && -n "$version" && "$version_path" != "$version" ]] || exit 1
      formula_dir="$cellar_root/$formula/$version"
      if [[ ! -d "$notices_dir/$formula" ]]; then
        mkdir -p "$notices_dir/$formula"
        license_index=0
        while IFS= read -r license_path; do
          license_index=$((license_index + 1))
          cp "$license_path" "$notices_dir/$formula/${license_index}-$(basename "$license_path")"
        done < <(find -L "$formula_dir" -maxdepth 5 -type f \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' \) -print)
        if [[ "$license_index" -eq 0 ]]; then
          if [[ "$formula" == "glib" ]]; then
            # GLib bottles ship without their COPYING pointer and license text.
            # The vendored text comes from GLib 2.86.4's LICENSES directory.
            cp "$(dirname "$0")/licenses/LGPL-2.1-or-later.txt" "$notices_dir/$formula/LGPL-2.1-or-later.txt"
          else
            echo "Missing license text for bundled library: $formula" >&2
            exit 1
          fi
        fi
        # Record the version of the dylib actually copied. A runner may have
        # several installed versions, so `brew list --versions` is ambiguous.
        printf '%s %s\n' "$formula" "$version" >> "$output_dir/BUNDLED_LIBRARIES.txt"
      fi
    fi
    install_name_tool -change "$dependency" "@loader_path/$name" "$target"
  done < <(otool -L "$target" | awk 'NR > 1 { print $1 }' | grep -E '^/(opt/homebrew|usr/local)/' || true)
done

for target in "${queue[@]}"; do
  while IFS= read -r dependency; do
    case "$dependency" in
      /System/Library/*|/usr/lib/*) ;;
      @loader_path/*)
        [[ -f "$output_dir/${dependency#@loader_path/}" ]] || {
          echo "Missing bundled FFmpeg library dependency in $(basename "$target")" >&2
          exit 1
        }
        ;;
      *)
        echo "Unbundled FFmpeg library dependency in $(basename "$target")" >&2
        exit 1
        ;;
    esac
  done < <(otool -L "$target" | awk 'NR > 1 { print $1 }')
done
if ! grep '^libass ' "$output_dir/BUNDLED_LIBRARIES.txt" >/dev/null; then
  echo "libass is missing from the bundled library inventory" >&2
  exit 1
fi

# install_name_tool invalidates Homebrew's signatures. Electron Builder will
# apply the release identity later; ad-hoc signing keeps local builds runnable.
for target in "${queue[@]}"; do
  codesign --force --sign - "$target" >/dev/null 2>&1
done
