# Using BridgeClip

[Overview](../README.md) · [Editor](editor.md) · [AI and privacy](ai-and-privacy.md)

Install BridgeClip, create clips, follow jobs, and manage your Library and publishing queues. These instructions describe the current source; check the [release notes](https://github.com/bridge-mind/bridgeclip/releases) for the features in your installed version.

## Install and update

Choose your platform on [bridgeclip.ai](https://www.bridgeclip.ai) or [GitHub Releases](https://github.com/bridge-mind/bridgeclip/releases). Packages include Python, FFmpeg and yt-dlp.

- **macOS (Apple silicon or Intel):** open the matching DMG and drag BridgeClip to Applications. Official builds are Developer ID signed and notarized by Apple.
- **Windows x64:** run the signed EXE installer.
- **Linux x64:** install the DEB with your package manager, or make the AppImage executable before opening it. An unlocked desktop secret service is required to save API keys.

See [release verification](RELEASING.md#verify-a-download) for signatures and checksums.

### Automatic updates

BridgeClip keeps itself up to date. It checks [Releases](https://github.com/bridge-mind/bridgeclip/releases) shortly after launch and every four hours, downloads a new version in the background, and installs it when you choose **Restart to update** (in the sidebar or **Settings → About**) or the next time you quit. macOS only installs an update signed by the same developer, and every download is checked against the SHA-512 published with the release.

Copies run from source, local package builds and apps opened straight from the disk image don't update themselves; **Settings → About** says why. To turn updates off, start BridgeClip with `BRIDGECLIP_DISABLE_AUTO_UPDATE=1`.

## Create your first clips

1. Add an [OpenRouter API key](https://openrouter.ai/keys) with available credit in the setup card. A saved key is never shown again; paste a new one to replace it, or choose **Remove key** in Settings.
2. Open **Create** and use the file picker for a local video, or paste a public YouTube or completed Twitch VOD link. Dropping a local file opens the picker so you can grant access.
3. Choose **Automatic** for finished exports, or **Review & edit** to adjust candidates in the [editor](editor.md).
4. Choose format, framing, clip lengths, models and caption style, then generate.
5. Follow progress in **Jobs**. Finished clips appear in **Library** and your output folder (by default, `~/BridgeClip`).

Keys are encrypted with your operating system's secure storage. If secure storage is unavailable, BridgeClip asks you to configure or unlock it before saving keys.

Only download or clip material you have permission to use. Remote sites may limit downloads or change access rules.

### Choose a workflow

In **Create**, choose a workflow before continuing: **Automatic · Beginner friendly** finds and exports clips; **Review & edit · For advanced users** lets you choose and adjust candidates before export. Each new video starts with neither workflow selected. YouTube links show a video card with its title, channel and thumbnail, plus duration, views and upload date when available. Metadata loads in the background and never blocks clip setup.

**Review & edit** always uses Jev candidate reviews. For Automatic, Jev review is off by default. Reviews use OpenRouter credit; see [review behavior and costs](ai-and-privacy.md#jev-editorial-review).

### Models

In **Create → Clips**, choose **Quality**, **Economy**, or **Advanced**. Advanced offers searchable OpenRouter model pickers for transcription and clip planning, with model IDs, planning prices and compatibility notes. Both selections are required and appear in Review. Quality finds moments with Claude Opus 5.5, with Gemini 3.8 Flash and GPT-6 Sol as fallbacks; Economy uses GLM 5.3 Flash. GPT-6 Sol also handles Quality boundary repairs when automatic Jev review is enabled. Advanced retries the selected models without automatically switching models. Transcription must provide word timestamps; planning must support structured output. See [model selection and transcription](transcription.md).

### Framing, captions and speed

Smart framing follows faces and arranges screen shares with facecams shot by shot. Optional AI vision checks help with ambiguous layouts and can add OpenRouter cost. Use [Review & edit](editor.md) to adjust crops and camera changes before exporting.

Choose from 13 default caption styles: Pop, Spotlight, Impact, Glow, Boxed, Sweep, Editorial, Hype, Punch, Neon, Headline, Paper and Subtle. In **Create → Captions**, the selected style plays an animated sample showing how words appear and highlights advance. Pause or restart it to compare styles.

In **Create → Format → Video speed**, choose **1×** (normal), **1.1×**, **1.25×**, **1.5×**, **1.75×**, or **2×** for every clip in the job. Exports preserve voice pitch and keep captions synchronized. Speed works with **Cut dead air** and appears in Review and the saved results. Clip lengths and source trim times refer to the original footage: a 60-second clip at 1.5× exports in about 40 seconds, before any dead-air cuts. The choice stays selected when you clip another video in the same session.

Existing exports stay as they are; generate a new job to change their speed.

See [video speed](video-speed.md) for timing and export details.

### Make a caption style

Open **Captions** in the sidebar or **Open captions lab** in Create’s Captions step. Your first preset starts with **Choose a base**: select a default, preview it, then choose **Customize**. Adjust its typeface, font size, text and highlight colors, word grouping, animation, outline, pill, glow or background. Enabling **Background** reveals separate **Horizontal padding** and **Vertical padding** sliders, plus opacity. New presets start with 24 horizontal padding. Both axes also apply to exports; existing presets keep their saved padding on each axis. Under **Sample text**, switch between **Short** and **Long** voice samples. Select a line to jump to that part of the recording; the line list updates with your caption settings. Pause or scrub the preview to compare timing. Previews start muted. Use the speaker button to hear the sample; your sound and sample choices carry across styles while the app is open.

Give it a name and choose **Save preset** to save without leaving the editor. **Back to presets** opens **Your presets** as cards matching the default styles, three per row, with edit, duplicate and delete in each card’s **…** menu; future visits start there. Select a saved preset card to preview it without editing. The preview stays in the left column when you choose **Edit preset**; on compact windows it stays above the controls. **New preset** starts the base-selection wizard again. Leaving unsaved caption edits offers **Save & leave**, **Discard**, or **Keep editing**. Reloading or closing the app also asks whether to save. When opened from Create, **Save & use** returns to the same draft with the preset selected, or select a card and choose **Use preset** below the preview. Default styles and **Your styles** are separate in caption pickers. Each job and editor clip keeps its own style snapshot, so later library edits and deletions do not change an existing clip. A custom style can also be selected in the editor before baking.

Default presets also appear below your saved cards. Select one to preview it, choose **Customize** to start a new preset, or **Use preset** to return it to Create. The initial base-selection wizard remains available when you have no custom presets.

Use the bookmark beside a custom preset or on any default tile to add it to **Favorites**. Bookmarks stay saved on this device across app launches and move smoothly to the front of each group, with reduced-motion preferences respected. In Create and the clip editor, switch from **All** to **Favorites** to show only your bookmarks; default and custom styles remain separate. New clip setups select the first available bookmark in picker order (defaults, then custom styles), or Pop if none are available. Once selected, bookmarking or filtering does not change the draft's caption style. Renaming a preset keeps its bookmark, and deleting it removes the bookmark.

On the Captions page, previews open paused with sample text visible, including when switching styles or opening an editor. Press **Play** to start playback. Turning sound on does not start a paused preview.

**Clean switch** changes the active word’s color instantly. **Color fade** and **Pop & fade** deliberately blend colors in both the preview and exported captions; short word events switch instantly to match the export.

Saved presets are independent copies of their starting default. Changing or retiring a default does not change your preset’s appearance or prevent you from editing, duplicating or exporting it.

**Words at once** controls the size of each caption group. **Lines** lets you choose Auto, 1, 2 or 3 lines. A number balances each group across that many rows, using fewer rows only when there are fewer words. Groups advance sooner when needed to fit the video width, keeping your font size and every spoken word. The layout applies to previews and exported clips. Existing presets keep Auto wrapping.

### Review before generating

Review reuses the video preview and groups format, pace, clip lengths, caption styling and models into editable cards. Use each card’s pencil to return to that step. **Review & edit** keeps manual cuts and has no title overlay; Automatic applies the selected pacing and title options. Clip lengths describe source footage, before playback speed changes.

### Clip a Twitch VOD

Paste a public, completed Twitch video link such as `https://www.twitch.tv/videos/1234567890` into Create, then choose your clip settings and generate. BridgeClip downloads the saved video and uses the same transcription, AI moment selection and rendering flow as other sources. Links on `twitch.tv`, `www.twitch.tv`, `m.twitch.tv` and `go.twitch.tv` are accepted and normalized to the canonical video URL.

Live channels, Twitch clips, collections, subscriber-only videos and deleted or expired VODs are not supported. No Twitch login or cookies are used. The original source must be at most six hours and 20 GB. BridgeClip downloads the full source before applying the optional start and end times; a link's timestamp or tracking parameters are ignored. For a longer source, trim a downloaded file before adding it. Downloads also stop after four hours or when less than 1 GB of free space would remain.

## Follow jobs

Every run gets its own folder. The **Library** shows completed clips with virality scores, timecodes and tags. **Jobs** shows what is running or queued right now (up to two clipping runs go at once; more wait in a queue) and every earlier run, including completed, failed, cancelled and interrupted jobs; completed runs open directly in Library, and failed runs from this session can run again.

**Previous** starts at ten runs per page. Use the page-size selector to choose 10, 25, 50 or 100; the app remembers your choice across navigation and restarts. Changing the count, search or filters returns to the first page. Search and filters apply across the full history; **Active** always shows every running and queued job. Page transitions respect reduced-motion preferences.

Each previous job has a three-dot menu for **Open in Library** (or **Open job** for session jobs), **Open folder** and **Details**. Details opens the saved transcript and edit trace, including for failed runs. Older runs without a saved status appear as unfinished. You can optionally connect social accounts through Zernio to publish or schedule a selected clip.

### Progress and cost

During creation, each stage shows its own elapsed time and progress: downloaded bytes, transcription chunks, prepared candidates, rendered clips, saved files and editor-preview encoding where measurable. AI requests without measurable progress show an indeterminate bar. The overall percentage is an estimate; completed runs retain their timings under **… → Processing details** in the Library and **Processing time by stage** in the editor. Each stage keeps its own color in the time breakdown. The progress page reuses the source preview from Create for YouTube and local files.

New runs show live model requests, input/output tokens and provider-reported cost; missing usage stays unknown and partial totals exclude unreported charges. **Inside frame & review** separates face sampling, camera scans, detailed face tracking, shot-layout checks and Jev review, with the current candidate and accumulated timings. These diagnostics are saved with the run and remain available in its processing-time details. See [the framing performance investigation](FRAMING_PERFORMANCE_2026-09-27.md) for the long-video decoding fix.

## Organize your Library

### Find clips and track posting

Inside a Library run, the source card shows the original video's thumbnail, saved title, channel and duration when available. A compact 2×2 grid beside it shows clip count, processing time, API cost and creation date; the two panels share the row equally and stack in smaller windows. **View on YouTube** opens the original video. **Continue editing** stays visible for unfinished review projects. The header's **…** menu contains **Transcript & edits**, **Processing details**, **Open folder** and **Refresh post status**. Processing details includes recorded stage timings and model usage.

The clip toolbar keeps **Search clips**, selection and sorting together. Search filters by title, tag or clip number across both posted and unposted clips; bulk actions appear when clips are selected. **Not Posted** and **Posted** are independently collapsible sections with clip counts. **Not Posted** opens by default and appears first; **Posted** starts collapsed below it. Selection applies only to visible results and expanded sections. Editorial ranking weights appear only when sorting by **Editorial**.

Badges distinguish scheduled, publishing, partially posted and failed posts using this workspace’s saved posting history.

### Clip actions and publishing drafts

Each clip’s **…** menu contains posting, adding to an automation, opening its folder, and **Delete clip**. Delete a single clip directly from this menu without selecting it first; the confirmation names the clip before permanently removing its local export. Choose **Mark as posted** for clips you published yourself; the mark persists without a connected account and can be undone from the same menu. It changes local Library status only.

Select clips to reveal the red trash button for deleting just those exports, with confirmation; source footage, editor edits and other clips are preserved. The post dialog can enhance platform-specific titles, captions and tags using the same transcript, source context and optional research as Automations; review and apply the draft before posting.

### Bookmarks and run deletion

Library overview cards show the total clip count at the top left, the run's local file size beside its date and cost, and separate **Posted** / **Not Posted** counts below the title. Sizes include all files in the run folder and update when you refresh the Library; **≥** marks an incomplete total. Bookmark a run to keep it in the **Bookmarked** section. Cards move smoothly between Bookmarked and Recent runs without reloading their thumbnails; removing the last bookmark returns to one **All runs** grid. Bookmarks persist across restarts, and reduced-motion preferences turn off movement.

The trash action shows estimated space freed and a visual summary before permanently deleting the run folder, all clips and other files inside it, and cached clip previews. The estimate counts the run's files, including saved edits and source copies; incomplete scans are marked. Published social posts and copies stored elsewhere are kept. Expand **Folder location** to check the exact folder. Active runs cannot be deleted.

**Settings → About → Content storage** shows the total file size and file count in your output folder. Refresh to recalculate; inaccessible files are reported as a partial total.

**Clean published content** opens a space estimate and a selectable list of projects. It uses the Library’s posted status, including clips you manually marked as posted. Fully published, finished projects can have their entire local folder removed, including source copies and edits. Mixed projects lose only the posted exports you reviewed; unposted clips and unfinished edits stay. Clips needed by pending posts or automations are kept, and cleanup waits for uploads to finish. Online posts and automation bank copies are not deleted.

If you have retained **Review & edit** media, a **Source files** section shows source-video size, editor-preview size and how much is ready to free. **Review sources** lists the projects; only those with every candidate baked or discarded can be selected. Freeing this media keeps exported clips but makes the project read-only, so you cannot refine or bake it again. Automatic-only libraries do not show these editor controls.

Both actions permanently delete only the local content selected in the confirmation. Projects changed since the preview are kept for a fresh review, and partial failures are reported. No cleanup runs automatically.

## Publish and automate

Connect social accounts with your own Zernio account and API key to post or schedule clips. Metadata enhancement uses your OpenRouter key. For platform-specific drafts, scheduling consent and required TikTok reviews, see [publishing and metadata](automation-metadata.md). **BridgeClip must be open for daily automations to run.**

### Browse posts

**Posts** is your publishing activity feed. Use **×** to dismiss an update without changing the clip’s **Posted** status in the Library or its eligibility for **Clean published content**. Published posts and local videos stay intact. Dismissed partial or inbox deliveries keep their existing status and cleanup protections; dismissing them does not complete publication. Scheduled and publishing posts stay visible until they finish or are cancelled.

**Posts → Recent** uses numbered pages. Choose 10, 25, 50 or 100 rows per page; the choice is shared with Jobs and remembered after restarting. **Scheduled** and **Needs attention** remain visible above Recent on every page.

Posting records are kept separately when activity is dismissed or older updates leave the feed, including across app restarts. They remain scoped to the connected Zernio workspace. Activity removed before this change cannot be recovered automatically; mark a clip as posted in the Library if its record is already gone.

### Organize the content bank

In **Automations**, drag a queued clip’s handle to change its order with animated movement and automatic scrolling. For keyboard sorting, focus the handle, press Space to pick up the clip, use the Up/Down arrow keys, then press Space to drop or Escape to cancel. Submitted or uncertain items stay in place. The bank separates **Queued**, **Needs attention** (when needed), and **Submitted** clips. The Queued heading shows the next posting slot and its timezone, or indicates that scheduling is paused or unconfigured. Hover or focus each row’s info icon for its added/submitted timestamps, source, caption and metadata status.

Use the actions menu to edit a bank item, **Show in Finder** (**Show in folder** on other systems) to reveal its saved video, or **Remove from queue**, and **View in Library** to open its source run filtered to that exact clip, including submitted clips and items with enhanced titles. Choose **Show all clips** to return to the full run. Submitted clips have no removal option. Removing a queued clip leaves the original file intact.

Reviewed metadata is marked **Enhanced** in the info tooltip and hides the Enhance button; selecting a platform that still needs metadata makes enhancement available again.

**Enhance by source video** works with both linked videos and attached files. Select a source and optionally describe the video or suggest an emphasis for its titles, captions and tags. Review the generated draft before applying it.

### Warnings and recovery

In **Automations**, the header shows scheduling status once. **More settings** holds caption writing, YouTube options and the automation name; previous failures are expandable historical messages. Use **Acknowledge warnings** for one automation or **Acknowledge all warnings** for every automation to clear existing failure indicators without a successful post. Acknowledgements survive restarts; new failures warn again. Messages remain in the run details or clip info, and acknowledged clips awaiting review appear under **Held clips** without being retried or returned to the queue.

Dismiss a clip’s upload or metadata error with its **×** button; dismissal survives restarts, preserves the message in clip info, and a new failure shows the warning again. **Run now** prioritizes ready clips without previous upload errors. Use **Retry clip** to retry a specific failed upload without changing queue order, even after dismissing its error. Retry is available only for queued clips that have not been submitted; metadata drafts and required TikTok review must be resolved first.

Held clips have a visible **Return to queue** action and, when linked to a Zernio post, **Refresh post status**. A fresh Zernio check moves already published or active posts to **Submitted** and permits requeuing only fully failed posts; partial or uncertain results stay held for review in Posts. Returning a failed linked clip disables Retry on its old Posts entry so only the new queue attempt can post.

Recovery also works when local post history was removed or aged out, provided Zernio returns complete post details. Returning an unlinked clip requires confirming it was not published. Required setup and TikTok approvals still apply.

### Check account health

**Check Zernio status** makes a fresh, read-only account health request and shows connection/permission issues without uploading or posting. Zernio’s documented health API does not expose its protective upload cooldown, so the result explicitly leaves that hold unconfirmed even when the connection is healthy. Failed checks never fall back to cached success.

## Troubleshoot a run

- Run **Settings → System check** and use the in-app error to identify missing dependencies or provider issues. In development, set **Python path** if the virtual environment is not detected.
- If a link fails, check it in a signed-out browser or download the video yourself and select the local file.
- Open a job’s **Details** to inspect its saved transcript and edit trace, including failed runs. Inspecting saved results makes no provider calls. See [saved reviews and diagnostics](ai-and-privacy.md#inspect-saved-reviews).
- Logs omit raw provider responses and private source details, but review logs and run files before sharing them. See [local storage and cleanup](ai-and-privacy.md#local-storage-and-cleanup).

### Report an app crash

After an app or interface error, open **Settings → About → Crash reports → View report**. Choose **Copy issue report**, open GitHub, and paste it into a new issue with your steps to reproduce. **Help → Copy Latest Crash Report** also works when the interface is unavailable. Nothing is sent automatically.

The latest report includes app and system versions, safe error details and recent event names. If the app stopped without a clean shutdown, the next launch can record an **Unexpected shutdown**; forced quits and power loss can also cause this, and no crash stack is available for that event. Reports are local diagnostics, not full native crash dumps.

For help, use [GitHub Issues](https://github.com/bridge-mind/bridgeclip/issues) or [Discord](https://www.bridgemind.ai/discord). Report security issues using [SECURITY.md](../SECURITY.md).
