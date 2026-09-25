# Audio/video synchronization review — September 24, 2026

**Follow-up:** the [remaining audio-delay review](AV_SYNC_FOLLOWUP_2026-09-24.md)
reproduced an additional end-of-clip timestamp gap in actual exports. It also
corrects a blind spot in the raw-PCM measurements used below and adds packet
validation; start/end metadata alone did not detect that defect.

BridgeClip could introduce real synchronization errors. This review reproduced
them with generated flashes and matching audio pulses, then fixed the active
engine. The fixes are in the local source checkout; no release was published.
No affected customer source/export pair was supplied, so these results establish
reproducible product defects rather than attributing every customer report to
one cause.

The review covered download/import, source timestamps, transcription extraction
and chunk offsets, pacing/skip ranges, smart and classic framing, captions and
chapter time maps, FFmpeg seeking/encoding/muxing, fallback rendering, embedded
playback, file export and posting. Changes are confined to the Python engine,
regression tests and this report. Existing unrelated workspace changes were
preserved.

## Confirmed defects and fixes

| Finding | Effect | Fix |
| --- | --- | --- |
| Audio and video independently reset to their first retained timestamp | A late audio track moves earlier; late video can move earlier too | Establish a common window clock. Preserve audio offsets with timestamp-aware resampling and silence; normalize video using presentation timestamps |
| Missing audio packets are not reconciled with the sample clock | Audio after a gap moves earlier than its corresponding video | Fill timestamp gaps on the audio clock before cutting; retain silence at missing edges |
| Every framing shot participates in paired audio/video concat | Frame rounding and longest-stream padding accumulate against the caption/edit timeline | Allocate video frames from cumulative rational frame totals. Concatenate exact audio keep intervals separately, on the same edit timeline |
| Audio is faded at every framing change | Continuous speech/pulses get small artificial dips despite no content cut | Apply fades only at real edits and clip edges |
| Transcription strips effective audio offsets and automatically selects a track | Word timestamps can move; captions and cuts can follow a different track from the rendered sound | Preserve offsets/gaps during extraction and explicitly select `0:a:0` in transcription, rendering and loudness measurement |
| `-avoid_negative_ts make_zero` shifts presentation to accommodate encoder delay | Clip media starts later than the zero-based edit/subtitle timeline | Allow MP4 edit lists to represent AAC priming and reordered video correctly |
| Audio exists in the file but no packets exist inside the selected window | The audio graph can fail or lack output | Supply a finite silent bed covering the window, including fully empty audio windows |
| Short digital silence can produce non-finite loudness-filter samples | AAC encoding fails on affected FFmpeg versions | Replace only non-finite samples with zero; preserve finite samples and stereo separation |
| Successful FFmpeg exit was sufficient to accept an export | Missing, shifted or truncated tracks could be marked complete | Probe final stream starts/durations against the edit. Reject and remove invalid exports and use the existing fallback ladder |
| Failed audio probing looked like an audio-less source | A probe failure could silently discard sound | Fail explicitly when source audio cannot be verified |
| An explicit empty keep list meant “keep everything” | An empty edit could render unintended content | Reject an empty edit |

Removed the unused legacy `_run_ffmpeg` helper so there is one active encoding
path with timing validation. Caption and chapter calculations retain the same
`TimeMap` as the exact audio edits. Video frame rounding is bounded across the
whole edit, rather than accumulating independently at each shot.

## Measured reproductions

Measurements decode the output pixels and audio samples. Audio onsets are
measured in 5 ms RMS windows; zero measured error means agreement at this
measurement resolution, not a claim of unlimited precision. The comparison
used the pre-review files saved before edits and local FFmpeg 9.0.2.

| Fixture | Before | After |
| --- | --- | --- |
| Audio track starts 300 ms after video | Maximum A/V offset 334.7 ms | 0 ms measured |
| Missing audio packets around 3–3.5 seconds | Maximum A/V offset 549.7 ms | 20 ms; unavailable source samples remain unavailable |
| 20 seconds with about 40 off-grid framing changes | Video drift against the planned timeline 366.7 ms; output length 20.421 s; 28 pulse onsets due to audio dips | 0 ms measured timeline error; output length 20.000 s; the original 20 pulse onsets |
| Transcription of a delayed audio track | First pulse decoded around 264 ms instead of 500 ms | First pulse retained around 500 ms |
| Three-minute source, 180 cuts, 29.97 fps, 44.1 kHz audio | Regression/stress fixture added | All 180 events retained; audio timeline error at most 3 ms; output 127.799 s for a 127.800 s edit |

The long-edit fixture's largest flash/beep difference was 49.9 ms, including
source frame sampling and output frame rounding; it did not grow with the
number of cuts. Separate cut/seek tests compare the rendered visual events
with the actual source frames, allowing at most one output frame plus the
measurement bucket. Sparse video necessarily has the temporal precision of
its available source frames.

## Validation

- Added 32 media regression cases and 18 export-guard cases in
  `engine/tests/test_av_sync.py` and `engine/tests/test_render_timing.py`.
- Full engine suite: 280 passed, 1 skipped with bundled FFmpeg 8.1.3; 280 passed,
  1 skipped with local FFmpeg 9.0.2. The skips differ: the LGPL bundle lacks
  libx264; the Homebrew build lacks the ASS filter for the existing captioned
  longform integration test. The bundled run exercises that longform test.
- Final focused checks passed all 18 export-guard cases plus two additional AAC
  transcription-chunk seek cases with the bundle. The two chunk cases also
  passed with local FFmpeg.
- Media cases cover 24/25/30/60 and 29.97/59.94 fps, sparse variable frame rates,
  44.1/48 kHz audio, late tracks, missing packets, nonzero container timestamps,
  AAC source priming, nonzero seeks, repeated cuts, framing changes, overlays,
  silent edges/windows, stereo isolation, multiple audio tracks, and video-only
  output. H.264 checks exercise both libx264 and VideoToolbox where available.
- Bundled smart-render and transcription-extraction smoke checks passed.
- `npm test` passed: 165 JavaScript tests and 19 bridge tests.
- `npm run typecheck`, `npm run lint`, and `git diff --check` passed.

The existing CI and release workflows already run `engine/tests`, so these
regressions participate in their normal gates. Reproduce the media/guard checks
from the repository root:

```sh
PYTHONPATH=engine engine/.venv/bin/python -m pytest -q \
  engine/tests/test_av_sync.py engine/tests/test_render_timing.py
```

To test a staged bundle, put its binary directory first on `PATH`, set
`TEST_FFMPEG` and `TEST_FFPROBE` to its executable paths, and run the same tests.

## Playback, boundaries and remaining limits

The inspected previews use one native video element playing the muxed file;
they do not maintain separate JavaScript audio and video clocks. The local
media handler supports byte-range requests. No separate playback-clock defect
was identified in those paths. This review did not run a native Windows player
or externally posted social-platform playback session.

Every active export now requires one video stream, the requested audio stream,
finite positive durations, starts within 3 ms of zero, and end times within one
video frame or one AAC packet (plus 3 ms of mux rounding) of the planned edit.
This check detects structural timing failures. It cannot determine whether
someone's lips and voice were already misaligned inside the source content.

The implementation preserves source timing to frame/sample precision; it
cannot reconstruct missing frames or audio, correct incorrect source timestamps
without external evidence, or promise perfect playback on every device. Existing
exports must be regenerated to receive the fixes. A customer source and affected
export would allow their exact complaint to be checked against these cases.

FFmpeg's documented behavior informed the fixes: its [concat filter](https://ffmpeg.org/ffmpeg-filters.html#concat)
uses the longest related stream for a segment, and its [resampler options](https://ffmpeg.org/ffmpeg-resampler.html)
describe timestamp compensation and padding/trimming with `first_pts`.
