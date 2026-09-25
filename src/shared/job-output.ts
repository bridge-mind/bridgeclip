export interface ClipArtifact {
  clip_index: number
  s3_url: string
  duration_ms: number
  start_time_ms: number
  end_time_ms: number
  virality_score: number
  layout_type: string
  summary: string | null
  tags: string[]
  /** Set when smart framing failed and a letterbox fallback produced the clip. */
  render_fallback: string | null
}

export interface JobOutput {
  job_id: string
  source_video_url: string
  source_video_title: string
  source_video_duration_seconds: number
  total_clips: number
  clips: ClipArtifact[]
  transcript_url: string | null
  plan_url: string | null
  processing_time_seconds: number
  metrics: Record<string, unknown> | null
  created_at?: string
  user_id?: string | null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0
}

function safeBox(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 4 ||
    !value.every((part) => finite(part) && part >= 0 && part <= 1)) return null
  return value as number[]
}

function safeShot(value: unknown): Record<string, unknown> | null {
  if (!record(value) || !nonNegative(value.start_ms) || !nonNegative(value.end_ms) ||
    value.end_ms < value.start_ms) return null
  const shot: Record<string, unknown> = { start_ms: value.start_ms, end_ms: value.end_ms }
  for (const field of ['layout', 'source']) {
    const label = boundedText(value[field], 64)
    if (label !== null) shot[field] = label
  }
  for (const field of ['screen_box', 'screen_focus', 'cam_box']) {
    const box = safeBox(value[field])
    if (box) shot[field] = box
  }
  if (Array.isArray(value.people)) shot.people = value.people.slice(0, 8).map(safeBox).filter((box) => box !== null)
  return shot
}

function safeMetrics(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null
  const result: Record<string, unknown> = {}
  if (typeof value.smart_framing_available === 'boolean') result.smart_framing_available = value.smart_framing_available
  if (value.transcription_status === 'available' || value.transcription_status === 'no_speech' || value.transcription_status === 'failed') {
    result.transcription_status = value.transcription_status
  }
  if (value.planning_source === 'visual' || value.planning_source === 'transcript') result.planning_source = value.planning_source
  if (value.captions_status === 'enabled' || value.captions_status === 'disabled_by_request' ||
      value.captions_status === 'unavailable_without_transcript') result.captions_status = value.captions_status
  if (nonNegative(value.visual_frame_count)) result.visual_frame_count = value.visual_frame_count
  if (record(value.requested_settings)) {
    const requested = value.requested_settings
    const safe: Record<string, unknown> = {}
    if (['quality', 'economy', 'advanced'].includes(requested.clipping_mode as string)) safe.clipping_mode = requested.clipping_mode
    for (const field of ['planner_model', 'transcription_model']) {
      const model = boundedText(requested[field], 120)
      if (model !== null) safe[field] = model
    }
    if (requested.aspect_ratio === '9:16' || requested.aspect_ratio === '16:9') safe.aspect_ratio = requested.aspect_ratio
    if (['auto', 'fill', 'fit'].includes(requested.layout_style as string)) safe.layout_style = requested.layout_style
    if (typeof requested.layout_vision_enabled === 'boolean') safe.layout_vision_enabled = requested.layout_vision_enabled
    if (requested.pacing === 'tight' || requested.pacing === 'natural') safe.pacing = requested.pacing
    if (typeof requested.video_speed === 'number' && Number.isFinite(requested.video_speed) && requested.video_speed >= 1 && requested.video_speed <= 2) safe.video_speed = requested.video_speed
    result.requested_settings = safe
  }
  for (const field of ['planned_clip_count', 'rendered_clip_count', 'failed_clip_count', 'uploaded_clip_count',
    'source_video_size_bytes', 'rendered_output_bytes', 'peak_rss_mb', 'analysis_duration_seconds']) {
    if (nonNegative(value[field])) result[field] = value[field]
  }
  const stageDurations = value.stage_durations_seconds
  if (record(stageDurations)) {
    const safe: Record<string, number> = {}
    for (const [name, duration] of Object.entries(stageDurations).slice(0, 20)) {
      if (/^[a-z_]{1,40}$/.test(name) && nonNegative(duration)) safe[name] = duration
    }
    result.stage_durations_seconds = safe
  }
  if (Array.isArray(value.clip_layouts)) {
    result.clip_layouts = value.clip_layouts.slice(0, 1000).flatMap((entry): Record<string, unknown>[] => {
      if (!record(entry) || !Number.isSafeInteger(entry.clip_index) || (entry.clip_index as number) < 0) return []
      const safe: Record<string, unknown> = { clip_index: entry.clip_index }
      const layout = boundedText(entry.layout_type, 64)
      if (layout !== null) safe.layout_type = layout
      if (['smart', 'classic', 'whole_frame_auto', 'fallback'].includes(entry.framing_status as string)) {
        safe.framing_status = entry.framing_status
      }
      if (nonNegative(entry.pacing_removed_ms)) safe.pacing_removed_ms = entry.pacing_removed_ms
      const fallback = boundedText(entry.render_fallback, 64)
      if (fallback !== null) safe.render_fallback = fallback
      if (Array.isArray(entry.shots)) {
        safe.shot_count = entry.shots.length
        safe.shots = entry.shots.slice(0, 256).map(safeShot).filter((shot) => shot !== null)
      }
      return [safe]
    })
  }
  const costs = value.api_costs
  if (record(costs) && finite(costs.total_estimated_cost_usd) && costs.total_estimated_cost_usd >= 0) {
    const safeCosts: Record<string, unknown> = { total_estimated_cost_usd: costs.total_estimated_cost_usd }
    if (typeof costs.cost_incomplete === 'boolean') safeCosts.cost_incomplete = costs.cost_incomplete
    for (const name of ['transcription', 'planning', 'layout_vision']) {
      const section = costs[name]
      if (!record(section)) continue
      const safe: Record<string, unknown> = {}
      if (typeof section.cost_incomplete === 'boolean') safe.cost_incomplete = section.cost_incomplete
      for (const field of ['provider', 'model']) {
        const text = boundedText(section[field], 120)
        if (text !== null) safe[field] = text
      }
      for (const field of ['estimated_cost_usd', 'audio_duration_seconds', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'attempts']) {
        const number = section[field]
        if (nonNegative(number)) safe[field] = number
      }
      safeCosts[name] = safe
    }
    result.api_costs = safeCosts
  }
  return result
}

/** Validate external and persisted pipeline output before it reaches React. */
export function parseJobOutput(value: unknown): JobOutput | null {
  if (!record(value) || !Array.isArray(value.clips) || value.clips.length > 1000) return null
  const clips: ClipArtifact[] = []
  const indices = new Set<number>()
  for (const item of value.clips) {
    if (!record(item) || !Number.isSafeInteger(item.clip_index) || (item.clip_index as number) < 0 ||
      indices.has(item.clip_index as number) || typeof item.s3_url !== 'string' || !item.s3_url.trim() || item.s3_url.length > 8192 ||
      !finite(item.duration_ms) || !finite(item.start_time_ms) || !finite(item.end_time_ms) ||
      !finite(item.virality_score) || item.duration_ms < 0 || item.start_time_ms < 0 ||
      item.end_time_ms < item.start_time_ms) return null
    indices.add(item.clip_index as number)
    clips.push({
      clip_index: item.clip_index as number,
      s3_url: item.s3_url,
      duration_ms: item.duration_ms,
      start_time_ms: item.start_time_ms,
      end_time_ms: item.end_time_ms,
      virality_score: item.virality_score,
      layout_type: typeof item.layout_type === 'string' && ['talking_head', 'two_shot', 'screen_cam', 'screen', 'fit', 'center_crop'].includes(item.layout_type) ? item.layout_type : '',
      summary: boundedText(item.summary, 2048),
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 50).map((tag) => tag.slice(0, 64)) : [],
      render_fallback: boundedText(item.render_fallback, 256)
    })
  }
  return {
    job_id: boundedText(value.job_id, 128) ?? '',
    source_video_url: boundedText(value.source_video_url, 8192) ?? '',
    source_video_title: boundedText(value.source_video_title, 1024) ?? 'Untitled video',
    source_video_duration_seconds: finite(value.source_video_duration_seconds) ? value.source_video_duration_seconds : 0,
    total_clips: clips.length,
    clips,
    transcript_url: boundedText(value.transcript_url, 8192),
    plan_url: boundedText(value.plan_url, 8192),
    processing_time_seconds: finite(value.processing_time_seconds) ? value.processing_time_seconds : 0,
    metrics: safeMetrics(value.metrics),
    ...(typeof value.created_at === 'string' ? { created_at: value.created_at.slice(0, 64) } : {}),
    ...(typeof value.user_id === 'string' ? { user_id: value.user_id.slice(0, 128) } : {})
  }
}
