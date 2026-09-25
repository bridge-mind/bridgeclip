# Remaining audio delay: root cause, fix, and verification

The remaining delay was reproduced in an actual recent BridgeClip export and
isolated to the final audio presentation timestamps after loudness normalization.
The fix is in the local engine. Existing exports require regeneration; no release
was published as part of this review.

## Evidence from the actual library

The review used `clip_00.mp4` from run
`a429e7b9-3ff1-4ad6-b6f3-c947e814ac72`, a 41.720-second edit of
the source **Grok Bot vs Hermes Agent**. The source was downloaded through the
production downloader, and its audio was correlated against decoded, individually
sought sections of the export. Video frames were matched against the source after
accounting for the crop. No transcription or vision API call was needed.

| Output position | Audio offset from intended source time, before | After |
| --- | ---: | ---: |
| 5 s | 0 ms | 0 ms |
| 10 s | 0 ms | 0 ms |
| 15 s | 0 ms | 0 ms |
| 36 s | 0 ms | 0 ms |
| 39 s | **80 ms late** | **0 ms** |

Audio correlation exceeded 0.97 at these points. The audio measurements have
1/16000-second sample resolution and compare with the source's timing, rather
than claiming that the original recording has perfect lip sync. Video frame
matches were unchanged by the fix (correlation above 0.996); the added 80 ms
audio delay was removed.

The original file contains this AAC packet sequence:

```text
packet start       packet duration
38.784000          0.021333
38.805333          0.101333  <-- 80 ms too long
38.906667          0.021333
```

At 48 kHz, the AAC encoder normally emits 1024-sample packets, about 21.333 ms.
The next packet should have started around 38.826667, rather than 38.906667.
Every subsequent audio packet therefore plays 80 ms late. Scanning the other
exports in this same run found overlong packets in **25 of 27 clips**, with
additional delays up to **90 ms**. The regenerated example has none.

## Exact cause

`build_layout_graph()` already reconstructs source audio timing with timestamp
aware resampling, supplies silence where packets are missing, and concatenates
the exact kept audio intervals. Those operations are necessary and remain intact.

The final `loudnorm` filter buffers audio in 100 ms blocks with a roughly
three-second internal buffer. When the last input block is partial, its output
samples can remain correct while the final buffered output has a discontinuity
in its presentation timestamps. This reproduced with the bundled FFmpeg 8.1.3
in the combined video/audio graph. Audio-only raw-sample extraction did not
expose it. FFmpeg's [loudnorm implementation](https://github.com/FFmpeg/FFmpeg/blob/n8.1.3/libavfilter/af_loudnorm.c)
contains the block-size, timestamp queue, and EOF flush logic involved.

The old graph sent those timestamps directly to AAC. The MP4 muxer represented
the discontinuity as an extended packet duration. For the 41.720-second example,
the partial block leaves an 80 ms gap near the beginning of the final buffered
audio. This is not an 80 ms offset to apply to every clip: its size depends on
the fractional edit duration, and earlier audio is already correctly aligned.

Two checks missed this:

1. The export guard checked only stream starts and total durations. Title/banner
   overlays enable `-shortest`, which can cut off the delayed tail. The affected
   example reports audio duration 41.722 s and video duration 41.733333 s, both
   close enough to the planned duration to pass, despite the internal gap.
2. The previous flash/beep helper decoded audio straight into raw PCM. Raw PCM
   concatenates decoded samples without retaining the packets' presentation
   timestamps. The beeps therefore appeared aligned in the test even though a
   timestamp-driven player would play the last ones late.

## Changes

- **Final sample clock:** after concatenation, loudness normalization, and the
  final 48 kHz format conversion, the graph uses
  `asettb=1/48000,asetpts=N`. Each output sample now determines its presentation
  time. This applies to dynamic normalization, measured linear normalization,
  and a measured filter that falls back to dynamic normalization. No samples
  are moved, dropped, stretched, or shifted by a guessed constant.
- **Preserved source timing:** the reset is deliberately after source timestamp
  compensation and editing. Moving it before compensation would remove genuine
  delayed starts and packet gaps from the source.
- **Packet validation:** every audio export now receives a streaming FFprobe
  check of AAC durations and consecutive presentation timestamps, in addition
  to the existing stream checks. Memory is bounded, and the probe uses the
  existing process timeout and restricted media-tool environment. Encoder
  priming and a short final packet are accepted. Missing, malformed, overlong,
  duplicated, or discontinuous packets reject the export through the existing
  removal/fallback path.
- **Playback-aware tests:** flash/beep measurements now materialize timestamp
  gaps before inspecting samples. Added fractional-duration fixtures with and
  without overlays, edited audio with all normalization modes, and packet-guard
  regressions. Six of the first eight new media cases failed against the saved
  pre-fix graph; the remaining two had only a sub-measurement-resolution gap.

## Review coverage

| Area | Result |
| --- | --- |
| YouTube/local input and remux | Source timestamps survive into the render input; downloaded the recent run's source through the actual service for comparison. |
| Source seeking and frame conversion | Exercised MP4, Matroska, WebM, FLV, MPEG-TS, AAC/Opus, nonzero origins, fractional seeks, and 29.97/59.94 fps inputs. |
| Transcription and chunk extraction | Same selected audio track, source offset/gap preservation, and chunk-relative timing retained. No new defect identified here. |
| Pacing, framing, captions, chapters | Kept intervals and the shared edit map remain intact; the final audio clock fix applies after these edits. |
| Audio normalization and AAC/MP4 mux | Confirmed remaining defect and fixed its output clock. |
| Fallbacks and export completion | Invalid packet timing fails before a clip is accepted; existing fallback/removal behavior is retained. |
| Desktop preview and export/post paths | Playback uses a native video element or external player for one muxed MP4. File export and posting use that file; there is no separate JavaScript audio clock to correct. |
| Packaged versus development engine | Both pre-existing packaged apps contained the earlier sync patch, but neither contains this new fix until rebuilt. The running development app starts each new worker from the source engine. |

## Validation

- Full engine suite: **417 passed, 1 skipped**, with the bundled renderer/prober
  selected by `TEST_FFMPEG`, `TEST_FFPROBE`, and `TEST_FFMPEG_DIR`. The skipped
  encoder case needs libx264, which the LGPL bundle excludes. The existing HLS
  downloader fixture uses Homebrew's libx264 to generate its source, then tests
  the bundled downloader/mux/probe path.
- Focused sync/guard suite on Homebrew FFmpeg 9.0.2: **74 passed**. The same 74
  cases participate in the full suite above (73 pass with the LGPL bundle and
  the libx264 case skips).
- `npm test`: **193 JavaScript tests and 24 bridge tests passed**.
- `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`
  passed.
- Production render of the actual 41.720-second clip passed the new packet
  guard. Source comparison confirmed the 80 ms tail delay was removed. The
  old example fails the same guard on an overlong AAC packet.

The 23 added cases (11 media cases and 12 packet-guard cases) run through the
existing CI/release engine test jobs. Reproduce the focused checks using the
bundled media tools:

```sh
TEST_FFMPEG="$PWD/engine-bin/ffmpeg" \
TEST_FFPROBE="$PWD/engine-bin/ffprobe" \
PYTHONPATH=engine engine/.venv/bin/python -m pytest -q \
  engine/tests/test_av_sync.py engine/tests/test_render_timing.py
```

The corrected 1080x1920 example and machine-readable before/after evidence are
saved outside the repository in `../av-sync-verification-20260924/`:
`fixed-clip_00.mp4` and `timing-evidence.json`. The original library files were
preserved. Existing source audio errors, playback-device latency, and behavior
introduced by a social platform are outside what this timestamp fix establishes.
