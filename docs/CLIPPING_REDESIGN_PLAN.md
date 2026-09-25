# Clipping & Smart Framing Redesign Plan

> Archived design notes. Since this plan was written, the engine moved into this repository and native Windows verification shipped. Historical release pins, uncommitted-work notes, and platform constraints below do not describe the current release. Phases 2–5 remain proposals.

_2026-09-23 · Synthesised from framing engine, clip selection/pacing, and integration/UX reviews. The findings below describe the original baseline; see the current progress note in Phase 1._

## TL;DR

Users see one layout because of four stacked failures, not one:

| # | Root cause | Status | Where |
|---|---|---|---|
| RC1 | Every smart render fails inside FFmpeg on an audio channel-layout error and silently re-renders as the blurred letterbox, **also discarding pacing cuts**. Today's log: 16 failures, 17 of 18 clips came out `fit`. | Verified + reproduced; fix verified | `<legacy-engine-checkout>/app/services/layout_renderer.py:280`, `rendering_service.py:181-195` |
| RC2 | Release builds pin the legacy engine at `1d2c2fd`, the April center-crop engine. The installed 0.1.16 has no layout code, no face model, no OpenCV. The current working tree would **fail every job** against that pin (bridge passes `layout_style`/`pacing`, which `1d2c2fd` doesn't accept). | Verified | `bridgeclip/.github/workflows/release.yml:88`, `bridge/bridge_runner.py:151-152` |
| RC3 | Concurrent renders share one YuNet detector; OpenCV 5 asserts and that clip falls back to letterbox. OpenCV 5's DNN engine is also ~5x slower. | Verified + reproduced | `layout_analyzer.py:839-845`, `requirements.txt` |
| RC4 | Even when it works, each layout has one fixed arrangement: always 50/50, screen always on top, webcam panel over-zoomed ~5x, webcam bleeding into the screen panel. | Verified (design + rendered frames) | `layout_renderer.py:24, 131-142, 183-190` |

Clip _selection_ has its own set of verified bugs. The worst: any clip length above "Short" is truncated to 90 s mid-sentence, and ~40% of clip endings run into the next sentence.

**Plan:** hotfix (Phase 0), then actually ship it (Phase 1). After that, rebuild framing around **setups → templates → an editable render spec** (Phase 2) and the planner around a **per-clip edit decision list** (Phase 3). Put a clip editor on top of the spec (Phase 4), and grind quality against a golden test set (Phase 5).

---

## 1. Findings

### 1.1 Framing / smart cropping

Current pipeline: decode 4 fps @ 640 px → YuNet faces + HSV-histogram cuts → greedy face tracking → `classify_shot` into `talking_head | two_shot | screen_cam | screen` → optional vision LLM once per shot → `ShotLayout` list → pure-function FFmpeg graph (`build_layout_graph`). The foundation is sound: plans with 3–6 segments that switch layout mid-clip are being produced (log: `talking_head[0-8.1s] screen_cam[8.1-18.4s] talking_head[18.4-25.6s] screen_cam[25.6-43s]`). Problems, ranked:

1. **RC1 audio failure** (above). Error: `Cannot select channel layout for the link between filters Parsed_aresample_40 and format_out_0_1`. Fix: append `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo` to `LOUDNESS_FILTER` (or `-ac 2`). `tests/test_layout.py:266` builds the graph without audio, which is why tests missed it.
2. **Webcam panel over-zoom.** This repeats the regression in the old `ZOOM_FIX_*` docs. `estimate_cam_box` (`layout_analyzer.py:269-278`) deliberately under-sizes the overlay to about 1/4 of its real area. `cam_crop` (`layout_renderer.py:131-142`) never applies `MAX_UPSCALE`. Measured: a 202×178 crop scaled to 1080×960, a **5.3x upscale**.
3. **Webcam bleeds into the screen panel.** The screen crop's "avoid" step dodges the undersized box, so a duplicate face and banner stay in the top panel.
4. **Vision-confirmed screen+cam gets downgraded to letterbox.** `split_overlay_segments` only considers faces with h ≤ 0.221 and doesn't search inside the cam box (`:321`). If YuNet misses the cam face, the shot becomes `screen`.
5. **Heuristics misclassify.** There is no screen-content signal and the corner test is rigid (`:262-266`). A small face on the middle of the right edge becomes `talking_head`, a wide shot with a person top-left becomes a fake split, and 3+ people fall back to letterbox.
6. **Two-person shots ignore who's talking.** Scribe diarization exists but the layout never uses it. The left person always goes on top, and boxes are shot-wide medians, so a person who moves gets cut off.
7. **Talking-head camera.** It is always a full-height crop, with no zoom for small faces or wide shots. There's 0.75–1 s of lag (5-tap median + easing), keyframe thinning drops hold-to-move transitions, and there's no vertical dead zone.
8. **Timing.** Cuts are quantized to 250 ms, so up to ~4 frames around each cut get the wrong framing, and inserts under 1.2 s are merged away.
9. **Overlays.** Captions sit on the split seam, the title covers the top of the screen panel, and the banner sits inside the platforms' bottom UI zone.
10. **Vision keyframes are 640 px** (`KEYFRAME_WIDTH=768` is defined but unused). The vision cache key is too coarse.
11. **Analysis runs per clip inside `render_clip`**, so the same setup is re-detected (and re-paid for) for every clip, and nothing can feed in an edited plan.

Rendered frames confirm #2–#3. In the screen-share + rounded-webcam clip (the exact target case), the heuristic correctly finds `screen_cam`, but the face panel is soft and 5x-upscaled, and part of the webcam shows in the top panel. In the Cursor-stream clip, the face panel is a ~7x crop with the stream's "…ATOR" text across the forehead and the top of the head cut off. The pure talking-head path looks clean.

**Worth salvaging from the pre-`810da77` stack** (reimplement, don't restore the 11k lines): speaker-driven splits, detection of already-split sources (`_detect_split_line`), edge-density screen cues, the "embedded facecam" keep-the-composite template, crop limits relative to source resolution, and snapping transitions to cuts.

### 1.2 Clip selection ("smart clipping")

Today one text-only LLM call reads a transcript with one sentence per line (timestamps at 0.1 s) and must return **exactly N** clips. N comes from video length alone. Fixed snapping code then adjusts boundaries. The planner never sees the video, and the framer only gets start/end/title/emphasis words from it.

| ID | Defect | Status |
|---|---|---|
| D0 | Audio failure (RC1) makes the fallback reset `time_map` to the whole window, so pacing is effectively never applied (1 "pacing removed" line in 18 clips). | Verified |
| D1 | Picking Medium/Long/Extra long/Extended truncates every clip >90 s to 90 s mid-sentence. The bridge never sets min/max, so they default to 15/90, and `intelligence_planner.py:950` re-reads the 90 for the end-snap cap. The prompt also contradicts itself ("120–300 s" and "≤ 90"). Also present in the shipped build. | Verified (252.5 s → 90.0 s) |
| D2 | ~40% of endings overshoot into the next sentence. 0.1 s rounding makes `find_sentence_end_boundary` skip the real end (`transcription_service.py:186-187`) and extend up to 5 s. Also present in the shipped build. | Verified (40/100 synthetic) |
| D3 | Clips can't end on the laugh or reaction: 150 ms padding, and snapping pulls an end inside a laugh to the next sentence. | Verified |
| D4 | Fixed quota ("Return exactly N"; 10 min → 12 clips) with no quality bar. "Let AI decide" is really a fixed curve, and the count ignores the chosen clip length. | Verified |
| D5 | Over-long clips are hard-cut at `start + max` instead of snapping back to the last sentence end. | Verified |
| D6 | "Cut dead air" does nothing with captions off, because the transcript is only passed when captions are on. | Verified |
| D7 | No-speech sources crash with `list index out of range` (`ai_clipping_pipeline.py:451-452`); there is no non-LLM fallback. | Verified |
| D8 | Filler cuts are centered on the gap and leave ~83 of 350 ms of "um" audible. Short-gap fillers are never cut but are always stripped from captions, so audio and captions disagree. | Verified |
| D9 | Silent screen demos in screen+cam shots are cut to 260 ms. When layout analysis fails, the 700 ms talking-head rule applies everywhere. | Verified |
| D10–11 | Snapping can leave the user's trim range, and length is checked before pacing, so a clip can come out under the minimum. | Verified |
| D12–14 | No voice-activity check before cutting pauses. The 0.75x audio slowdown costs 1.33x with unproven benefit. Long videos go to the planner in a single call (~130k tokens at 6 h). | Suspected |

Also: the planner's content-type classification (`insights`) is thrown away, and there's no transcript or plan cache (re-runs pay again and give different clips). `tests/test_pipeline.py` imports a removed module, and no test exercises `_parse_clip_plan_response` end to end.

### 1.3 Integration, shipping, UX

- **Smart silently becomes Classic.** OpenCV is optional in the engine, `validatePython` (`pipeline-runner.ts:153-154`) doesn't import it, and the UI parses `layout_type` but never shows it.
- **Wrong-arch binaries.** The installed arm64 app bundles x86_64 Python and FFmpeg, so rendering runs under Rosetta. The likely cause is that each CI leg builds both archs (`electron-builder.yml:51-59`).
- **Unpinned OpenCV** resolved to 5.0.0 (the race above). The 4.13+ Intel wheels need macOS 14.
- **Engine is private** (the separate legacy engine repository), which blocks "fully open source". The auto-update repo `bridge-mind/bridgeclip` returns 404.
- **Layout plans are saved lossily**, keyed by the original clip index, which misaligns once any clip fails and the rest are renumbered (`ai_clipping_pipeline.py:422-427, 698-725`). Downloaded sources are deleted with the work dir.
- **The paid layout-vision call is on by default**, has no toggle, and is missing from the cost breakdown (`ClipList.tsx:229-235`).
- **No post-render editing at all:** no in-app player, layout badge, per-shot layout swap, crop nudge, split ratio/swap, trim, caption edit or single-clip re-render.
- **Hidden engine options:** keyterms, banner (hard-coded null at `JobForm.tsx:66-67`), split ratio, split order, camera dead zone/speed, model choice. The UI also accepts `1:1`, which the legacy engine silently renders as 9:16.

### 1.4 Prior art: what "good" looks like

- **Per-segment layout switching is table stakes:** OpusClip, Quso, Descript, Riverside and Choppity all have it. OpusClip also applies one layout to many segments.
- **Best tools find regions first, then faces inside them:** OpusClip panels, Klap "content zones", StreamLadder facecam detection. The facecam rectangle is detected once per source and reused.
- **Screen-on-top / speaker-below** (OpusClip "Screenshare", Quso "Screen+Speaker") and **gameplay 70/30** are standard templates.
- **Biggest unmet user need:** consistent, lockable crops across clips, and saved per-show profiles ("podcast is in the same format every week").
- **Named complaints to avoid:** no control over who's on top in a split, facecam crop wrong per segment, exports ignoring manual reframes, jittery tracking.
- **Reference architecture:** Google AutoFlip (open source) buffers each whole shot, picks one camera mode per shot (stationary / pan / track), smooths the path, and pads with blur when required content won't fit.

---

## 2. Target architecture

```
 ingest ─► transcribe (Scribe, diarized) ─┐
    │                                     ├─► plan clips (LLM + signals) ─► ClipEDL[]
    └─► analyze source once ──────────────┘                                   │
         visual_timeline.json                                                  ▼
         (shots, setups, regions,             resolve framing per clip ─► clip_NN.layout.json
          face tracks, speaker map,                                           │
          activity)                                                           ▼
                                                  deterministic render ◄── UI clip editor
                                                  (spec → FFmpeg)         (edits spec, re-renders one clip)
```

**Three artifacts, all JSON, all persisted per job:**

1. **`visual_timeline.json`**: once per source, cached by content hash.
   - Samples ~1 fps over the whole video and ~4 fps inside candidate windows.
   - Shots, frame-exact at cuts.
   - **Setups**: clusters of shots sharing an arrangement, usually 1–4 per video. Each has its webcam rects, screen rect and people.
   - Layout class per shot, face tracks, and a speaker→face map (S1/S2 via mouth motion vs word timings).
   - Activity: `{bucket_ms: 250, t0_ms, screen[], cam[], scene[]}` plus `screen_events` (scroll, typing, cursor, cut), a screen-focus box and on-screen text density. `screen[]` is change inside the screen region with the webcam and static chrome masked out. `cam[]` is webcam motion; it never counts as activity and only marks reaction beats. `scene[]` is whole-frame change, for shots with no regions (gameplay, b-roll).
   - The vision LLM runs once per setup, and only when local confidence is low.
   - The planner reads a compact summary; the framer reads all of it.
2. **`ClipEDL`**: the planner's output per clip. It replaces the bare `start/end`.
   ```
   {id, rank, scores, rationale, content_type, title, hook_text, emphasis_words,
    ranges: [{src_start_ms, src_end_ms, role: hook|setup|payoff|reaction}],
    pacing: {profile, protect: [], beats: []},
    framing_intent: [{start_ms, end_ms, focus: speaker|screen|both|reaction,
                      speaker: "S2", screen_hint: "code editor", template?}]}
   ```
   `framing_intent` is a **soft preference**. The framer overrides it when it would break the resolution budget, e.g. a tiny webcam falls back to a cam-dominant stack instead of full frame.
3. **`clip_NN.layout.json`**: the render spec. It is the single source of truth for render, preview and editing.
   ```json
   {
     "version": 1,
     "clip_id": "clip_03",
     "source": {"hash": "…", "width": 1920, "height": 1080, "fps": 30},
     "output": {"width": 1080, "height": 1920, "fps": 30},
     "window": {"start_ms": 812000, "end_ms": 851500},
     "keeps": [[0, 4200], [4600, 39500]],
     "segments": [{
       "start_ms": 0, "end_ms": 8400, "setup_id": "setup_2",
       "template": "stack",
       "params": {"ratio": 0.6, "order": ["screen", "cam"]},
       "panels": [
         {"role": "screen", "src": {"rect": [0.0, 0.0, 0.66, 1.0], "focus": [0.1, 0.2, 0.5, 0.6]},
          "dst": [0, 0, 1080, 1152], "fit": "cover"},
         {"role": "cam", "src": {"rect": [0.66, 0.64, 0.33, 0.35], "track": "t2"},
          "dst": [0, 1152, 1080, 768], "fit": "cover",
          "path": {"mode": "stationary", "keys": [[0, 0.5, 0.45, 1.0]]}}
       ],
       "detected": {"layout": "screen_cam", "confidence": 0.91, "by": ["heuristic", "vision"]},
       "locked": false
     }],
     "transitions": [{"at_ms": 8400, "type": "cut"}],
     "captions": {"preset": "viral", "safe_area": [40, 1060, 1040, 1250]},
     "overlays": {"title": {"text": "…", "until_ms": 3000}, "banner": null}
   }
   ```
   `src` rects are normalized to the source frame. `dst` is in output pixels. Path keys are `[t_ms, cx, cy, zoom]` within the source rect. Every panel is clamped to `MAX_UPSCALE` at resolve time, so over-zoom is impossible by construction.

### Layout template catalogue

Templates are data with preconditions. The resolver scores the valid templates per segment on upscale budget (cam ≤ ~2x), content and `framing_intent`. The user picks which templates are allowed; the engine picks per shot, with a fallback.

| Template | Use | Precondition | User params |
|---|---|---|---|
| `track` | One person, full-frame virtual camera (wide / medium / close) | 1 dominant face or person | motion preset (still / smooth / follow) |
| `stack` | **Screen over cam** (the user's example) or cam over screen, ratio auto (50/50, 60/40, 65/35) | screen region + cam region | ratio, order, swap |
| `screen_fit_cam` | Whole screen fit-width (1080×608), cam fills the rest; nothing cut from code demos | screen + cam, cam big enough | cam zoom |
| `pip` | Full-bleed screen or scene with a rounded/circle cam bubble placed away from the screen focus | screen + cam | corner, size, shape |
| `gameplay_cam` | Game 70% / facecam 30% | game region + cam | ratio |
| `screen_zoom` | Follows the active pane (code, slides) | screen with a localized activity focus | zoom |
| `speakers_stack` | Two people, each keeps a stable slot across cuts | 2 tracks each present ≥ 35% of the shot | order, pin |
| `active_speaker` | Cuts full-frame to whoever talks; stacks during crosstalk | 2+ tracks + speaker map | hold time |
| `grid_3` / `grid_4` | Panels / Zoom calls | 3–4 tracks | order |
| `embedded` | Keep the source composite (already-vertical or already-split sources) | split line detected | – |
| `fit_blur` | Always valid; final fallback | – | background: blur / solid / brand |

Motion rules:
- **Camera mode per shot** (AutoFlip-style): stationary, constant pan or tracking, with a dead zone, velocity limits and a One Euro filter. Hard reset at every cut. Talking heads stay nearly still.
- **Switching:** layout switches snap to cuts, otherwise to word gaps. Minimum hold of 1.5–2 s with hysteresis. Crossfade only for a switch inside a shot.
- **Overlays:** captions go in the template's safe zone (never on a seam or a face); the title avoids the screen panel.

---

## 3. Phased plan

### Phase 0: Hotfix, make what exists actually work (1–3 days)

| Task | Files | Fixes |
|---|---|---|
| 0.1 Add `aformat=…channel_layouts=stereo` to `LOUDNESS_FILTER`. Add an audio case to the graph test and run it against the bundled FFmpeg b6.1.1. | `layout_renderer.py:280`, `tests/test_layout.py:266` | RC1 |
| 0.2 Three-step fallback, because a pacing edge case can itself cause the failure: (1) smart layout + cuts, (2) letterbox + the same cuts, (3) letterbox at natural timing. Log which step produced each clip and return a `render_fallback` field for the UI. | `rendering_service.py:181-195, 210` | D0, silent fallback |
| 0.3 One YuNet detector per thread (or a lock). Pin `opencv-python-headless>=4.10,<5` (e.g. 4.12.0.88 for older Intel Macs). | `layout_analyzer.py:839-845`, `requirements.txt` | RC3 |
| 0.4 Cap `cam_crop` at `MAX_UPSCALE`. Use the vision cam box for screen "avoid". Never downgrade a vision-confirmed `screen_cam` because YuNet misses the face; search inside the cam box. | `layout_renderer.py:131-142, 183-190`, `layout_analyzer.py:269-278, 321, 753-784` | over-zoom, bleed |
| 0.5 Screen shots keep demo protection when the plan is missing. | `clip_editor.py:95-96` | D9 |
| 0.6 One shared helper turns duration ranges into min/max for router, prompt and parser. Delete the re-read at `:950`. | `bridge_runner.py:144-160`, `intelligence_planner.py:640, 950` | D1 |
| 0.7 Accept a sentence end up to ~300 ms before the timestamp. Snap over-long clips **backward**. | `transcription_service.py:186-187`, `intelligence_planner.py:929-936` | D2, D5 |
| 0.8 Pass the transcript to pacing regardless of captions. Guard the empty plan with a clear "no speech found" message. | `ai_clipping_pipeline.py:407, 451-452` | D6, D7 |
| 0.9 Tests: `_parse_clip_plan_response` with ranges, snapping, clamping and an empty plan. Fix `test_pipeline.py`'s removed import. | `tests/` | coverage |

**Exit criteria:**
- Re-running this morning's 18-clip job gives 0 "Smart render failed".
- Clips mix `talking_head` / `screen_cam` with pacing applied.
- A "Long" clip keeps its full length and ends on a sentence.
- The webcam panel upscale is ≤ `MAX_UPSCALE`.

### Phase 1: Ship it (about 1 week)

1. **Commit** the legacy engine's framing work: `layout_*`, `clip_editor`, `openrouter`, `assets/models/`.
2. **Publish the legacy engine** (MIT, already prepared) and bump BridgeClip's release pin to the commit that contains the framing work. _(Decided; see §5.)_
3. **Contract check:** the bridge sends a `contract_version`, and CI runs `test:bridge` against the bundled engine.
4. **Preflight:** `validatePython` imports `cv2` and checks `LayoutAnalyzer().available`. The CI smoke test does the same, plus one tiny render through the bundled FFmpeg.
5. **Packaging:** one arch per CI job, and assert with `file` that the bundled Python and FFmpeg match the arch. Add the FFmpeg GPL notice and source offer.
6. **UI honesty:**
   - Layout badge per clip.
   - "Smart framing unavailable" warning when it falls back.
   - Layout-vision cost in the breakdown, with an on/off toggle.
   - Drop `1:1` until the engine supports it.
7. **Fix the `clip_layouts` index misalignment** after failed clips.

**Progress (2026-09-23, working trees):** Phase 0 fixes and the Phase 1 app/engine integration are implemented. The bridge checks its engine contract and Smart model availability; macOS release jobs stage one architecture each; users can switch paid vision on or off; and clip results preserve framing and pacing details. Confirmed silent or audio-free sources have bounded visual clip planning with clear caption status. The FFmpeg 8.1.3 build with libass passed caption/audio renders and 53 layout tests. The deterministic offline framing baseline has five golden scenes. An unsigned arm64 app passed the packaged resource check. The code and tests remain uncommitted in the current working trees.

**Release work still required:** Publish and review the legacy engine source, replace the engine source pin file's `UNPINNED` placeholder with that reviewed commit, publish BridgeClip, and run signed/notarized install tests on both macOS architectures. A paid provider run and a real Zernio account/post run still require project credentials. Phase 2–5 below are a longer product roadmap and are not implemented by the Phase 0–1 fixes.

**Exit criteria:** a fresh install from the release DMG renders the reference screen-share video as screen-over-cam, with a natively running (arm64) engine on Apple Silicon.

### Phase 2: Framing engine v2 (2–3 weeks)

0. **Golden test set first.** It drives every decision after this. Five to ten labelled sources:
   - corner-facecam screen share
   - stream with chrome/overlays
   - 2-camera podcast
   - wide two-shot
   - Zoom grid
   - single talking head
   - gameplay + facecam
   - an already-vertical source

   Metrics:
   - face-in-frame %
   - max upscale
   - crop jerk (velocity/acceleration)
   - region IoU vs labels
   - layout accuracy
   - fallback rate
   - time per minute of source
1. **`visual_timeline.json` pass**, cached by source hash, replacing per-clip analysis:
   - Shots: PySceneDetect `AdaptiveDetector`, then re-decode ±300 ms at native fps for frame-exact cuts.
   - Faces: YuNet, plus a 2x corner-tile pass for small facecams and a person detector (NanoDet-Plus or MPPersonDet) when no face is visible.
   - Tracking: vendored ByteTrack/OC-SORT.
   - Setup clustering: frame signature + face arrangement + static-region mask.
   - Activity per 250 ms.
2. **Region detection (local, offline):**
   - Webcam rect: a temporal-variance map over 10–20 frames (webcams change everywhere, screens change in spots), keep the region containing the face, snap it to straight borders with Canny/Hough.
   - Screen: cropdetect for bars; exclude static stream chrome.
   - Screen focus: from the change map.
   - Already-split sources: split-line detection.
   - Vision LLM (BYOK) only on low confidence, once per setup, with keyframes at 768 px.
3. **Template catalogue + resolver** (§2), with preconditions, scoring and the upscale budget.
4. **Camera path solver:** per-shot modes, dead zone, velocity limits, One Euro, hysteresis, switches snapped to cuts or word gaps.
5. **Render spec + compiler:** emit `clip_NN.layout.json`. Evolve `build_layout_graph` into a spec→FFmpeg compiler (single pass). Put overlays in template safe zones.
6. **Split analysis from rendering:** bridge `mode: analyze_source | plan | render_clip`. Keep the source (or a 540p proxy plus padded windows) for each job.

**Exit criteria:**
- Golden set: layout accuracy ≥ 90%.
- Region IoU ≥ 0.85 on facecams.
- 0 panels over `MAX_UPSCALE`.
- Fallback rate < 5%.
- Analysis takes ≤ 0.3x the source's real-time duration on an M-series Mac.

### Phase 3: Smart clipping v2 (about 2 weeks, overlaps Phase 2)

1. **Content-type detection → profile:** podcast/interview, screen tutorial, stream/gaming, talk, vlog. Detect from the layout mix, speaker count and a transcript sample. The profile sets the prompt module, default durations, pacing and framing defaults. Persist `insights`.
2. **Planner addresses transcript line IDs, not timestamps.** It returns `start_line`, `end_line`, `hook_line`, `payoff_line`, `reaction_tail`, `framing_intent` and a one-line rationale. Code maps lines to exact word times, which removes D2 and invented timestamps. Transcript lines carry visual tags from the timeline, e.g. `[L123 45.2–49.8] (S1) text (laughter) {screen_cam, high motion, text:"npm install"}`.
3. **Long videos:** windowed 10–15 min scans with a cheaper model, then Opus ranks the shortlist.
4. **Signal candidates:**
   - Sources: laughter/applause clusters, energy peaks, YouTube chapters/heatmap, big visual events.
   - Title/description/chapters also feed the prompt.
   - These double as the no-speech and no-LLM fallback (D7).
5. **Deterministic boundary refiner:**
   - Start: on a sentence start, dropping weak openers.
   - End: on a sentence end, extended through any reaction plus a 300–600 ms beat, stopping before the next speech.
   - Over-long clips snap backward.
   - Clamp to the trim range after snapping.
   - Enforce length on the estimated post-pacing duration.
6. **Ranking:**
   - Weighted score (hook ~30%) plus signal features.
   - Dedupe by topic, not just time overlap.
   - Return **up to N above a quality bar**, so "Let AI decide" is real.
   - Show the rationale on ClipCard.
7. **Pacing v2:**
   - Cut exact filler spans (±40 ms) with short crossfades.
   - Confirm silence with VAD/RMS before cutting.
   - Activity-aware, replacing the fixed per-layout `MAX_PAUSE_MS`: in a silent gap, keep or 2–4x speed up the 250 ms buckets where `screen[]` (or `scene[]` when the shot has no regions) is above a threshold, and cut the rest. `cam[]` never counts as activity.
   - Protect the beat before reactions; only laughter/applause/cheering count as reactions.
   - Minimum spacing between cuts; per-profile thresholds.
8. **Hook-first option:** a cold-open `range` with `role: hook` (the EDL already supports multiple ranges).
9. **Cost and consistency:** cache transcripts and plans by source hash. A/B the 0.75x transcription slowdown.

**Exit criteria:**
- On a labelled set, ≥ 95% of ends land on a sentence end or reaction tail.
- 0 clips outside the chosen duration range.
- No-speech sources produce signal-based clips instead of crashing.
- Human preference beats v1 on paired comparisons.

### Phase 4: Clip editor in BridgeClip (2–3 weeks)

1. **In-app player** with a live canvas preview composited from the source or proxy using the spec's rects. It shares one geometry module with the renderer, so **preview equals export**.
2. **Per-segment template dropdown** (only templates whose preconditions pass are enabled), with hover preview.
3. **Direct manipulation:**
   - Drag or resize source rects over a still.
   - Split-ratio slider.
   - Swap and pin-to-top.
   - Lock framing.
   - Click a face to track it.
4. **Scope controls:** "apply to this clip / every segment in this setup / every clip from this source". **Saved per-show layout profiles** keyed by setup signature and re-applied automatically on the next episode.
5. **Transcript-based trim/extend** and caption edits.
6. **Re-render one clip** via `mode: render_clip`, in seconds, with no analysis or LLM calls.
7. **Library basics:** delete, re-open a job, re-export.

**Exit criteria:** fixing a wrong facecam rectangle once corrects every clip from that source. Editing a clip and re-rendering it takes < 15 s for a 45 s clip.

### Phase 5: Quality (ongoing)

- **Active speaker detection:**
  - v1: mouth-region motion × audio RMS × diarization, with hysteresis.
  - v2: Light-ASD (MIT, ~4 MB) via ONNX Runtime.
  - Enables `active_speaker` and speaker-aware `speakers_stack`.
- **L1-optimal camera paths** (Grundmann 2011 / AutoFlip) via scipy HiGHS.
- **Fine-tuned facecam detector:** YOLOX-Nano on the CC BY 4.0 Roboflow face-cam dataset.
- **Captions** placed to avoid faces; `grid_3` / `grid_4`.
- **Golden-set regression gate** in CI for every engine change.

---

## 4. Technology choices (offline, CPU, MIT-compatible)

| Component | Choice | Size / speed | License | Notes |
|---|---|---|---|---|
| Face detection | **YuNet** (OpenCV DNN) | 227 KB, ~1.6 ms @ 320 px | MIT | Already in repo; add a corner-tile pass |
| CV runtime | **opencv-python-headless 4.x** | ~40 MB wheel | Apache-2.0 | Pin `<5` (race + ~5x slower YuNet on 5.0) |
| Person detection | NanoDet-Plus-m / MPPersonDet | 2.3 MB / 12 MB | Apache-2.0 | Fallback when faces aren't visible |
| Tracking | ByteTrack / OC-SORT (vendored) | a few hundred lines | MIT | scipy Hungarian matching |
| Shot detection | PySceneDetect `AdaptiveDetector` | small | BSD-3 | TransNetV2 (MIT, 30 MB) optional later |
| Active speaker | Mouth-motion heuristic → Light-ASD | 4.2 MB | MIT | Via onnxruntime (MIT, 14–21 MB, optional) |
| Smoothing | One Euro + dead zone; L1 path via scipy | – | permissive | – |
| Region confirm | Vision LLM via the user's OpenRouter key | per-setup call | – | Only on low local confidence |

**Avoid:**
- Ultralytics YOLO (AGPL, weights included) and yolov5/8-face (GPL-3): they conflict with MIT distribution.
- BoxMOT (AGPL).
- InsightFace SCRFD/RetinaFace weights (non-commercial).
- LoCoNet (no license).
- MediaPipe (removed `mp.solutions` in 0.10.31, no Intel-Mac wheels past 0.10.21).
- PyTorch (size, and no Intel-Mac wheels past 2.2.2).

**Bundle impact:** about +150 MB installed for OpenCV + numpy, on top of today's 571 MB app. Models add < 20 MB.

---

## 5. Decisions

**Decided 2026-09-24 (supersedes the 2026-09-23 engine decision):**
- **Engine:** the clipping engine lives in `bridgeclip/engine/` (package `clip_engine`) under MIT, and release builds package it directly. The former engine repository is deprecated; BridgeClip no longer pins, stages or reads it. Legacy engine references elsewhere in this plan are historical.

**Decided 2026-09-23:**
- **Vision check:** only when local confidence is low, once per setup, with a toggle and a cost line.
- **Platforms:** macOS only for this redesign.

Still open: bundle size (item 2) and default split (item 4). Both default to the recommendations below.


1. **Engine location.** Recommended: move the stripped local engine into `bridgeclip/engine/` under MIT. Alternative: publish the legacy engine repository as MIT and keep pinning it. Staying private blocks open source and keeps causing pin drift like RC2.
2. **Bundle size.** Is ~+150 MB for OpenCV acceptable? (No torch/mediapipe; that's the minimum for local smart framing.)
3. **Vision LLM default.** Recommended: local-first, calling the vision model only on low confidence, once per setup, with a visible toggle and cost line. Today it's on for every shot, hidden from the cost breakdown.
4. **Default split for screen + cam.** Recommended: screen 60 / cam 40, with the resolver dropping to `screen_fit_cam` or `pip` when the webcam is too small to fill 40% without exceeding the upscale budget.
5. **Windows.** `electron-builder.yml` has a Windows target but CI only builds macOS. Is it in scope for this redesign?

## 6. Evidence

- App log: `~/Library/Logs/BridgeClip/bridgeclip.log`, with 16× `Cannot select channel layout` / `Smart render failed, retrying as classic letterbox`.
- The reviewers' repro scripts, captured FFmpeg commands and rendered frames were written to this session's temporary scratchpad (`framing/`, `clipping/`, `product/`). Copy them out if they should be kept.
- Pre-refactor stack for salvage: `git -C <legacy-engine-checkout> show 810da77^:<path>`. Past zoom failures: `<legacy-engine-checkout>/README_FACE_CROPPING_ZOOM_ANALYSIS.md`, `ZOOM_FIX_PLAN_*.md`.
