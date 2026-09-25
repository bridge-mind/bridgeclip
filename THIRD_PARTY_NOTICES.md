# Third-party notices

BridgeClip's [MIT license](LICENSE) covers BridgeClip-owned source. It does not change the licenses of bundled components.

| Component | Source and terms | Shipped notice |
| --- | --- | --- |
| BridgeClip clipping engine assets | BridgeClip-owned engine source is MIT; bundled fonts and YuNet retain their own licenses | `engine/LICENSE`, `engine/THIRD_PARTY_NOTICES.md`, and license files under `engine/assets/` |
| FFmpeg and ffprobe 8.1.3 (macOS) | [FFmpeg source](https://ffmpeg.org/download.html), LGPL 2.1 or later build with GPL, nonfree and version 3 components disabled | `engine-bin/FFMPEG-LICENSE`, `engine-bin/FFMPEG-SOURCE.txt`, `engine-bin/FFMPEG-SOURCE.tar.xz`; build options are in `scripts/build-ffmpeg-mac.sh` and the binary's `-version` output |
| FFmpeg and ffprobe 8.1.3 (Windows/Linux) | [BtbN shared LGPL build](https://github.com/BtbN/FFmpeg-Builds), LGPL v3 with GPL-only/nonfree components excluded; OpenH264 supplies CPU H.264 encoding | Exact archive digests and recipe commit in `scripts/release/runtime-lock.json`; packaged license, configuration and runtime provenance. Publication additionally requires a reviewed corresponding-source archive with dependency notices. |
| libass and its caption-shaping libraries | [libass source](https://github.com/libass/libass) and the upstream projects identified in the bundle; each retains its own license | `engine-bin/BUNDLED_LIBRARIES.txt` records exact installed versions and `engine-bin/THIRD_PARTY_LICENSES/` contains the notices. When Homebrew omits GLib's license, staging copies the LGPL 2.1 text from `scripts/licenses/`. |
| Python 3.12.14 | [Python](https://www.python.org/downloads/), Python Software Foundation license; packaged via [python-build-standalone](https://github.com/astral-sh/python-build-standalone) | `engine-venv/PYTHON-LICENSE` and distribution notices in `engine-venv/` |
| yt-dlp | [yt-dlp Python package](https://github.com/yt-dlp/yt-dlp), Unlicense for its own code, with separate terms for dependencies | Package metadata and license files in `engine-venv/`; `engine-bin/yt-dlp` is a shell launcher on macOS/Linux and a BridgeClip-owned relocatable launcher on Windows |
| Geist fonts | [Geist](https://github.com/vercel/geist-font), SIL Open Font License 1.1 | `Geist-OFL.txt` in the packaged app resources |
| Electron, React and other Node packages | Versions and package names in `package-lock.json`; each package retains its own license | Package metadata in the bundled app and the generated Node dependency inventory |

The renderer build also generates `RENDERER-THIRD-PARTY-LICENSES.txt` in the packaged resources, containing the installed license texts for the packages included in its JavaScript bundle. This is separate from the production Node inventory because renderer packages are installed as development dependencies. The build fails when a bundled renderer package has no license text.

The OpusClip wordmark in `src/renderer/components/brand/OpusClipLogo.tsx` comes from [opus.pro](https://www.opus.pro/) and identifies the service in comparison details. It remains an OpusClip brand asset; BridgeClip's MIT license does not grant rights to that mark or imply affiliation.

The release packages the clipping engine committed in this repository. `scripts/prepare-resources.sh` and release CI stage the same pinned Python archive and hash-verified FFmpeg source. The final package still needs an asset and dependency license review, a signed/notarized install check, and a review of the generated inventories before publication.
