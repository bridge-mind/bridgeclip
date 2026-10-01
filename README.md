<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/bridgeclip-logo.svg" />
    <img src="resources/bridgeclip-logo-light.svg" alt="BridgeClip" height="56" />
  </picture>
</h1>

<p align="center"><strong>Turn long videos into captioned short-form clips.</strong></p>

<p align="center">
  An open-source desktop app from <a href="https://www.bridgemind.ai">BridgeMind</a>.
  Find moments in podcasts, streams and interviews, refine the edit, and export clips for your audience.
  Video rendering runs on your computer; AI uses your own OpenRouter key.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/bridge-mind/bridgeclip/releases"><img src="https://img.shields.io/github/v/release/bridge-mind/bridgeclip?label=download" alt="Latest release" /></a>
  <a href="https://www.bridgemind.ai/discord"><img src="https://img.shields.io/badge/Discord-builders-5865F2?logo=discord&logoColor=white" alt="Discord community" /></a>
</p>

<p align="center">
  <a href="#download">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#contributing">Contributing</a>
</p>

## Download

Get BridgeClip from **[bridgeclip.ai](https://www.bridgeclip.ai)** or [GitHub Releases](https://github.com/bridge-mind/bridgeclip/releases).

| Platform | Architecture | Install |
| --- | --- | --- |
| macOS | Apple silicon, Intel | Open the matching DMG and drag BridgeClip to Applications. |
| Windows | x64 | Run the signed EXE installer. |
| Linux | x64 | Install the DEB (Debian, Ubuntu) or RPM (Fedora, openSUSE), or make the AppImage executable and open it. On Ubuntu 24.04 and later, use the DEB. |

Packages include Python, FFmpeg and yt-dlp. macOS builds are signed and notarized; Linux needs an unlocked desktop secret service to save API keys. Installed releases support [automatic updates](docs/usage.md#automatic-updates).

This README describes the current source. Check the [release notes](https://github.com/bridge-mind/bridgeclip/releases) for features available in your downloaded version, and the [verification guide](docs/RELEASING.md#verify-a-download) for signatures and checksums. The [changelog](CHANGELOG.md) lists what changed in each version; in the app, open **Settings → About → Changelog**.

## Quick start

You need an **[OpenRouter API key](https://openrouter.ai/keys) with available credit**. No BridgeMind account is required.

1. **Connect your key.** Paste it into the first-launch setup card.
2. **Add a video.** Choose a local file, a public YouTube link, or a public, completed Twitch VOD.
3. **Choose your workflow and style.** Select Automatic or Review & edit, then choose framing, clip lengths and captions.
4. **Generate and export.** Follow progress in Jobs; find finished clips in Library and your output folder (default: `~/BridgeClip`).

| Workflow | What happens |
| --- | --- |
| **Automatic** | Finds moments, frames the video and exports captioned clips. Optional Jev editorial review is off by default. |
| **Review & edit** | Opens candidates in an editor so you can refine cuts, framing and captions before exporting. Always uses Jev candidate reviews through OpenRouter. |

Use footage you have permission to use. See the [user guide](docs/usage.md) for source limits, setup and troubleshooting.

## Features

### Find complete moments

- Discover clips with their setup and ending intact, using the source transcript and metadata.
- Choose **Quality**, **Economy**, or **Advanced** with your own compatible OpenRouter models.
- Enable optional source research and Jev editorial checks for context, title support and completeness.

### Refine the edit

- Trim, split and extend cuts with synchronized source and output previews.
- Adjust crops, use full-frame, split or fit layouts, and inspect suggested camera changes.
- Correct and position captions, suppress them in selected sections, and export one clip or all ready clips. Edits autosave.

### Shape the final video

- Export vertical **9:16** or horizontal **16:9** clips with framing that follows faces and accommodates screen shares.
- Preview **nine caption styles** with animated samples.
- Cut dead air and export at **1×–2× speed**, preserving voice pitch and caption timing.

### Organize and publish

- Bookmark runs, search clips, track posted status and manage exports in Library.
- Draft platform-specific titles, captions and tags, then review them before applying.
- Connect social accounts through **Zernio** to publish, schedule, reorder queues and recover held clips. Daily automations require BridgeClip to be open.

### Chat with BridgeClip

- Connect your **Claude** (Pro or Max, through Claude Code) or **ChatGPT** (through Codex) subscription in **Settings → Assistant**, or use any **OpenRouter** model with your OpenRouter key, then ask in **Chat** in plain words. Pick the model for each message from the model menu.
- The assistant uses BridgeClip's own tools: it can start clipping jobs, browse and tidy the Library, export Review & edit clips, build and run automations, post or schedule clips and adjust settings.
- It can find YouTube videos by channel or search ("clip the latest BridgeMind video"), search the web and read web pages.
- Anything that publishes, deletes or spends OpenRouter credit on clipping shows an approval card first. The assistant has no shell or file access.

### Understand each run

- Follow processing stages, candidate progress and the saved time breakdown in Jobs.
- Inspect transcripts, edit decisions and Jev reviews, including failed runs.
- See model usage and provider-reported costs, with incomplete totals labeled.

<p align="center">
  <img src="docs/assets/video-speed.png" alt="BridgeClip Create screen with vertical and horizontal formats, smart framing, dead-air removal and video speed controls" width="900" />
</p>

## AI, costs and privacy

**Rendering is local; AI processing uses cloud providers.** Audio and transcripts go to OpenRouter. Visual-only planning and enabled AI framing checks can send sampled frames. Your videos and keys do not pass through a BridgeMind server.

- **Bring your own accounts.** AI calls bill your OpenRouter account. Optional social publishing uses your Zernio account and uploads selected clips to its service.
- **Choose additional analysis.** Jev review for Automatic, source web research and additional visual context are opt-in betas. Review & edit always uses Jev; these features can add provider cost.
- **Chat uses your own account.** The assistant runs your signed-in Claude Code or Codex CLI on this computer, or calls an OpenRouter model with your key. Your messages and the tool results it reads (titles, transcripts, account names) go to Anthropic, OpenAI or OpenRouter under that account; BridgeClip never sees your Claude or ChatGPT sign-in. Chatting on OpenRouter, and its web searches, are billed to your OpenRouter key.
- **Keep control of local data.** Keys use operating-system secure storage. Run folders retain transcripts and edit records; editor projects also retain a source copy and playback preview.

Read [AI, costs and privacy](docs/ai-and-privacy.md) for provider data flows, review behavior and storage cleanup.

## Documentation

| I want to… | Read |
| --- | --- |
| Create clips, manage Library or troubleshoot jobs | [User guide](docs/usage.md) |
| Refine cuts, camera changes and captions | [Editor guide](docs/editor.md) |
| Understand AI reviews, costs and stored data | [AI and privacy](docs/ai-and-privacy.md) |
| Choose models or understand transcription retries | [Model selection and transcription](docs/transcription.md) |
| Prepare publishing drafts and automate posts | [Publishing and metadata](docs/automation-metadata.md) |
| Connect Claude, ChatGPT or OpenRouter and chat with BridgeClip | [Assistant](docs/assistant.md) |
| Build, test or package the app | [Development](docs/development.md) · [Releasing](docs/RELEASING.md) |

## Develop

The app uses Electron and React with a Python clipping engine. Development requires **Node.js 22**, **Python 3.12**, and **FFmpeg with the libass-backed `ass` filter**. Provider keys are needed for live jobs, not tests.

See the [development guide](docs/development.md) for macOS, Linux and Windows setup, commands and project layout. [Architecture](docs/ARCHITECTURE.md) covers process boundaries; [Design](DESIGN.md) describes the visual system.

## Contributing

Bug reports and focused bug-fix PRs are welcome. Feature and other change PRs need an explicit maintainer greenlight before implementation. Discuss those proposals in [GitHub Issues](https://github.com/bridge-mind/bridgeclip/issues) and wait for approval before starting work.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full policy and follow the [code of conduct](CODE_OF_CONDUCT.md). Join [Discord](https://www.bridgemind.ai/discord) for community help, and report security concerns through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © BridgeMind
