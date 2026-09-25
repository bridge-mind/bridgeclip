import { normalizeVideoSource, twitchSourceError } from '../shared/video-source'
import { isAbsolute } from 'path'
import type { ClipJobConfig } from './pipeline-runner'
import { isWebUrl } from './security'
import { DURATION_IDS, isVideoSpeed } from '../shared/job-contract'
import { isModelId } from '../shared/openrouter-models'

export function validateJobConfig(value: unknown): ClipJobConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid job options')
  const v = value as ClipJobConfig
  if (typeof v.videoUrl !== 'string' || v.videoUrl.length > 8192 || !(isWebUrl(v.videoUrl) || isAbsolute(v.videoUrl))) throw new Error('Choose a video file or an HTTP(S) URL')
  const sourceError = twitchSourceError(v.videoUrl)
  if (sourceError) throw new Error(sourceError)
  if (typeof v.autoClipCount !== 'boolean' || typeof v.includeCaptions !== 'boolean') throw new Error('Invalid job options')
  if (typeof v.layoutVision !== 'boolean') throw new Error('Invalid vision option')
  if (v.videoSpeed !== undefined && !isVideoSpeed(v.videoSpeed)) throw new Error('Video speed must be between 1× and 2×')
  if (v.clippingMode !== undefined && !['quality', 'economy', 'advanced'].includes(v.clippingMode)) throw new Error('Invalid clipping mode')
  if (v.clippingMode === 'advanced' && (!isModelId(v.plannerModel) || !isModelId(v.transcriptionModel))) throw new Error('Choose both models in Advanced mode')
  if (v.clippingMode !== 'advanced' && (v.plannerModel !== undefined || v.transcriptionModel !== undefined)) throw new Error('Custom models require Advanced mode')
  if (v.maxClips !== null && (!Number.isInteger(v.maxClips) || v.maxClips < 1 || v.maxClips > 100)) throw new Error('Clip count must be between 1 and 100')
  for (const [key, allowed] of Object.entries({ aspectRatio: ['9:16', '16:9'], layoutStyle: ['auto', 'fill', 'fit'], pacing: ['tight', 'natural'] })) {
    if (!allowed.includes(v[key as keyof ClipJobConfig] as string)) throw new Error(`Invalid ${key}`)
  }
  if (typeof v.captionPreset !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(v.captionPreset)) throw new Error('Invalid caption preset')
  if (v.durationRanges !== null && (!Array.isArray(v.durationRanges) || v.durationRanges.length > DURATION_IDS.length || v.durationRanges.some((item) => !DURATION_IDS.includes(item)))) throw new Error('Invalid clip duration')
  for (const time of [v.startTimeSeconds, v.endTimeSeconds]) {
    if (time !== null && (typeof time !== 'number' || !Number.isFinite(time) || time < 0)) throw new Error('Invalid trim time')
  }
  if (v.endTimeSeconds !== null && v.endTimeSeconds <= (v.startTimeSeconds ?? 0)) throw new Error('Trim end must follow trim start')
  if (v.bannerPlatform !== null && (typeof v.bannerPlatform !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(v.bannerPlatform))) throw new Error('Invalid banner platform')
  if (v.bannerChannelUrl !== null && (!isWebUrl(v.bannerChannelUrl) || v.bannerChannelUrl.length > 8192)) throw new Error('Invalid banner URL')
  // Capabilities are looked up in main after validation, never accepted from the renderer.
  return { ...v, videoUrl: normalizeVideoSource(v.videoUrl), videoSpeed: v.videoSpeed ?? 1, plannerCapabilities: undefined }
}
