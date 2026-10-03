const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const fs = require('node:fs')
const { buildSync } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const bundled = buildSync({
  stdin: {
    contents: `export { FormatStep, ClipsStep, CaptionsStep, JobForm, buildJobRequest, parseTrimRange } from './src/renderer/components/JobForm';
      export { ReviewStep } from './src/renderer/components/ReviewStep';
      export { CLIPPING_MODELS } from './src/shared/clipping-modes';
      export { defaultCaptionStyle } from './src/shared/custom-captions';
      export { PRESETS, captionPreviewPreset } from './src/renderer/components/CaptionPresetPicker';
      export { JobProgress } from './src/renderer/components/JobProgress';
      export { SetupCard } from './src/renderer/components/SetupCard';
      export { useSettingsStore } from './src/renderer/store/use-settings-store';
      export { useDraftStore } from './src/renderer/store/use-draft-store';
      export { SourcePicker, isValidSourceLink } from './src/renderer/components/SourcePicker';
      export { framingProblem, sourceAnalysisNotice } from './src/renderer/components/ClipList';
      export { parseJobOutput } from './src/shared/job-output';
      export { twitchVodId, normalizeVideoSource } from './src/shared/video-source';`,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  loader: { '.css': 'empty', '.mp3': 'dataurl' },
  define: { __APP_VERSION__: JSON.stringify(require('../package.json').version) },
  jsx: 'automatic',
  write: false
}).outputFiles[0].text

const form = { exports: {} }
new Function('module', 'exports', 'require', bundled)(form, form.exports, require)
const { FormatStep, JobForm, isValidSourceLink, parseTrimRange, framingProblem, sourceAnalysisNotice, parseJobOutput } = form.exports

test('custom previews keep their appearance when their starting default changes or disappears', () => {
  const { PRESETS, captionPreviewPreset, defaultCaptionStyle } = form.exports
  const custom = { id: 'custom-independent', name: 'Mine', baseId: 'impact', style: defaultCaptionStyle('impact') }
  const original = captionPreviewPreset('impact', custom)
  const index = PRESETS.findIndex(preset => preset.id === 'impact')
  const removed = PRESETS.splice(index, 1)[0]
  try {
    assert.deepEqual(captionPreviewPreset('impact', custom), original)
    assert.deepEqual(captionPreviewPreset('retired-default', { ...custom, baseId: 'retired-default' }), original)
    assert.equal(original.shadow, 'hard')
    assert.equal(original.letterSpacing, 1)
  } finally { PRESETS.splice(index, 0, removed) }
})

test('setup needs only OpenRouter for clipping', () => {
  const { SetupCard, useSettingsStore } = form.exports
  useSettingsStore.setState({ openrouterConfigured: false })
  const setup = renderToStaticMarkup(React.createElement(SetupCard, { onOpenSettings() {} }))
  assert.match(setup, /OpenRouter/)
  assert.doesNotMatch(setup, /ElevenLabs/)
  useSettingsStore.setState({ openrouterConfigured: false, toolStatus: null })
})

test('source picker accepts full HTTP(S) links and rejects malformed or credentialed links', () => {
  assert.equal(isValidSourceLink(' https://www.youtube.com/watch?v=abc '), true)
  assert.equal(isValidSourceLink('http://example.com/video.mp4'), true)
  assert.equal(isValidSourceLink('https://'), false)
  assert.equal(isValidSourceLink('https://user:pass@example.com/video'), false)
  assert.equal(isValidSourceLink('file:///tmp/video.mp4'), false)
})

test('trim validation matches main process bounds, including an end at zero', () => {
  assert.equal(parseTrimRange(true, '', '0').error, 'End must be after the start.')
  assert.equal(parseTrimRange(true, '1:30', '90').error, 'End must be after the start.')
  assert.deepEqual(parseTrimRange(true, '', '1:30'), { start: null, end: 90, error: null })
  assert.deepEqual(parseTrimRange(false, 'oops', '0'), { start: null, end: null, error: null })
})

test('the wizard opens on the video step with the steps listed in order', () => {
  const html = renderToStaticMarkup(React.createElement(JobForm, { onSubmit() {} }))
  const labels = [...html.matchAll(/aria-label="Create steps">(.*?)<\/nav>/gs)][0]?.[1] ?? ''
  const order = ['Video', 'Format', 'Clips', 'Captions', 'Review'].map((label) => labels.indexOf(label))
  assert.ok(order.every((index, i) => index > -1 && (i === 0 || index > order[i - 1])))
  assert.match(html, /aria-current="step"[^>]*>.*?Video/s)
  assert.match(html, /Choose a video/)
  assert.equal(form.exports.useDraftStore.getState().workflow, null)
  const radios = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? []
  assert.equal(radios.length, 2)
  assert.ok(radios.every((radio) => radio.includes('aria-checked="false"')))
  assert.equal(radios.filter((radio) => radio.includes('tabindex="0"')).length, 1)
  assert.match(html, /Beginner friendly/)
  assert.match(html, /For advanced users/)
})

test('a job requires an explicit workflow and each new video resets that choice', () => {
  const { useDraftStore, buildJobRequest } = form.exports
  const original = useDraftStore.getState()
  const trim = { start: null, end: null }
  try {
    original.update({ source: 'https://example.com/video', workflow: null })
    assert.throws(() => buildJobRequest(useDraftStore.getState(), trim), /Choose a workflow/)
    for (const workflow of ['automatic', 'review']) {
      original.update({ workflow })
      original.setStep('format')
      original.setStep('video')
      assert.equal(useDraftStore.getState().workflow, workflow)
      assert.equal(buildJobRequest(useDraftStore.getState(), trim).workflow, workflow)
      original.startAnother()
      assert.equal(useDraftStore.getState().workflow, null)
    }
  } finally { useDraftStore.setState(original) }
})

test('clipping mode is selectable and economy disables paid vision in the submitted request', () => {
  const { ClipsStep, buildJobRequest } = form.exports
  const draft = {
    workflow: 'automatic', source: 'https://example.com/video', clippingMode: 'economy', aspectRatio: '9:16', layoutStyle: 'auto',
    layoutVision: true, pacing: 'tight', durations: ['short'], autoClipCount: true, maxClips: 5,
    includeCaptions: true, captionPreset: 'pop'
  }
  const html = renderToStaticMarkup(React.createElement(ClipsStep, { draft, update() {} }))
  assert.match(html, /aria-label="Clipping mode"/)
  assert.match(html, /Economy/)
  const request = buildJobRequest(draft, { start: null, end: null })
  assert.equal(request.clippingMode, 'economy')
  assert.equal(Object.hasOwn(request, 'debugCapture'), false)
  assert.equal(request.layoutVision, false)
  assert.equal(buildJobRequest({ ...draft, clippingMode: 'quality' }, { start: null, end: null }).layoutVision, true)
})

test('the title card is shown by default and can be turned off for automatic runs', () => {
  const { CaptionsStep, useDraftStore, buildJobRequest } = form.exports
  const original = useDraftStore.getState()
  try {
    assert.equal(original.includeTitle, true)
    original.update({ workflow: 'automatic', source: 'https://example.com/video' })
    const automatic = renderToStaticMarkup(React.createElement(CaptionsStep, { draft: useDraftStore.getState(), update() {} }))
    assert.match(automatic, /Show title at the top/)
    assert.equal(buildJobRequest(useDraftStore.getState(), { start: null, end: null }).includeTitle, true)
    original.update({ includeTitle: false })
    assert.equal(buildJobRequest(useDraftStore.getState(), { start: null, end: null }).includeTitle, false)
    original.startAnother()
    assert.equal(useDraftStore.getState().includeTitle, false)
    // Review exports never draw a title card, so the switch is not offered there.
    const review = renderToStaticMarkup(React.createElement(CaptionsStep, { draft: { ...useDraftStore.getState(), workflow: 'review' }, update() {} }))
    assert.doesNotMatch(review, /Show title at the top/)
  } finally { useDraftStore.setState(original) }
})

test('what to clip is optional, trimmed into the request and cleared for the next video', () => {
  const { ClipsStep, useDraftStore, buildJobRequest } = form.exports
  const original = useDraftStore.getState()
  try {
    assert.equal(original.clipRequest, '')
    original.update({ workflow: 'automatic', source: 'https://example.com/video' })
    const html = renderToStaticMarkup(React.createElement(ClipsStep, { draft: useDraftStore.getState(), update() {} }))
    assert.match(html, /aria-label="What to clip"/)
    assert.match(html, /maxLength="1000"/)
    assert.match(html, /aria-describedby="clip-request-help"/)
    assert.match(html, /id="clip-request-help"[^>]*>Only matching moments are clipped/)
    assert.equal(Object.hasOwn(buildJobRequest(useDraftStore.getState(), { start: null, end: null }), 'clipRequest'), false)
    original.update({ clipRequest: '   ' })
    assert.equal(Object.hasOwn(buildJobRequest(useDraftStore.getState(), { start: null, end: null }), 'clipRequest'), false)
    original.update({ clipRequest: '  every time they talk about pricing \n' })
    assert.equal(buildJobRequest(useDraftStore.getState(), { start: null, end: null }).clipRequest, 'every time they talk about pricing')
    original.startAnother()
    assert.equal(useDraftStore.getState().clipRequest, '')
  } finally { useDraftStore.setState(original) }
})

test('a running job shows what the user asked to clip', () => {
  const { JobProgress } = form.exports
  const job = {
    id: 'job', revision: 1, status: 'planning', percent: 40, step: 'Finding moments', clipsDone: 0, clipsTotal: 0,
    queuedAt: Date.now(), startedAt: Date.now(),
    request: { videoUrl: 'https://www.youtube.com/watch?v=abc123def45', workflow: 'automatic', clipRequest: ' every time they talk about pricing ' }
  }
  const html = renderToStaticMarkup(React.createElement(JobProgress, { job, onCancel() {} }))
  assert.match(html, /title="every time they talk about pricing"><span class="sr-only">What to clip: <\/span>every time they talk about pricing</)
  const plain = renderToStaticMarkup(React.createElement(JobProgress, { job: { ...job, request: { ...job.request, clipRequest: undefined } }, onCancel() {} }))
  assert.doesNotMatch(plain, /What to clip/)
})

test('format and framing radio groups each expose one keyboard tab stop', () => {
  const draft = { aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'tight' }
  const html = renderToStaticMarkup(React.createElement(FormatStep, { draft, update() {} }))
  for (const label of ['Format', 'Framing', 'Video speed']) {
    const group = html.match(new RegExp(`role="radiogroup" aria-label="${label}"[^>]*>(.*?)<\\/div>`, 's'))?.[1]
    assert.ok(group)
    assert.equal((group.match(/tabindex="0"/g) ?? []).length, 1)
  }
})

test('speed survives navigation and another job, and appears in the submitted request', () => {
  const { useDraftStore, buildJobRequest, ClipsStep } = form.exports
  const original = useDraftStore.getState()
  try {
    assert.equal(original.videoSpeed, 1)
    original.update({ workflow: 'automatic', source: 'https://example.com/video', videoSpeed: 1.5 })
    original.setStep('review')
    assert.equal(useDraftStore.getState().step, 'review')
    const lengths = renderToStaticMarkup(React.createElement(ClipsStep, { draft: useDraftStore.getState(), update() {} }))
    assert.match(lengths, /60 seconds becomes about 40 seconds/)
    assert.equal(buildJobRequest(useDraftStore.getState(), { start: 10, end: 70 }).videoSpeed, 1.5)
    original.startAnother()
    assert.equal(useDraftStore.getState().videoSpeed, 1.5)
    assert.equal(useDraftStore.getState().step, 'video')
  } finally { useDraftStore.setState(original) }
})

test('saved run speed is retained while invalid speed metadata is discarded', () => {
  assert.equal(parseJobOutput({ clips: [], metrics: { requested_settings: { video_speed: 1.5 } } }).metrics.requested_settings.video_speed, 1.5)
  for (const video_speed of ['2', null, Infinity, 0, 3]) {
    assert.equal(parseJobOutput({ clips: [], metrics: { requested_settings: { video_speed } } }).metrics.requested_settings.video_speed, undefined)
  }
})

test('advanced selections travel with the job while presets ignore retained custom choices', () => {
  const { ClipsStep, buildJobRequest } = form.exports
  const draft = {
    workflow: 'automatic', source: 'https://example.com/video', clippingMode: 'advanced',
    plannerModel: 'provider/planning', transcriptionModel: 'provider/speech',
    aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'tight',
    durations: ['short'], autoClipCount: true, maxClips: 5, includeCaptions: true, captionPreset: 'pop'
  }
  const html = renderToStaticMarkup(React.createElement(ClipsStep, { draft, update() {} }))
  assert.match(html, /Clip planning model/)
  assert.match(html, /Transcription model/)
  assert.equal((html.match(/role="combobox"/g) ?? []).length, 2)
  const request = buildJobRequest(draft, { start: null, end: null })
  assert.equal(request.plannerModel, 'provider/planning')
  assert.equal(request.transcriptionModel, 'provider/speech')
  assert.equal(request.layoutVision, true)
  for (const clippingMode of ['quality', 'economy']) {
    const preset = buildJobRequest({ ...draft, clippingMode }, { start: null, end: null })
    assert.equal(preset.plannerModel, undefined)
    assert.equal(preset.transcriptionModel, undefined)
  }
})

test('clip list explains when smart framing intentionally keeps the whole frame', () => {
  const clip = (index) => ({
    clip_index: index, s3_url: `/tmp/clip-${index}.mp4`, duration_ms: 5000,
    start_time_ms: index * 5000, end_time_ms: (index + 1) * 5000, virality_score: 0.5
  })
  const output = parseJobOutput({
    clips: [clip(0), clip(1)],
    metrics: { clip_layouts: [
      { clip_index: 0, framing_status: 'whole_frame_auto' },
      { clip_index: 0, framing_status: 'whole_frame_auto' },
      { clip_index: 9, framing_status: 'whole_frame_auto' }
    ] }
  })
  assert.ok(output)
  assert.match(framingProblem(output, true), /whole frame for clip 1/)
  assert.equal(framingProblem(output, false), null)
  const classic = parseJobOutput({ clips: [clip(0)], metrics: {
    smart_framing_available: false, requested_settings: { aspect_ratio: '9:16', layout_style: 'fit' }
  } })
  assert.ok(classic)
  assert.equal(framingProblem(classic, true), null)
})

test('visual-only runs disclose unavailable captions and preserve analysis status', () => {
  const output = parseJobOutput({ clips: [], metrics: {
    transcription_status: 'no_speech', planning_source: 'visual', visual_frame_count: 12,
    captions_status: 'unavailable_without_transcript'
  } })
  assert.ok(output)
  assert.equal(output.metrics.visual_frame_count, 12)
  assert.equal(output.metrics.captions_status, 'unavailable_without_transcript')
  assert.match(sourceAnalysisNotice(output), /No speech was detected/)
})

test('Twitch VOD links canonicalize while other Twitch pages are rejected', () => {
  const { normalizeVideoSource, twitchVodId, SourcePicker } = form.exports
  for (const host of ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv']) {
    const source = `https://${host}/videos/12345/?t=1h&tracking=secret`
    assert.equal(isValidSourceLink(source), true)
    assert.equal(normalizeVideoSource(source), 'https://www.twitch.tv/videos/12345')
    assert.equal(twitchVodId(source), '12345')
  }
  for (const source of ['https://twitch.tv/channel', 'https://clips.twitch.tv/Clip', 'https://player.twitch.tv/?video=123', 'https://twitch.tv/videos/nope', 'https://twitch.tv:8443/videos/123']) assert.equal(isValidSourceLink(source), false)
  assert.equal(twitchVodId('https://twitch.tv.evil.test/videos/123'), null)
  const html = renderToStaticMarkup(React.createElement(SourcePicker, { value: 'https://www.twitch.tv/videos/12345', onChange() {} }))
  assert.match(html, /Twitch VOD/)
  assert.match(html, /Public, completed videos only/)
  assert.doesNotMatch(html, /<img/)
})


test('Review & edit shows required Jev review even when automatic review is off', () => {
  const { ClipsStep, useDraftStore, useSettingsStore } = form.exports
  const original = useSettingsStore.getState()
  const initialState = useSettingsStore.getInitialState()
  const initialJev = initialState.jevEnabled
  try {
    useSettingsStore.setState({ jevEnabled: 'off' })
    initialState.jevEnabled = 'off'
    const draft = useDraftStore.getState()
    const review = renderToStaticMarkup(React.createElement(ClipsStep, { draft: { ...draft, workflow: 'review' }, update() {} }))
    const automatic = renderToStaticMarkup(React.createElement(ClipsStep, { draft: { ...draft, workflow: 'automatic' }, update() {} }))
    assert.match(review, /Jev review required/)
    assert.doesNotMatch(review, /Jev review &amp; repairs off/)
    assert.match(automatic, /Jev review &amp; repairs off/)
    assert.equal(useSettingsStore.getState().jevEnabled, 'off')
  } finally { initialState.jevEnabled = initialJev; useSettingsStore.setState(original) }
})

test('wizard preset models stay in sync with the actual bridge and engine configuration', () => {
  const { CLIPPING_MODELS, ClipsStep, useDraftStore } = form.exports
  const config = fs.readFileSync(path.resolve(__dirname, '../engine/clip_engine/config.py'), 'utf8')
  const bridge = fs.readFileSync(path.resolve(__dirname, '../bridge/bridge_runner.py'), 'utf8')
  assert.equal(config.match(/planner_model: str = "([^"]+)"/)[1], CLIPPING_MODELS.quality.planner)
  assert.equal(bridge.match(/os.environ\["PLANNER_MODEL"\] = "([^"]+)"/)[1], CLIPPING_MODELS.economy.planner)
  assert.ok(config.includes(`return "${CLIPPING_MODELS.economy.transcription}" if self.clipping_mode == "economy" else "${CLIPPING_MODELS.quality.transcription}"`))
  for (const clippingMode of ['quality', 'economy']) {
    const html = renderToStaticMarkup(React.createElement(ClipsStep, { draft: { ...useDraftStore.getState(), clippingMode }, update() {} }))
    assert.ok(html.includes(CLIPPING_MODELS[clippingMode].plannerName))
    assert.ok(html.includes(CLIPPING_MODELS[clippingMode].transcriptionName))
  }
})

test('Review presents the effective request across workflows, modes, framing and caption choices', () => {
  const { ReviewStep, buildJobRequest, useDraftStore } = form.exports
  for (const workflow of ['automatic', 'review']) {
    for (const clippingMode of ['quality', 'economy', 'advanced']) {
      for (const aspectRatio of ['9:16', '16:9']) {
        const request = buildJobRequest({ ...useDraftStore.getState(), workflow, clippingMode, aspectRatio,
          source: 'https://youtu.be/aqz-KE-bpKQ?t=20', layoutStyle: 'auto', layoutVision: true,
          pacing: 'tight', includeTitle: true, videoSpeed: 1.5, durations: ['short', 'medium'],
          autoClipCount: false, maxClips: 7, includeCaptions: false, clipRequest: '  Interview highlights  ',
          plannerModel: 'provider/moments', transcriptionModel: 'provider/speech'
        }, { start: 90, end: 240 })
        const html = renderToStaticMarkup(React.createElement(ReviewStep, { request, onEdit() {} }))
        assert.match(html, /aria-label="YouTube video preview"/)
        assert.match(html, /alt="Video thumbnail"/)
        assert.doesNotMatch(html, /Remove video|>https:\/\/youtu/)
        assert.match(html, /1:30 — 4:00/)
        assert.match(html, /1.5× speed/)
        assert.match(html, /30–60s/)
        assert.match(html, /1–2m/)
        assert.match(html, /Interview highlights/)
        assert.match(html, /Up to <span[^>]*>7<\/span> clips/)
        assert.match(html, /Captions off/)
        assert.equal(html.includes('AI vision'), request.layoutVision)
        assert.equal(html.includes('Cut dead air'), request.pacing === 'tight')
        assert.equal(html.includes('Title shown at the top'), request.includeTitle)
        assert.equal(html.includes('Whole frame'), aspectRatio === '16:9')
        assert.equal(html.includes('Jev review required'), workflow === 'review')
        if (clippingMode === 'advanced') assert.match(html, /provider\/moments/)
        else assert.ok(html.includes(form.exports.CLIPPING_MODELS[clippingMode].plannerName))
      }
    }
  }
})

test('Review names an embedded custom caption style and automatic clip choices', () => {
  const { ReviewStep, buildJobRequest, useDraftStore, defaultCaptionStyle } = form.exports
  const customCaption = { id: 'custom-review', name: 'My studio style', baseId: 'pop', style: defaultCaptionStyle('pop') }
  const request = buildJobRequest({ ...useDraftStore.getState(), workflow: 'automatic', source: '/tmp/source.mp4',
    customCaption, includeCaptions: true, autoClipCount: true, durations: [], includeTitle: false
  }, { start: null, end: null })
  const html = renderToStaticMarkup(React.createElement(ReviewStep, { request, onEdit() {} }))
  assert.match(html, /My studio style/)
  assert.match(html, /Your style/)
  assert.match(html, /Let AI decide/)
  assert.match(html, /15–90s · Auto length/)
  assert.match(html, /Title overlay off/)
  assert.doesNotMatch(html, /Preferred range/)
  for (const label of ['video', 'format', 'clips', 'captions', 'mode']) assert.ok(html.includes(`aria-label="Edit ${label}"`))
})
