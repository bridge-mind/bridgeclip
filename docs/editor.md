# Review and edit clips

[Overview](../README.md) · [User guide](usage.md) · [AI and privacy](ai-and-privacy.md)

Choose candidates, refine cuts and framing, and export when you are ready.

## Open a project

Choose **Review & edit** on Create’s first step to find candidates without rendering them. BridgeClip transcribes the source (researching it first if web research is on), proposes moments and suggests framing. It opens a saved editor project when discovery finishes. The automatic workflow remains available.

Reopening a Library item goes straight to the editor when it has unfinished candidates and no baked clips. Once there are baked clips, it opens their list with a prominent **Continue editing** button and a count of clips left to finish. When every candidate is baked or discarded, the list keeps a quieter **Open editor** button. The editor starts on an unfinished candidate, falling back to a baked one before any discarded candidates.

Library cards with unfinished candidates show a blue **Editing** badge, the number left to finish and a matching border, even if some clips are already baked. The indicator clears once every candidate is baked or discarded.

## Read candidate reviews

Review every candidate’s **Jev** questions, probabilities, thresholds and criteria, including candidates that need attention. Nothing is discarded or repaired automatically in this workflow. Disabled, unavailable or incomplete reviews are shown as unrated, never as passes.

## Playback and shortcuts

Watch the source beside the output framing. Drag trim handles or enter timecodes, split at the playhead and remove unwanted sections. **Play cuts only** previews the retained sequence; turn it off to inspect surrounding context. The **Transcript** tab follows the active caption during playback; pause to browse freely. Creating a new layout pauses and selects it for editing. Space plays/pauses after dragging frames, selecting a layout marker or adjusting a framing slider; holding Space toggles only once.

**Review speed** beside the playback controls offers 1×, 1.5×, 2× and 3× preview playback, relative to the clip’s export speed. Press **1**, **2** or **3** to switch directly to 1×, 2× or 3× while reviewing; shortcuts leave typing in fields alone. It stays selected while switching candidates and does not change saved edits or exports. I/O sets the outer trim, S splits, and arrow keys step 1/2/3 source frames at 1×/2×/3× review speed (1.5× rounds to two frames).

Shift+arrows jump one second; the dedicated frame buttons always move one frame.

## Trim and extend sections

Clicking a timeline position or a retained cut keeps the video playing from that position; if paused, it stays paused. Drag either edge of a timeline section to trim or extend it. **Timeline zoom**, below the timeline on the right, combines **Full source** for larger adjustments, **Clip** for the current clip with surrounding context, and **Playhead** for a close-up of one second on either side of the current position.

Turn off **Play cuts only**, watch beyond the current selection, then choose **Extend to playhead** to extend its ending (or its beginning when the playhead is before the clip). Adjacent cuts and the source’s bounds limit each edge; edits support undo and redo.

## Layouts and crop movement

Choose **Full frame**, **Split** or **Fit**. Drag inside a crop rectangle to move it, or drag any corner to resize it with the opposite corner anchored. Corners preserve the crop’s proportions and stay within the source; split layouts have independent handles for each panel. Arrow keys adjust a focused corner (Shift for larger steps). Position and zoom controls remain available. Add a layout change at the playhead to reframe another section, or apply one layout to the whole clip.

Edit **Layout starts** or drag its diamond on the timeline to move an existing change; arrow keys nudge a focused diamond by one source frame after a camera scan (before scanning: 0.1 seconds; Shift: 1 second). Changes stay between their neighbours, with undo and autosave support. Enable **Smooth movement** on a new layout to ease from the preceding crop, including zoom, in both preview and export. Adjust its duration from 0.1–5 seconds of source time.

Movement works between matching Full frame or Split layouts; changes between layout types use a cut.

## Find camera changes

Use the scan icon in the timeline toolbar to open **Find camera changes** (or **Rescan camera changes**). The popup explains the scan and lets you choose sensitivity before selecting **Scan clip** to inspect every frame of the selected clip locally. Amber camera markers are suggestions: select one to **Insert layout at cut**, **Align nearest layout**, or **Remove camera marker**. Click elsewhere to deselect the marker and hide its actions.

Choose **More sensitive** in the scan popup to reveal weaker cuts; motion and flashes can also produce suggestions. Removed markers stay hidden across restarts; use **Restore removed markers** in the scan popup to bring them back. Removing a marker keeps your layouts and cuts. After scanning, arrow keys and the previous/next-frame buttons use actual source frame timestamps, including variable frame rates. Layout drags snap to source frames and nearby visible camera markers; **One frame earlier/later** and **Timeline zoom → Playhead** help fine-tune boundaries.

Older projects get a frame-preserving preview on their first scan. Outside the scanned footage, arrows and frame buttons keep moving in approximate 1/30-second steps, so you can always move back from either edge. Rescan after extending beyond the scanned footage for precise stepping; replacing the source clears scan results. A manual scan does not change layouts or Ready/Baked status.

New Smart framing runs also scan during the pipeline: strong cuts and sustained face-composition changes refine automatic boundaries to source frames, while weaker markers remain available for review. Extra face checks are bounded to 160 likely changes and 6,000 frames per clip. Optional AI layout checks are limited to the first 12 image decisions per clip, with cached decisions reusable afterward; camera scanning itself makes no AI requests. If detailed scanning cannot complete, the sampled framing pass remains available.

## Position captions

The right-hand tab stays selected when you switch candidates. In **Transcript**, a steady **Captions go here** sample shows subtitle placement over the output video in the selected style. Drag them up or down, use the vertical position slider, or choose Top, Middle or Bottom; the saved position applies throughout this clip when baked. **Automatic** restores layout-based placement. The sample stays visible while playing or seeking, including gaps and caption-free sections, so you can adjust placement without following spoken words.

It is a placement guide; baked captions still use your transcript and actual speech timing.

## Correct caption text

Click a pencil in **Transcript** to correct a line while reviewing. Corrections autosave for this candidate only, support undo, and appear in its final video. **Reset text** restores the source line; clearing a line hides its caption without removing audio. Corrections keep word timestamps when the word count matches; otherwise new words are spread over that line’s spoken interval.

## Suppress captions in selected sections

In **Captions**, use **Suppress captions here** for footage with baked-in source captions. **Add another section** creates additional ranges, even when the playhead is inside an existing one. Adjust each caption-free section’s start/end time or set them from the playhead. Amber timeline bars mark these sections. Suppression autosaves per candidate, supports undo/redo, and follows the source through trims, removed sections and speed changes. It hides only BridgeClip’s captions; source captions and audio remain. Remove a range to restore our captions there.

## Review your edits again

Re-run Jev after editing. The previous review is marked out of date after changes to the title, cuts or framing. Internal removals receive their own safety and join questions. These reviews advise you; you decide when a clip is ready, including when a review raises concerns. Jev continues to review the source dialogue and your cuts; caption corrections do not rewrite that evidence.

## Candidate states

Clips start in **Refining**. **Discard** sets one aside in a collapsible group; **Restore clip** brings it back. Choose **Mark ready** when satisfied, then **Bake captions** (or **Render clip** with captions off). A successful render moves the candidate to **Baked**. Further changes return it to Refining. Discarding a candidate never deletes earlier exports.

## Caption styles and exports

Select a caption style and playback speed before baking. Captions are timed to the retained footage and baked into the final video; the live output preview shows framing; caption text can be reviewed and edited in **Transcript**. Each export becomes a new Library clip, preserving earlier exports. Titles are clip metadata, not automatic title-card overlays.

## Export ready clips together

Use the arrow beside **Bake captions** to choose **Bake all ready clips**. It renders every Ready clip in the current editor in order, using each clip’s caption settings and suppressed sections. Progress shows completed clips; cancelling or a failure keeps completed exports and leaves the remaining clips Ready.

## Replace the source video

Use **Replace source video** to switch to a higher-quality copy of the exact same video. Keep content, timing, audio and framing identical; the editor warns before replacing and rejects incompatible duration or aspect ratio. Cuts, crops and caption edits are preserved, baked candidates become ready to render again, and earlier exports remain in Library.

## Autosave and project storage

Edits autosave and reopen from Jobs or Library. Review projects retain an independent full-resolution source copy, a smaller playback preview, the transcript and the project file in the run folder. These need additional disk space and remain until the Library item is deleted. Existing automatic runs remain inspectable; start a new Review & edit run to create an editable project. Rendering is local; discovery and **Review again** use the configured providers and can incur API costs.

See [AI, costs and privacy](ai-and-privacy.md) for review rules and the data sent to providers.
