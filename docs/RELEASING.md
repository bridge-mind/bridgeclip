# Releasing BridgeClip

BridgeClip source and official downloads live in `bridge-mind/bridgeclip`. Tests, package rehearsals, signing, and publication run in the maintainer's private automation repository. Public GitHub repositories cannot make Actions logs private. Public Actions execution is disabled; no signing credentials belong in this repository.

Only `matthewmiller2925` maintains the upstream repository. Main requires a pull request and the configured checks; release tags cannot be moved or deleted. Pull requests are limited to collaborators. Public source can still be forked under the MIT license. Administrators can change access policy, so review collaborators and automation access before each release.

## Packages

| System | Architecture | Download | Verification |
| --- | --- | --- | --- |
| macOS | Apple silicon, Intel | DMG and updater ZIP | Developer ID, team `9CBJCDR3J2`, notarized app and DMG, stapling, Gatekeeper |
| Windows | x64 | NSIS EXE | BRIDGEMIND LLC Authenticode signatures; timestamp; installed runtime smoke |
| Linux | x64 | AppImage and DEB | Installed/extracted runtime smoke; signed checksum manifest |

These targets describe the pipeline, not an assertion that a release is available. Windows ARM64 and Linux ARM64 are not release targets. Initial native package rehearsals and credential provisioning must pass before the first release. Do not advertise an unsupported OS version based only on the build runner version.

## Maintainer sequence

1. Review the public commit, dependency notices, and generated inventories. Do not publish pre-BridgeClip private history. The existing export script remains available for constructing a clean public source snapshot.
2. Run private CI for the exact 40-character source commit. It runs macOS, Windows, and Linux checks plus macOS/Linux Electron end-to-end tests without signing credentials. The private source watcher checks main and maintainer-owned pull requests periodically; dispatch manually for an immediate run.
3. Run the private package rehearsal for that commit. This exercises native packaging and the relocated clipping runtime without publishing unsigned packages.
4. Create an immutable `vX.Y.Z` tag on reviewed main, matching `package.json`. Dispatch the private release workflow from its protected main branch with `platform=all`, `macos`, `windows`, or `linux`. The version tag stays the same format regardless of platform. The workflow resolves `refs/tags/<tag>`, checks main ancestry and version, freezes one commit, and runs CI again for that exact commit.
5. Selected release jobs stage runtimes, build packages, sign/notarize them, and test the packaged clipping engine. A macOS selection always builds Apple silicon and Intel. Windows acceptance installs the actual NSIS artifact and checks its publisher. Linux acceptance installs the DEB and extracts the AppImage. A captioned H.264 clip at 2× speed must retain audio and have the expected duration.
6. Publication requires every package for the selected platform, or all four platform/architecture builds for `all`. It verifies updater hashes against final bytes, merges macOS metadata when selected, creates a manifest recording the platform, adds the reviewed FFmpeg corresponding-source archive, and signs checksums using the separate release key. It rechecks the source tag, creates a draft, downloads every uploaded asset again, and compares every digest. With publication selected, only then does the draft become public. A later release for another platform needs a new version tag; published release bytes are never overwritten.
7. Never overwrite a published version. Fixes use a new version/tag. An incomplete upload remains a draft; investigate before explicitly removing a failed draft and retrying. Withdraw a bad public version and replace it with a higher version so installed updaters can recover. To withdraw one, delete it, turn it back into a draft, or mark it as a prerelease. A newer release for a different platform is not enough: when the latest release lacks a platform's feed, the updater picks that platform's highest published version, whichever release GitHub marks latest.

The website's download buttons resolve the newest published release with macOS installers, and it links to [GitHub Releases](https://github.com/bridge-mind/bridgeclip/releases). The updater (`src/main/auto-updater.ts`) reads `latest-mac.yml`, `latest.yml`, or `latest-linux.yml` from the release GitHub marks as latest. When that release doesn't ship the running platform, which happens after a single-platform release, `src/main/update-provider.ts` falls back to the newest published release that has the platform's feed, so platforms can ship on separate schedules. Always publish with **Set as the latest release** (the workflow does), never as a prerelease: prereleases are ignored.

Installed apps check about 15 seconds after launch and then every four hours, download in the background, and install on **Restart to update** or the next quit. Updates are off for unpackaged builds, for macOS builds not signed by team `9CBJCDR3J2`, for a macOS app running from its disk image or quarantine, and when `BRIDGECLIP_DISABLE_AUTO_UPDATE=1`. Test a real signed update from the first installed version to the next before claiming update acceptance; a packaging rehearsal does not prove an upgrade path.

## Runtime reproduction

macOS: `bash scripts/prepare-resources.sh arm64` on Apple silicon, or `x64` on Intel. This builds LGPL FFmpeg and stages its caption libraries and licenses.

Windows/Linux x64: `python scripts/release/stage-runtime.py` from a clean checkout. Windows requires Visual C++ build tools for the relocatable yt-dlp launcher. Linux requires `patchelf`. Python and FFmpeg downloads are pinned by SHA-256 in `scripts/release/runtime-lock.json`. An HTTPS mirror may be selected with `BRIDGECLIP_FFMPEG_MIRROR`, preserving the same digest checks. Upstream FFmpeg daily assets expire; official automation keeps a private mirror of the exact archives.

Run `npm ci`, application and engine tests, dependency audits, `npm run build`, then electron-builder for the native target. Official Windows builds use `scripts/release/windows-config.cjs` with Azure signing configuration and `forceCodeSigning`; unsigned developer packages must never be labeled official releases.

`scripts/release/verify-runtime.py <packaged-resources-directory>` copies resources to a path containing spaces and tests the shipped Python, FFmpeg, framing model, captions, speed, audio, and downloader without relying on the checkout. `scripts/release/collect-artifacts.cjs` rejects missing platforms, mismatched versions, and altered artifacts.

Windows/Linux FFmpeg uses the LGPL shared upstream build, with OpenH264 for CPU encoding. Its LGPL version and dependency set differ from the minimal macOS build. macOS release jobs archive the exact FFmpeg source, bundled Homebrew library sources, formulas, patches, and license inventory for each architecture. Windows/Linux publication remains blocked until a reviewed corresponding-source distribution for their exact dependency set has a pinned URL and SHA-256 in private publication configuration. A link to upstream build recipes alone is not that distribution.

## Verify a download

Obtain `resources/release-public-key.pub` from a trusted source checkout. Compare its fingerprint independently before first use; trusting a key downloaded beside an artifact alone does not establish authenticity.

Use OpenSSL 3 for this verification. On macOS, the built-in LibreSSL does not support this Ed25519 command; use the `openssl` executable from an OpenSSL 3 installation.

```sh
openssl pkeyutl -verify -rawin -pubin \
  -inkey resources/release-public-key.pub \
  -in SHA256SUMS.txt -sigfile SHA256SUMS.sig
shasum -a 256 --check SHA256SUMS.txt
```

The manifest records the exact public source commit. macOS and Windows also have operating-system code signatures. Linux checksum signatures can be verified manually; the current Electron updater uses HTTPS and generated SHA-512 metadata and does not verify this detached signature itself.
