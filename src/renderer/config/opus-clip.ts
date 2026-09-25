/**
 * OpusClip's published numbers, for comparing a run with OpusClip. Checked on
 * 2026-09-24. Update the numbers and `checked` together when they change.
 *
 * - Price: Pro is $29 a month for 300 credits (https://www.opus.pro/pricing).
 *   One credit is one minute of source video; partial minutes round down and
 *   a video costs at least one credit. Only the selected timeframe is charged:
 *   https://help.opus.pro/docs/article/how-are-credits-consumed.
 * - Speed: "The processing time depends on the length of your raw video,
 *   typically taking around 20-40 minutes"
 *   (https://help.opus.pro/docs/article/clipanything-qa-4). This is a published
 *   reference, not a benchmark of the same video on both services.
 */
export const OPUS_CLIP = {
  checked: 'Sep 2026',
  usdPerCredit: 29 / 300,
  priceTerms: 'Pro, $29 for 300 credits',
  processingMinutes: 20,
  processingTerms: '20–40 minutes'
} as const

/** Older runs do not record their trim window; do not assume the full source. */
export function comparisonDurationSeconds(sourceSeconds: number, analysisSeconds: unknown): number | null {
  return Number.isFinite(sourceSeconds) && typeof analysisSeconds === 'number' &&
    Number.isFinite(analysisSeconds) && analysisSeconds > 0 && analysisSeconds <= sourceSeconds
    ? analysisSeconds : null
}

/** Credits for a source video: one per whole minute, at least one. */
export function opusClipCredits(sourceSeconds: number): number {
  return Math.max(1, Math.floor(Math.max(0, sourceSeconds) / 60))
}

/** What OpusClip would charge for the source video, or null without a length. */
export function opusClipCostUsd(sourceSeconds: number): number | null {
  if (!Number.isFinite(sourceSeconds) || sourceSeconds <= 0) return null
  return opusClipCredits(sourceSeconds) * OPUS_CLIP.usdPerCredit
}

/** Whole percent this run cost less than OpusClip, or null when it didn't. */
export function percentLessThanOpusClip(runUsd: number, sourceSeconds: number): number | null {
  const theirs = opusClipCostUsd(sourceSeconds)
  if (theirs === null || !Number.isFinite(runUsd) || runUsd < 0 || runUsd >= theirs) return null
  const percent = Math.floor((1 - runUsd / theirs) * 100)
  return percent > 0 ? percent : null
}

/**
 * How many times faster this run was than OpusClip's typical processing, or
 * null when it wasn't clearly faster. OpusClip's time depends on video length,
 * so only a run that analyzed at least as much video as the typical time can
 * be compared with it (a 1-minute clip is not "20× faster").
 */
export function timesFasterThanOpusClip(processingSeconds: number, analyzedSeconds: number | null): number | null {
  if (!Number.isFinite(processingSeconds) || processingSeconds <= 0) return null
  if (analyzedSeconds === null || !Number.isFinite(analyzedSeconds) || analyzedSeconds < OPUS_CLIP.processingMinutes * 60) return null
  const times = (OPUS_CLIP.processingMinutes * 60) / processingSeconds
  return times >= 1.1 ? times : null
}

/** "5×", "1.8×", "12×". */
export function formatTimes(times: number): string {
  return `${times >= 10 ? Math.floor(times) : Math.floor(times * 10) / 10}×`
}
