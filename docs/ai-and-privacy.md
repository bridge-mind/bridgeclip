# AI, costs and privacy

[Overview](../README.md) · [User guide](usage.md) · [Editor](editor.md)

BridgeClip renders on your computer and calls providers directly with your keys. It has no BridgeMind account or backend. AI transcription, planning and optional review use paid OpenRouter services; social publishing uses Zernio. Provider accounts, charges, retention and data policies are governed by those services.

## What leaves your computer

| Action | Data sent | Destination |
| --- | --- | --- |
| Transcription and planning | Source audio and transcript text | OpenRouter |
| Visual-only planning or enabled AI framing checks | Sampled source frames | OpenRouter |
| Jev review | Bounded transcript excerpts, titles and diagnostic text | TypeSafe Jev through OpenRouter |
| Optional source research | Public video title, description and channel | OpenRouter web search and brief generation |
| Social publishing | Selected clip, caption, accounts and publishing options | Zernio and the selected platforms |

For a link, the app downloads the source using your network connection. Audio for MAI Transcribe 2 (Quality), Whisper Turbo (Economy), or your selected transcription model (Advanced) goes to OpenRouter. Quality and Economy retry temporary transcription failures and use fallback models when needed; Economy tries Whisper Large V3 before MAI. Advanced retries only your chosen model. Transcript text for clip planning also goes to OpenRouter.

If the video has no audio or no speech, BridgeClip samples video frames and sends those images to OpenRouter for visual-only planning. In Advanced, the selected planner must support image input for this fallback.

Clips made through that fallback have no speech captions. Economy skips optional AI layout checks. If you connect social accounts, BridgeClip sends your Zernio API key to Zernio and receives account/profile metadata; platform sign-in occurs in your browser. When you choose **Post** or **Schedule**, BridgeClip uploads that clip to Zernio's media storage and sends its caption, selected accounts and publishing options to Zernio. Zernio then publishes to those platforms. Provider accounts, charges, retention and data policies are governed by those services.

## Jev editorial review

**Jev editorial review (beta)** is off by default. Turn it on under **Settings → TypeSafe Jev**. It uses your existing OpenRouter key and extra OpenRouter credit; no separate TypeSafe key or account is required. When it is on, clip text (bounded transcript excerpts, titles and diagnostic text) goes through OpenRouter to TypeSafe Jev, and automatic clips need a successful review. Jev receives no audio, video, images, source description or web research.

**Review & edit always uses Jev** to evaluate candidates, even when this setting is off. With review off, automatic clipping uses the planner’s proposed clips and cuts without Jev checks, repairs or editorial model calls. A provider failure while review is on does not bypass review: the run stops, and says so when Jev was unavailable or out of credit. Turn review off and re-run to clip without it.

**Additional visual context** is a separate opt-in: sampled source frames go to OpenRouter and their descriptions can go to Jev. It adds provider cost, with at most eight context-vision requests per job and twelve frames per request. These limits are independent of ordinary framing vision.

### Automatic review rules

With Jev review turned on, the automatic workflow reviews each clip independently. Default minimum probabilities are:

| Check | Minimum |
| --- | --- |
| Standalone meaning and title support | 70% each |
| Faithfulness to the source | 65% |
| Opening context, ending and logical flow | 75% each |
| Not a sponsored segment | 80% |
| Sufficient evidence | 50% |
| Safety and logical join for an internal removal | 95% each |

Uncertain removals are restored, then the complete edited sequence is checked again before rendering.

Changed timing in a rendering fallback requires approval too. Discovery records a topic and source-anchored setup/payoff for each candidate and preserves speaker turns through review. Rejected candidates may trigger one additional search of underexplored sections (up to eight new candidates); overlapping alternatives are selected after approval. Repairs must cite an actual source passage to explain the proposed change. There are at most two boundary repairs per candidate and eight per run; unavailable or inconclusive review omits the candidate.

The second search stays inside your preferred range. Temporary provider errors are retried up to twice. A run may produce fewer clips or none. These thresholds can be adjusted under **Settings → TypeSafe Jev** and are saved with each review. They are acceptance rules over probabilistic model judgments, not a guarantee of semantic correctness. With Jev enabled, clips without a usable speech transcript cannot pass.

When Jev is off for automatic clipping, review is marked as skipped in the run details; the final retained source intervals are still recorded. Saved thresholds also apply to Review & edit, which always uses Jev.

## Source web research

**Source web research (beta)** is off by default. Enable **Research the source before clipping** in Settings to send a YouTube or Twitch video's title, description and channel to OpenRouter's web search before transcription. Gemini 3.8 Flash builds a brief using that metadata, the upload date and up to two searches with four cited sources. This adds provider time and cost.

The brief separates a channel overview from the likely format of this video (reaction, interview, tutorial, etc.), suggests what to look for, and records uncertainties. Research failures fall back to metadata; they never fabricate citations or block transcription. Local files are not searched. With research off, no brief is made and no source-context request is sent.

The brief accompanies discovery and boundary repairs; Jev never receives it. The planner must confirm or revise its assumptions against the transcript; background research cannot supply missing speech, setup or payoff. Only terms already present in the metadata can become transcription hints, and your custom vocabulary takes priority. This stage researches public metadata and web sources; it does not claim to watch an entire YouTube video through Gemini.

## Planning and provider costs

The pipeline transcribes the **entire source**, even when you select a preferred range. That range and the selected clip durations guide discovery; they are not hard cut boundaries. The planner proposes complete ideas, and editorial repairs can extend boundaries to include setup, qualifications and payoff when Jev review is enabled. Model presets and fallback behavior are documented in the [transcription guide](transcription.md). This can increase transcription cost compared with transcribing only a selected range.

OpenRouter billing is authoritative. In-app totals can be partial when providers omit usage or a request times out. See [model selection and transcription](transcription.md) for current presets, compatibility, retries and fallbacks, and [job diagnostics](usage.md#progress-and-cost) for per-stage usage.

## Local storage and cleanup

### Output and working files

Downloads and intermediate media are held in a private `work/` directory under BridgeClip’s per-user application data folder. BridgeClip removes job work on completion, failure, and cancellation, and clears stale work when it next starts after a forced shutdown. A local video you selected stays where it was. Rendered clips, the transcript, plan and `job_output.json` remain in a run folder under your chosen **Output folder** (by default, `~/BridgeClip`). That JSON includes the source URL or local path and video title.

New runs also save `source_context.json` (the source metadata, including its description, plus any research brief and citations) and `edit_audit.json` (the full transcript, planner and repair prompts and responses, and Jev judgments, probabilities and usage). **Review & edit** runs keep a copy of the source video, a playback preview and the project file there too. Review these files before sharing a run folder, and delete the run folder to remove those local outputs.

### Settings, accounts and logs

Settings, the last synced list of connected accounts (platforms, handles and Zernio IDs), local posting history, and upload retry records live in Electron's per-user application data folder. Posting history can include clip paths and titles, account handles, targets, status and links; retry records can include a clip path and an uploaded media URL. Changing or removing the Zernio key switches to a separate local post history and quarantines the old account and upload retry caches.

Returning to the same key restores its saved post history; a newly rotated key has separate history. Quarantined copies remain on disk until a later cleanup after 30 days; to erase them immediately, quit the app and delete the `zernio-*.quarantine-*` files from its application data folder. Key changes do not delete media or posts already held by Zernio or a social platform. Diagnostic logs live in the per-user logs folder.

Remove provider keys in Settings to clear their encrypted saved copies, and review logs before sharing them in an issue.

Keys are encrypted with your operating system's secure storage. If secure storage is unavailable, BridgeClip asks you to configure or unlock it before saving keys.

## Inspect saved reviews

Use **Inspect transcript & edits** in a clip list, or **Details** in a Jobs row’s three-dot menu. The compact Details popup keeps its header and navigation visible while you browse:

- **Jev review:** actual questions, probabilities and per-check thresholds for each saved evaluation, with expandable criteria and input evidence.
- **Transcript:** searchable passages, original and repaired boundaries, retained/omitted speech and repair decisions.
- **Run details:** source context and planner requests.

Saved JSON throughout the review screens uses a color-coded, expandable viewer that also formats JSON stored inside strings. Long responses load more text or entries on demand; **Original** preserves the saved values and offers **Select all** for copying. Reopening makes no AI calls. New runs show a **Source context** section with the channel overview, likely format, research sources and uncertainties. They save `source_context.json` before transcription and include it in `edit_audit.json`; older runs can show their transcript but cannot reconstruct missing decisions.

These files contain source text: review them before sharing. Editorial scores and semantic duplicate comparisons remain advisory; **Editorial** sorting reweights saved scores locally.
