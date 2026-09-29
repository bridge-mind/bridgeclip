# Develop BridgeClip

[Overview](../README.md) · [Contributing](../CONTRIBUTING.md) · [Architecture](ARCHITECTURE.md)

## Set up

**Prerequisites:** Node.js 22, Python 3.12, and FFmpeg with the libass-backed `ass` filter for captions. The clipping engine, model, fonts, and locked Python dependencies are included in this repository. In development, BridgeClip uses FFmpeg from `engine-bin/` when it exists, then falls back to your `PATH`. Provider keys are needed for live jobs, not tests.

### macOS and Linux

```bash
git clone https://github.com/bridge-mind/bridgeclip
cd bridgeclip
python3.12 -m venv engine/.venv
engine/.venv/bin/pip install --require-hashes -r engine/requirements.lock
npm ci
npm run dev
```

BridgeClip finds its in-repo engine and virtual environment automatically. **Settings → System check** shows the Python, yt-dlp, FFmpeg, and engine checks; set **Python path** in development if you use another interpreter.

Local macOS runs apply the BridgeClip Dock icon when the window appears and when the app is activated. Restart Electron after changing startup code; refreshing the renderer only updates the UI.

On Linux, use system FFmpeg with the libass-backed `ass` filter (`ffmpeg -hide_banner -filters | grep -E '[[:space:]]ass[[:space:]]'`) and Python 3.12. Arch: `sudo pacman -S ffmpeg`. Skip `scripts/prepare-resources.sh` during development; it prepares macOS release resources. Official Linux AppImage and DEB packages are available through [Releases](https://github.com/bridge-mind/bridgeclip/releases).

### Windows

Install Python 3.12 and FFmpeg with the `ass` filter on `PATH`, then use PowerShell:

```powershell
git clone https://github.com/bridge-mind/bridgeclip
cd bridgeclip
python -m venv engine/.venv
engine/.venv/Scripts/python.exe -m pip install --require-hashes -r engine/requirements.lock
npm ci
npm run dev
```

The in-repo Windows virtual environment is detected automatically. Native Windows CI checks the engine, desktop modules, renderer, and production build. Tests that create file symlinks report a skip if Windows denies symlink creation; they run when the account has the required capability. Release-helper tests use Git Bash. The private release pipeline includes Windows installers; a real signed upgrade must pass acceptance before update support is claimed.

### Packaging

Private release workflows package the in-repo engine and media tools for macOS, Windows, and Linux. For local packaging, follow [the release guide](RELEASING.md) for your platform. On macOS, first run `bash scripts/prepare-resources.sh arm64` (or `x64` on Intel). Signing credentials are still required for signed official builds.

## Checks and scripts

Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` before proposing code changes. For engine changes, install `pytest` in `engine/.venv` and run the engine suite; test tools are not in the runtime lockfile.

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the app with hot reload |
| `npm run typecheck` | Type-check the main process and renderer |
| `npm run lint` | Check TypeScript and JavaScript source with ESLint |
| `npm run build` | Production build into `out/` |
| `npm run test:bridge` | Run Python bridge regression tests |
| `engine/.venv/bin/python -m pytest -q engine/tests` | Run the clipping engine tests after installing pytest |
| `npm run test:release` | Check complete release artifacts and updater metadata |
| `npm run test:renderer` | Check renderer state and parsing regressions |
| `npm run test:main` | Check desktop security and pipeline regressions |
| `npm run test:zernio` | Check social account, upload and posting flows against local mocks |
| `npm run dist:mac` | Package the current Mac architecture into `dist/` after preparing matching resources (signing needs a Developer ID) |
| `npm run icons` | Export app icons from the imagegen master `resources/bridgeclip-icon.png` (macOS; see the [icon guide](../scripts/icon/README.md)) |

## Project layout

```
src/main/        Electron main process: settings, pipeline runner, IPC, optional Zernio posting
src/preload/     The typed window.bridgeclip API exposed to the renderer
src/renderer/    React UI (Create, Library, Jobs, Accounts, Posts, Automations, Settings)
src/shared/      Product constants shared by main and renderer
bridge/          Python worker protocol and network guard
engine/          BridgeClip clipping engine, assets, locked Python dependencies, and tests
scripts/icon/    Icon and logo generators
```

The visual system (tokens, components and rules) is documented in [DESIGN.md](../DESIGN.md).
The desktop trust boundaries and bridge protocol are described in [Architecture](ARCHITECTURE.md).
The [open-source readiness checklist](OPEN_SOURCE_READINESS.md) tracks the remaining release gates and maintenance priorities.
