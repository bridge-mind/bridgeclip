# Changelog

What's new in each version of BridgeClip, newest first. You can also read this in the app under **Settings → About → Changelog** or **Help → Changelog**. Downloads for every version are on [GitHub Releases](https://github.com/bridge-mind/bridgeclip/releases).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Maintainers: see [Changelog](CONTRIBUTING.md#changelog) in the contributing guide before editing.

## [Unreleased]

### Added

- **What to clip** in Create → Clips: describe the moments you want, such as "every time they talk about pricing". Leave it blank to get the strongest moments as before.
- **Show title at the top** in Create → Captions turns off the title card on Automatic clips.
- **Review & edit** workflow: look over clip candidates before exporting. Trim, split and extend cuts, change layouts and camera changes, fix and place captions, then bake one clip or every ready clip with **Bake all**. You can also swap in a higher-quality copy of the source video.
- Jobs show progress for each stage on a timeline, a **Job Breakdown** of where the time went, and **Details** with reviews, the transcript and source research.
- The Library shows how many clips in each run are posted, lets you bookmark runs, and deletes whole runs or single clips.
- Settings → About shows how much disk space your output folder uses.
- YouTube links show a preview in Create.
- Automations have **Submitted** and **Needs attention** sections, drag to reorder, **View in Library**, reviewable title and caption drafts, **Refresh post status** and **Return to queue**.
- **TypeSafe Jev review** and **Research the source before clipping**, both in beta and off by default. Turn them on in Settings. Both use extra OpenRouter credit.
- **Free editor media** removes an editor project's source copy and preview once you're done with it.
- BridgeClip asks whether to save or discard unsaved edits before quitting, and offers **Reload project** when a project was changed elsewhere.
- This changelog, in Settings → About and the Help menu.
- **Chat**: run BridgeClip in plain words. It uses your Claude (Pro or Max, through Claude Code) or ChatGPT (through Codex) subscription, or any OpenRouter model with your OpenRouter key; connect them in **Settings → Assistant**. The assistant can start clipping jobs, manage the Library and automations, and post or schedule clips. Anything that publishes, deletes or spends OpenRouter credit on clipping asks you first.
- Chat's model menu has a tab each for Claude, OpenAI and OpenRouter (search every OpenRouter model that can use tools, with prices), and each reply shows the logo and model that wrote it. Recent chats are listed beside the conversation, with search.
- Chat can find YouTube videos by channel or search, so "clip the latest BridgeMind video" works without a link, and can search the web and read web pages.
- An **RPM** package for Linux on Fedora, RHEL and openSUSE, alongside the AppImage and DEB.

### Changed

- Smart framing ignores weak background faces, stays on a speaker who briefly looks away, follows talking heads inside 4:3 video, and analyzes footage faster.
- Screen + webcam clips fill the top panel again.
- Editor previews use much less disk space, and downloaded sources are moved into the project instead of copied.
- Linux packages are smaller: the media libraries are no longer stored three times. They now also include the JavaScript runtime that the YouTube downloader needs.

### Fixed

- Smooth camera movement in the editor works in installed apps.
- **Bake all** keeps going when one clip fails, and says what went wrong.
- Titles with emoji at the length limit no longer break editor projects.
- Automations: submitted and held clips can be removed, posted clips no longer count toward the 500-clip limit, a post deleted in Zernio no longer leaves its clip stuck, slots that come due during an enhancement are kept, and one pending draft no longer blocks the rest of the queue.
- Unattended posts no longer use text from the source video's description, and refuse web addresses or @handles that aren't said in the video.
- Deleting a clip also removes its caption and YouTube text files.
- A missing transcript shows a clear message, and research citations can be selected and copied.
- Screen + webcam clips fill the bottom panel with the webcam, instead of showing a small webcam over a blurred copy of itself when the webcam in the source video is small.
- The Linux AppImage starts without libfuse2, which current Ubuntu, Debian and Fedora no longer install, and keeps the app sandbox where the system allows it.
- The Linux DEB installs everything it needs to start on minimal Ubuntu 22.04 and 24.04 systems.
- Linux launchers and docks show the BridgeClip icon and group its windows with the launcher.
- Linux DEB and RPM installs update from **Restart to update**, which asks for an administrator password and says so if the install fails. They no longer try to install silently when you quit.
- **Settings → About** says when a Linux copy can't update itself, such as an extracted AppImage, instead of doing nothing.
- On Linux desktops such as sway, i3 and Hyprland, API keys save to your keyring (GNOME Keyring, KWallet or KeePassXC) instead of being refused, and the message says what to do when no keyring is running.
- A locked or changed system keychain no longer stops BridgeClip with "Could not load settings". **Settings → API keys** says which saved key can't be read and keeps it until you unlock the keychain or enter the key again.

## [0.1.19] - 2026-09-27

One release for macOS, Windows and Linux.

### Added

- Linux installers for x64: an AppImage and a DEB package.

### Changed

- YouTube downloads that fail for a temporary reason retry automatically with a fresh link.
- Playlists and live or upcoming streams are turned away before downloading. Paste a link to a single, finished video.

### Fixed

- An automation keeps posting the rest of its queue when one clip's details can't be verified.
- Generated post captions that quote the video are accepted when the speaker stutters, and captions can no longer contain web links.
- Hardened how BridgeClip handles captions, file paths, titles, downloads and its bundled Python, so unusual input can't change video processing commands or load unexpected code.

## [0.1.18] - 2026-09-25

### Added

- A signed installer for Windows x64. This version shipped for Windows only and has no other changes from 0.1.17.

## [0.1.17] - 2026-09-25

The first version with downloadable installers, starting with macOS.

### Added

- macOS apps for Apple silicon and Intel, signed with BridgeMind's Developer ID and notarized by Apple.
- Automatic updates. BridgeClip checks shortly after launch and every four hours, downloads in the background, and installs when you choose **Restart to update** or the next time you quit. Settings → About shows the status and has **Check for updates**.
- Clip public, finished Twitch VODs by pasting their link.
- **Video speed** in Create → Format speeds up every clip in a job, from 1.1× to 2×. Voices keep their pitch and captions stay in sync.
- TikTok accounts in automations. Each clip gets a review of its caption, audience, interactions and disclosures before it can post.
- **Economy** clipping mode, which uses lower-cost models and skips AI vision checks.
- **Advanced** clipping mode, for choosing your own transcription and planning models from OpenRouter.
- A **Posts** page with your posting history.
- Run stats that compare time and cost with OpusClip when there's enough information for a fair comparison.
- New app icons.

### Changed

- Captions are placed more carefully around faces.
- Jobs with a start and end time only transcribe that part of the video, which is faster and cheaper.
- Accounts, Automations and Jobs are more compact, and menus and confirmation dialogs work with the keyboard.
- Clip cost details name both transcription models when a job switches models partway through.
- Setting up a Zernio profile, and recovering from access problems, is clearer in Accounts.

### Fixed

- Automations could post the same clip twice after a slow or failed response.
- A clip you return to the automation queue after checking it by hand can post again.
- A scheduled slot stays free when a changed clip's TikTok approval is withdrawn, so you can review it and still post on time.
- Automation retries no longer stop at transcription with an HTTP 400 error.
- Page shortcuts no longer close a post dialog while it's uploading.
- Starting a job no longer fails on some IPv6 networks.
- Windows: Python is found reliably, edits with many cuts work, and saved results are opened safely.
- Exports whose audio drifts out of sync are caught before they're saved.

## [0.1.16] - 2026-09-24

### Added

- BridgeClip's source code is public under the MIT license. Installers start with 0.1.17.

[Unreleased]: https://github.com/bridge-mind/bridgeclip/compare/v0.1.19...HEAD
[0.1.19]: https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.19
[0.1.18]: https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.18
[0.1.17]: https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.17
[0.1.16]: https://github.com/bridge-mind/bridgeclip/tree/7107574215cc7f1d4059d10d62bd82014a3ba46f
