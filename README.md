<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/bridgeclip-logo.svg" />
    <img src="resources/bridgeclip-logo-light.svg" alt="BridgeClip" height="56" />
  </picture>
</p>

<h3 align="center">Turn long videos into captioned short-form clips, on your own computer.</h3>

<p align="center">
  An open-source AI clipping app from <a href="https://www.bridgemind.ai">BridgeMind</a>.
  Drop in a podcast, stream, YouTube link or Twitch VOD link, and BridgeClip finds the strongest moments,
  cuts them to 9:16 or 16:9, and burns in word-by-word captions.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/bridge-mind/bridgeclip/releases"><img src="https://img.shields.io/github/v/release/bridge-mind/bridgeclip?label=download" alt="Latest release" /></a>
  <a href="https://www.bridgemind.ai/discord"><img src="https://img.shields.io/badge/Discord-builders-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

---

## Why BridgeClip?

- **No BridgeMind account or backend.** BridgeClip runs on your machine and calls OpenRouter directly with your own provider accounts and keys. Optional social account connections use your Zernio account and API key. Your videos and keys do not pass through a BridgeMind server.
- **Pay only for what you use.** Transcription and clip planning bill your OpenRouter account at their prices. Rendering happens locally with FFmpeg. BridgeClip shows estimated API cost when the providers return usable usage data.
- **Captions that look native.** Nine styles (Viral, Hormozi, Bold, Clean, Minimal, Fire, Glow, Neon, Karaoke), each with a live preview before you render.
- **MIT licensed.** Fork it, change it, ship it.

## How it works

```
 Source video ──▶ Download ──▶ Transcribe ──▶ Find moments ──▶ Render
 (file or link)    yt-dlp      OpenRouter      OpenRouter        FFmpeg
                           MAI Transcribe 2    LLM ranks the     crop, captions,
                               word timings    best moments      one file per clip
```

In **Create**, choose a workflow before continuing: **Automatic · Beginner friendly** finds, checks and exports clips; **Review & edit · For advanced users** lets you choose and adjust candidates before export. Each new video starts with neither workflow selected. YouTube links show a video card with its title, channel and thumbnail, plus duration, views and upload date when available. Metadata loads in the background and never blocks clip setup.

Every run gets its own folder. The **Library** shows completed clips with virality scores, timecodes and tags. **Jobs** shows what is running or queued right now (up to two clipping runs go at once; more wait in a queue) and every earlier run, including completed, failed, cancelled and interrupted jobs; completed runs open directly in Library, and failed runs from this session can run again. Each previous job has a three-dot menu for **Open in Library** (or **Open job** for session jobs), **Open folder** and **Details**. Details opens the saved transcript and edit trace, including for failed runs. Older runs without a saved status appear as unfinished. You can optionally connect social accounts through Zernio to publish or schedule a selected clip.

Inside a Library run, **Search clips** filters by title, tag or clip number across both posted and unposted clips. Selection and bulk actions apply only to visible results. The YouTube icon beside **Inspect transcript & edits** opens the original video in your browser when a YouTube source link is saved. **Not Posted** and **Posted** are independently collapsible sections with clip counts. **Not Posted** opens by default and appears first; **Posted** starts collapsed below it. Selection applies only to expanded sections. Badges distinguish scheduled, publishing, partially posted and failed posts using this workspace’s saved posting history. Each clip’s **…** menu contains posting, adding to an automation, opening its folder, and **Delete clip**. Delete a single clip directly from this menu without selecting it first; the confirmation names the clip before permanently removing its local export. Choose **Mark as posted** for clips you published yourself; the mark persists without a connected account and can be undone from the same menu. It changes local Library status only. Select clips to reveal the red trash button for deleting just those exports, with confirmation; source footage, editor edits and other clips are preserved. The post dialog can enhance platform-specific titles, captions and tags using the same transcript, source context and optional research as Automations; review and apply the draft before posting.

Library overview cards show the total clip count at the top left and separate **Posted** / **Not Posted** counts below the title. Bookmark a run to keep it in the **Bookmarked** section. Cards move smoothly between Bookmarked and Recent runs without reloading their thumbnails; removing the last bookmark returns to one **All runs** grid. Bookmarks persist across restarts, and reduced-motion preferences turn off movement. The trash action asks for confirmation before permanently deleting the run folder, all clips and other files inside it, and cached clip previews. It does not remove published social posts or copies stored elsewhere. Active runs cannot be deleted.

In **Automations**, the header shows scheduling status once. **More settings** holds caption writing, YouTube options and the automation name; previous failures are expandable historical messages. Use **Acknowledge warnings** for one automation or **Acknowledge all warnings** for every automation to clear existing failure indicators without a successful post. Acknowledgements survive restarts; new failures warn again. Messages remain in the run details or clip info, and acknowledged clips awaiting review appear under **Held clips** without being retried or returned to the queue. Held clips have a visible **Return to queue** action and, when linked to a Zernio post, **Refresh post status**. A fresh Zernio check moves already published or active posts to **Submitted** and permits requeuing only fully failed posts; partial or uncertain results stay held for review in Posts. Returning a failed linked clip disables Retry on its old Posts entry so only the new queue attempt can post. Recovery also works when local post history was removed or aged out, provided Zernio returns complete post details. Returning an unlinked clip requires confirming it was not published. Required setup and TikTok approvals still apply. **Check Zernio status** makes a fresh, read-only account health request and shows connection/permission issues without uploading or posting. Zernio’s documented health API does not expose its protective upload cooldown, so the result explicitly leaves that hold unconfirmed even when the connection is healthy. Failed checks never fall back to cached success.

In **Automations**, drag a queued clip’s handle to change its order with animated movement and automatic scrolling. For keyboard sorting, focus the handle, press Space to pick up the clip, use the Up/Down arrow keys, then press Space to drop or Escape to cancel. Submitted or uncertain items stay in place. The bank separates **Queued**, **Needs attention** (when needed), and **Submitted** clips. The Queued heading shows the next posting slot and its timezone, or indicates that scheduling is paused or unconfigured. Hover or focus each row’s info icon for its added/submitted timestamps, source, caption and metadata status. Use the actions menu to edit a bank item, **Show in Finder** (**Show in folder** on other systems) to reveal its saved video, or **Remove from queue**, and **View in Library** to open its source run filtered to that exact clip, including submitted clips and items with enhanced titles. Choose **Show all clips** to return to the full run. Submitted clips have no removal option. Removing a queued clip leaves the original file intact. Reviewed metadata is marked **Enhanced** in the info tooltip and hides the Enhance button; selecting a platform that still needs metadata makes enhancement available again.

Dismiss a clip’s upload or metadata error with its **×** button; dismissal survives restarts, preserves the message in clip info, and a new failure shows the warning again. **Run now** prioritizes ready clips without previous upload errors. Use **Retry clip** to retry a specific failed upload without changing queue order, even after dismissing its error. Retry is available only for queued clips that have not been submitted; metadata drafts and required TikTok review must be resolved first.

**Enhance by source video** works with both linked videos and attached files. Select a source and optionally describe the video or suggest an emphasis for its titles, captions and tags. Review the generated draft before applying it.

In **Create → Captions**, the selected style plays an animated sample showing how words appear and highlights advance. Pause or restart it to compare styles.

**Settings → About → Content storage** shows the total file size and file count in your output folder. Refresh to recalculate; inaccessible files are reported as a partial total.

In **Create → Clips**, choose **Quality**, **Economy**, or **Advanced**. Advanced offers searchable OpenRouter model pickers for transcription and clip planning, with model IDs, planning prices and compatibility notes. Both selections are required and appear in Review. Advanced retries the selected models without automatically switching models. Transcription must provide word timestamps; planning must support structured output. See [model selection and transcription](docs/transcription.md).

In **Create → Format → Video speed**, choose **1×** (normal), **1.1×**, **1.25×**, **1.5×**, **1.75×**, or **2×** for every clip in the job. Exports preserve voice pitch and keep captions synchronized. Speed works with **Cut dead air** and appears in Review and the saved results. Clip lengths and source trim times refer to the original footage: a 60-second clip at 1.5× exports in about 40 seconds, before any dead-air cuts. The choice stays selected when you clip another video in the same session. Existing exports stay as they are; generate a new job to change their speed.

## Download

**macOS** (Apple silicon and Intel): download BridgeClip from [bridgeclip.ai](https://www.bridgeclip.ai) or [Releases](https://github.com/bridge-mind/bridgeclip/releases), open the disk image and drag BridgeClip to Applications. The macOS builds are signed with BridgeMind's Developer ID and notarized by Apple.

**Windows x64**: download the [signed installer](https://github.com/bridge-mind/bridgeclip/releases/download/v0.1.19/BridgeClip-0.1.19-win-x64.exe) or use the Windows button on [bridgeclip.ai](https://www.bridgeclip.ai), then run the installer.

**Linux x64**: download the [AppImage](https://github.com/bridge-mind/bridgeclip/releases/download/v0.1.19/BridgeClip-0.1.19-linux-x64.AppImage) or [DEB package](https://github.com/bridge-mind/bridgeclip/releases/download/v0.1.19/BridgeClip-0.1.19-linux-x64.deb). Install the DEB with your package manager, or make the AppImage executable before opening it. An unlocked desktop secret service is required to save API keys.

Version 0.1.19 brings all platforms into one release. Every package bundles Python, FFmpeg and yt-dlp. See [release status and verification](docs/RELEASING.md).

BridgeClip keeps itself up to date. It checks [Releases](https://github.com/bridge-mind/bridgeclip/releases) shortly after launch and every four hours, downloads a new version in the background, and installs it when you choose **Restart to update** (in the sidebar or **Settings → About**) or the next time you quit. macOS only installs an update signed by the same developer, and every download is checked against the SHA-512 published with the release. Copies run from source, local package builds and apps opened straight from the disk image don't update themselves; **Settings → About** says why. To turn updates off, start BridgeClip with `BRIDGECLIP_DISABLE_AUTO_UPDATE=1`.

On first launch, paste your OpenRouter key into the setup card:

| Provider | Used for | Get a key |
| --- | --- | --- |
| OpenRouter | MAI Transcribe 2 transcription, clip selection, and optional Jev editorial review | [openrouter.ai](https://openrouter.ai/keys) |

Keys are encrypted with your operating system's secure storage. If secure storage is unavailable, BridgeClip asks you to configure or unlock it before saving keys.

### What leaves your computer

For a link, the app downloads the source using your network connection. Audio for MAI Transcribe 2 (Quality), Whisper Turbo (Economy), or your selected transcription model (Advanced) goes to OpenRouter. Transcription retries temporary failures and uses fallback models when needed; Economy tries Whisper Large V3 before MAI. Transcript text for clip planning also goes to OpenRouter. If the video has no audio or no speech, BridgeClip samples video frames and sends those images to OpenRouter for visual-only planning. Clips made through that fallback have no speech captions. Economy skips optional AI layout checks. If you connect social accounts, BridgeClip sends your Zernio API key to Zernio and receives account/profile metadata; platform sign-in occurs in your browser. When you choose **Post** or **Schedule**, BridgeClip uploads that clip to Zernio's media storage and sends its caption, selected accounts and publishing options to Zernio. Zernio then publishes to those platforms. Provider accounts, charges, retention and data policies are governed by those services.

**Jev editorial review (beta)** is off by default. Turn it on under **Settings → TypeSafe Jev**. It uses your existing OpenRouter key and extra OpenRouter credit; no separate TypeSafe key or account is required. When it is on, clip text (bounded transcript excerpts, titles and diagnostic text) goes through OpenRouter to TypeSafe Jev, and automatic clips need a successful review. Jev receives no audio, video, images, source description or web research. **Review & edit always uses Jev** to evaluate candidates, even when this setting is off. With review off, automatic clipping uses the planner’s proposed clips and cuts without Jev checks, repairs or editorial model calls. A provider failure while review is on does not bypass review: the run stops, and says so when Jev was unavailable or out of credit. Turn review off and re-run to clip without it. **Additional visual context** is a separate opt-in: sampled source frames go to OpenRouter and their descriptions can go to Jev. It adds provider cost, with at most eight context-vision requests per job and twelve frames per request. These limits are independent of ordinary framing vision.

**Source web research (beta)** is off by default. When you turn on **Research the source before clipping** in Settings, the video’s title, description and channel go to OpenRouter’s web search (up to two searches) for each YouTube or Twitch link, and a Gemini model writes a short brief for clip selection. It uses extra OpenRouter credit. Local files are never researched. With research off, BridgeClip makes no source-context request.

Downloads and intermediate media are held in a private `work/` directory under BridgeClip’s per-user application data folder. BridgeClip removes job work on completion, failure, and cancellation, and clears stale work when it next starts after a forced shutdown. A local video you selected stays where it was. Rendered clips, the transcript, plan and `job_output.json` remain in a run folder under your chosen **Output folder** (by default, `~/BridgeClip`). That JSON includes the source URL or local path and video title. New runs also save `source_context.json` (the source metadata, including its description, plus any research brief and citations) and `edit_audit.json` (the full transcript, planner and repair prompts and responses, and Jev judgments, probabilities and usage). **Review & edit** runs keep a copy of the source video, a playback preview and the project file there too. Review these files before sharing a run folder, and delete the run folder to remove those local outputs.

Settings, the last synced list of connected accounts (platforms, handles and Zernio IDs), local posting history, and upload retry records live in Electron's per-user application data folder. Posting history can include clip paths and titles, account handles, targets, status and links; retry records can include a clip path and an uploaded media URL. Changing or removing the Zernio key switches to a separate local post history and quarantines the old account and upload retry caches. Returning to the same key restores its saved post history; a newly rotated key has separate history. Quarantined copies remain on disk until a later cleanup after 30 days; to erase them immediately, quit the app and delete the `zernio-*.quarantine-*` files from its application data folder. Key changes do not delete media or posts already held by Zernio or a social platform. Diagnostic logs live in the per-user logs folder. Remove provider keys in Settings to clear their encrypted saved copies, and review logs before sharing them in an issue.

Only download or clip material you have permission to use. Remote sites may limit downloads or change their access rules.

### Clip a Twitch VOD

Paste a public, completed Twitch video link such as `https://www.twitch.tv/videos/1234567890` into Create, then choose your clip settings and generate. BridgeClip downloads the saved video and uses the same transcription, AI moment selection and rendering flow as other sources. Links on `twitch.tv`, `www.twitch.tv`, `m.twitch.tv` and `go.twitch.tv` are accepted and normalized to the canonical video URL.

Live channels, Twitch clips, collections, subscriber-only videos and deleted or expired VODs are not supported. No Twitch login or cookies are used. The original source must be at most six hours and 20 GB. BridgeClip downloads the full source before applying the optional start and end times; a link's timestamp or tracking parameters are ignored. For a longer source, trim a downloaded file before adding it. Downloads also stop after four hours or when less than 1 GB of free space would remain.

## Develop

Local macOS runs apply the BridgeClip Dock icon when the window appears and when the app is activated. Restart Electron after changing startup code; refreshing the renderer only updates the UI.

**Prerequisites:** Node.js 22, Python 3.12, and FFmpeg with the libass-backed `ass` filter for captions. The clipping engine, model, fonts, and locked Python dependencies are included in this repository. In development, BridgeClip uses FFmpeg from `engine-bin/` when it exists, then falls back to your `PATH`. Provider keys are needed for live jobs, not tests.

```bash
git clone https://github.com/bridge-mind/bridgeclip
cd bridgeclip
python3.12 -m venv engine/.venv
engine/.venv/bin/pip install --require-hashes -r engine/requirements.lock
npm ci
npm run dev
```

BridgeClip finds its in-repo engine and virtual environment automatically. **Settings → System check** shows the Python, yt-dlp, FFmpeg, and engine checks; set **Python path** in development if you use another interpreter.

On Linux, use system FFmpeg with the libass-backed `ass` filter (`ffmpeg -hide_banner -filters | grep -E '[[:space:]]ass[[:space:]]'`) and Python 3.12. Arch: `sudo pacman -S ffmpeg`. Skip `scripts/prepare-resources.sh` during development; it prepares macOS release resources. Linux development and tests are supported, but a self-contained Linux package is not yet available.

For experimental Windows development, install Python 3.12 and FFmpeg with the `ass` filter on `PATH`, then use PowerShell:

```powershell
python -m venv engine/.venv
engine/.venv/Scripts/python.exe -m pip install --require-hashes -r engine/requirements.lock
npm ci
npm run dev
```

The in-repo Windows virtual environment is detected automatically. Native Windows CI checks the engine, desktop modules, renderer, and production build. Tests that create file symlinks report a skip if Windows denies symlink creation; they run when the account has the required capability. Release-helper tests use Git Bash. The private release pipeline includes Windows installers; a real signed upgrade must pass acceptance before update support is claimed.

Private release workflows package the in-repo engine and media tools for macOS, Windows, and Linux. For local packaging, first run `bash scripts/prepare-resources.sh arm64` (or `x64` on Intel), then follow [the release guide](docs/RELEASING.md). Signing credentials are still required for a distributable build.

### First run and troubleshooting

1. Add your OpenRouter key in the setup card. A saved key is never shown again; paste a new one to replace it or choose **Remove key** in Settings.
2. Run **Settings → System check**. In development, set the Python path if your local virtual environment is not detected.
3. Choose a local video with the file picker or paste a public video link, select clip lengths, framing, and caption style, then start. Smart framing automatically follows faces and arranges screen shares with facecams shot by shot. The optional AI vision check improves ambiguous layouts and can add OpenRouter cost. Dropping a local file opens the picker so you can grant access. Completed runs appear in Library and in your output folder. During creation, each stage shows its own elapsed time and progress: downloaded bytes, transcription chunks, prepared candidates, rendered clips, saved files and editor-preview encoding where measurable. AI requests without measurable progress show an indeterminate bar. The overall percentage is an estimate; completed runs retain a **Processing time by stage** breakdown in the Library and editor. Each stage keeps its own color in the time breakdown. The progress page reuses the source preview from Create for YouTube and local files. New runs show live model requests, input/output tokens and provider-reported cost; missing usage stays unknown and partial totals exclude unreported charges. **Inside frame & review** separates face sampling, camera scans, detailed face tracking, shot-layout checks and Jev review, with the current candidate and accumulated timings. These diagnostics are saved with the run and remain available in its processing-time details. See [the framing performance investigation](docs/FRAMING_PERFORMANCE_2026-09-27.md) for the long-video decoding fix.

4. If a link fails, check it in a signed-out browser or download it yourself and select the local file. If a run fails, use the in-app error and System check first; logs intentionally omit raw provider responses and private source details.

To review or adjust a crop, choose **Review & edit** when creating clips. The editor shows source footage alongside the output framing, with controls for layouts, crops and camera changes.

### Review & edit

Choose **Review & edit** on Create’s first step to find candidates without rendering them. BridgeClip transcribes the source (researching it first if web research is on), proposes moments and suggests framing. It opens a saved editor project when discovery finishes. The automatic workflow remains available.

Reopening a Library item goes straight to the editor when it has unfinished candidates and no baked clips. Once there are baked clips, it opens their list with a prominent **Continue editing** button and a count of clips left to finish. When every candidate is baked or discarded, the list keeps a quieter **Open editor** button. The editor starts on an unfinished candidate, falling back to a baked one before any discarded candidates.

Library cards with unfinished candidates show a blue **Editing** badge, the number left to finish and a matching border, even if some clips are already baked. The indicator clears once every candidate is baked or discarded.

- Review every candidate’s **Jev** questions, probabilities, thresholds and criteria, including candidates that need attention. Nothing is discarded or repaired automatically in this workflow. Disabled, unavailable or incomplete reviews are shown as unrated, never as passes.
- Watch the source beside the output framing. Drag trim handles or enter timecodes, split at the playhead and remove unwanted sections. **Play cuts only** previews the retained sequence; turn it off to inspect surrounding context. The **Transcript** tab follows the active caption during playback; pause to browse freely. Creating a new layout pauses and selects it for editing. Space plays/pauses after dragging frames, selecting a layout marker or adjusting a framing slider; holding Space toggles only once. **Review speed** beside the playback controls offers 1×, 1.5×, 2× and 3× preview playback, relative to the clip’s export speed. Press **1**, **2** or **3** to switch directly to 1×, 2× or 3× while reviewing; shortcuts leave typing in fields alone. It stays selected while switching candidates and does not change saved edits or exports. I/O sets the outer trim, S splits, and arrow keys step 1/2/3 source frames at 1×/2×/3× review speed (1.5× rounds to two frames). Shift+arrows jump one second; the dedicated frame buttons always move one frame.
- Choose **Full frame**, **Split** or **Fit**. Drag inside a crop rectangle to move it, or drag any corner to resize it with the opposite corner anchored. Corners preserve the crop’s proportions and stay within the source; split layouts have independent handles for each panel. Arrow keys adjust a focused corner (Shift for larger steps). Position and zoom controls remain available. Add a layout change at the playhead to reframe another section, or apply one layout to the whole clip. Edit **Layout starts** or drag its diamond on the timeline to move an existing change; arrow keys nudge a focused diamond by one source frame after a camera scan (before scanning: 0.1 seconds; Shift: 1 second). Changes stay between their neighbours, with undo and autosave support. Enable **Smooth movement** on a new layout to ease from the preceding crop, including zoom, in both preview and export. Adjust its duration from 0.1–5 seconds of source time. Movement works between matching Full frame or Split layouts; changes between layout types use a cut.
- Use **Replace source video** to switch to a higher-quality copy of the exact same video. Keep content, timing, audio and framing identical; the editor warns before replacing and rejects incompatible duration or aspect ratio. Cuts, crops and caption edits are preserved, baked candidates become ready to render again, and earlier exports remain in Library.
- Use the scan icon in the timeline toolbar to open **Find camera changes** (or **Rescan camera changes**). The popup explains the scan and lets you choose sensitivity before selecting **Scan clip** to inspect every frame of the selected clip locally. Amber camera markers are suggestions: select one to **Insert layout at cut**, **Align nearest layout**, or **Remove camera marker**. Click elsewhere to deselect the marker and hide its actions. Choose **More sensitive** in the scan popup to reveal weaker cuts; motion and flashes can also produce suggestions. Removed markers stay hidden across restarts; use **Restore removed markers** in the scan popup to bring them back. Removing a marker keeps your layouts and cuts. After scanning, arrow keys and the previous/next-frame buttons use actual source frame timestamps, including variable frame rates. Layout drags snap to source frames and nearby visible camera markers; **One frame earlier/later** and **Timeline zoom → Playhead** help fine-tune boundaries. Older projects get a frame-preserving preview on their first scan. Outside the scanned footage, arrows and frame buttons keep moving in approximate 1/30-second steps, so you can always move back from either edge. Rescan after extending beyond the scanned footage for precise stepping; replacing the source clears scan results. A manual scan does not change layouts or Ready/Baked status. New Smart framing runs also scan during the pipeline: strong cuts and sustained face-composition changes refine automatic boundaries to source frames, while weaker markers remain available for review. Extra face checks are bounded to 160 likely changes and 6,000 frames per clip. Optional AI layout checks are limited to the first 12 image decisions per clip, with cached decisions reusable afterward; camera scanning itself makes no AI requests. If detailed scanning cannot complete, the sampled framing pass remains available.
- Clicking a timeline position or a retained cut keeps the video playing from that position; if paused, it stays paused. Drag either edge of a timeline section to trim or extend it. **Timeline zoom**, below the timeline on the right, combines **Full source** for larger adjustments, **Clip** for the current clip with surrounding context, and **Playhead** for a close-up of one second on either side of the current position. Turn off **Play cuts only**, watch beyond the current selection, then choose **Extend to playhead** to extend its ending (or its beginning when the playhead is before the clip). Adjacent cuts and the source’s bounds limit each edge; edits support undo and redo.
- Re-run Jev after editing. The previous review is marked out of date after changes to the title, cuts or framing. Internal removals receive their own safety and join questions. These reviews advise you; you decide when a clip is ready, including when a review raises concerns. Jev continues to review the source dialogue and your cuts; caption corrections do not rewrite that evidence.
- Clips start in **Refining**. **Discard** sets one aside in a collapsible group; **Restore clip** brings it back. Choose **Mark ready** when satisfied, then **Bake captions** (or **Render clip** with captions off). A successful render moves the candidate to **Baked**. Further changes return it to Refining. Discarding a candidate never deletes earlier exports.
- The right-hand tab stays selected when you switch candidates. In **Transcript**, a steady **Captions go here** sample shows subtitle placement over the output video in the selected style. Drag them up or down, use the vertical position slider, or choose Top, Middle or Bottom; the saved position applies throughout this clip when baked. **Automatic** restores layout-based placement. The sample stays visible while playing or seeking, including gaps and caption-free sections, so you can adjust placement without following spoken words. It is a placement guide; baked captions still use your transcript and actual speech timing.
- Click a pencil in **Transcript** to correct a line while reviewing. Corrections autosave for this candidate only, support undo, and appear in its final video. **Reset text** restores the source line; clearing a line hides its caption without removing audio. Corrections keep word timestamps when the word count matches; otherwise new words are spread over that line’s spoken interval.
- Use the arrow beside **Bake captions** to choose **Bake all ready clips**. It renders every Ready clip in the current editor in order, using each clip’s caption settings and suppressed sections. Progress shows completed clips; cancelling or a failure keeps completed exports and leaves the remaining clips Ready.
- In **Captions**, use **Suppress captions here** for footage with baked-in source captions. **Add another section** creates additional ranges, even when the playhead is inside an existing one. Adjust each caption-free section’s start/end time or set them from the playhead. Amber timeline bars mark these sections. Suppression autosaves per candidate, supports undo/redo, and follows the source through trims, removed sections and speed changes. It hides only BridgeClip’s captions; source captions and audio remain. Remove a range to restore our captions there.
- Select a caption style and playback speed before baking. Captions are timed to the retained footage and baked into the final video; the live output preview shows framing; caption text can be reviewed and edited in **Transcript**. Each export becomes a new Library clip, preserving earlier exports. Titles are clip metadata, not automatic title-card overlays.

Edits autosave and reopen from Jobs or Library. Review projects retain an independent full-resolution source copy, a smaller playback preview, the transcript and the project file in the run folder. These need additional disk space and remain until the Library item is deleted. Existing automatic runs remain inspectable; start a new Review & edit run to create an editable project. Rendering is local; discovery and **Review again** use the configured providers and can incur API costs.

**Before transcription**, if you turned on **Research the source before clipping** (beta, off by default), Gemini 3.8 Flash builds a brief from the video title, description, channel and upload date. It researches each YouTube or Twitch source with up to two searches and four cited sources through OpenRouter. It separates a channel overview from the likely format of this video (reaction, interview, tutorial, etc.), suggests what to look for, and records uncertainties. With research off, no brief is made and no request is sent. Local files are not searched. Research failures fall back to metadata; they never fabricate citations or block transcription. This adds provider time and cost.

The brief accompanies discovery and boundary repairs; Jev never receives it. The planner must confirm or revise its assumptions against the transcript; background research cannot supply missing speech, setup or payoff. Only terms already present in the metadata can become transcription hints, and your custom vocabulary takes priority. This stage researches public metadata and web sources; it does not claim to watch an entire YouTube video through Gemini.

The pipeline transcribes the **entire source**, even when you select a preferred range. That range and the selected clip durations guide discovery; they are not hard cut boundaries. Quality uses GPT-6 Sol to propose complete ideas and repair their boundaries, extending earlier or later to include setup, qualifications and payoff. Economy uses GLM 5.3 Flash planning and Gemini 3.8 Flash repairs. This can increase transcription cost compared with transcribing only a selected range.

With Jev review turned on (beta, off by default), the automatic workflow reviews each clip independently. The default minimum probabilities are: standalone meaning and title support must reach 70%; faithfulness must reach 65%; opening context, ending and logical flow must each reach 75%; probability that the segment is not sponsored must reach 80%; and sufficient evidence must reach 50%. Every actual internal removal needs 0.95 approval for safety and a logical join. Uncertain removals are restored, then the complete edited sequence is checked again before rendering. Changed timing in a rendering fallback requires approval too. Discovery records a topic and source-anchored setup/payoff for each candidate and preserves speaker turns through review. Rejected candidates may trigger one additional search of underexplored sections (up to eight new candidates); overlapping alternatives are selected after approval. Repairs must cite an actual source passage to explain the proposed change. There are at most two boundary repairs per candidate and eight per run; unavailable or inconclusive review omits the candidate. The second search stays inside your preferred range. Temporary provider errors are retried up to twice. A run may produce fewer clips or none. These thresholds can be adjusted under **Settings → TypeSafe Jev** and are saved with each review. They are acceptance rules over probabilistic model judgments, not a guarantee of semantic correctness. With Jev enabled, clips without a usable speech transcript cannot pass. When Jev is off for automatic clipping, review is marked as skipped in the run details; the final retained source intervals are still recorded. Saved thresholds also apply to Review & edit, which always uses Jev.

Use **Inspect transcript & edits** in a clip list, or **Details** in a Jobs row’s three-dot menu. The compact Details popup keeps its header and navigation visible while you browse **Jev review**, **Transcript** and **Run details**. Jev review shows the actual questions, probabilities and per-check pass/fail thresholds for each saved evaluation, with expandable criteria and input evidence. Transcript shows searchable passages, original and repaired boundaries, retained/omitted speech and repair decisions. Run details contains the source context and planner requests. Saved JSON throughout the review screens uses a color-coded, expandable viewer that also formats JSON stored inside strings. Long responses load more text or entries on demand; **Original** preserves the saved values and offers **Select all** for copying. Reopening makes no AI calls. New runs show a **Source context** section with the channel overview, likely format, research sources and uncertainties. They save `source_context.json` before transcription and include it in `edit_audit.json`; older runs can show their transcript but cannot reconstruct missing decisions. These files contain source text: review them before sharing. Editorial scores and semantic duplicate comparisons remain advisory; **Editorial** sorting reweights saved scores locally.

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
| `npm run icons` | Export app icons from the imagegen master `resources/bridgeclip-icon.png` (macOS; see `scripts/icon/README.md`) |

### Project layout

```
src/main/        Electron main process: settings, pipeline runner, IPC, optional Zernio posting
src/preload/     The typed window.bridgeclip API exposed to the renderer
src/renderer/    React UI (Create, Library, Jobs, Accounts, Posts, Automations, Settings)
src/shared/      Product constants shared by main and renderer
bridge/          Python worker protocol and network guard
engine/          BridgeClip clipping engine, assets, locked Python dependencies, and tests
scripts/icon/    Icon and logo generators
```

The visual system (tokens, components and rules) is documented in [DESIGN.md](DESIGN.md).
The desktop trust boundaries and bridge protocol are described in [Architecture](docs/ARCHITECTURE.md).
The [open-source readiness checklist](docs/OPEN_SOURCE_READINESS.md) tracks the remaining release gates and maintenance priorities.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, review expectations and checks. Security reports should follow [SECURITY.md](SECURITY.md), not a public issue. The community guidelines are in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © BridgeMind
