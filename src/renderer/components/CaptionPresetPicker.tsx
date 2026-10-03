import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Bookmark, Check, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { defaultCaptionStyle, type CustomCaptionPreset } from '../../shared/custom-captions'
import type { CaptionPresetId } from '../../shared/caption-presets'
import { useCaptionStore } from '../store/use-caption-store'
import { useCaptionPreviewStore } from '../store/use-caption-preview-store'
import { useCaptionFavoritesStore } from '../store/use-caption-favorites-store'
import { CaptionFavoriteButton } from './CaptionFavoriteButton'
import { useReorderMotion } from '../hooks/use-reorder-motion'
import { CAPTION_DEMO_DURATION_MS, CAPTION_DEMO_WORDS, CAPTION_LONG_DEMO_DURATION_MS, CAPTION_LONG_DEMO_WORDS } from '../lib/caption-demo'
import { captionColorProgress } from '../lib/caption-preview'
import { captionPreviewGroups } from '../lib/caption-layout'
import captionDemoAudio from '../assets/audio/captions-demo.mp3'
import captionLongDemoAudio from '../assets/audio/captions-demo-longer.mp3'
import { onRadioKeyDown, Segmented } from './ui/Segmented'
import { cn } from '../lib/utils'
import { Button } from './ui/Button'
import './caption-background.css'
import './caption-presets.css'

/**
 * Mirrors the caption presets in engine/clip_engine/config.py closely
 * enough to preview them: typeface, colours, stroke, shadow, glow, pill,
 * plate and karaoke sweep. BridgeClip engine renders with its bundled fonts; the preview
 * uses the same bundled faces, with a system fallback while they load.
 */
export interface CaptionPreset {
  id: string
  name: string
  description: string
  font: string
  weight: number
  italic?: boolean
  size: number
  /** Font size in the engine's 1080px-wide portrait coordinate system. */
  exportSize?: number
  primary: string
  highlight: string
  stroke: number
  outline?: string
  shadow: 'soft' | 'hard' | 'halo' | 'none'
  uppercase: boolean
  /** Rounded pill behind the active word. */
  pill?: string
  /** Blurred bloom around the active word. */
  glow?: string
  /** Translucent plate behind the whole line. */
  plate?: string
  platePaddingX?: number
  platePaddingY?: number
  karaoke?: boolean
  /** How unspoken words look. */
  future?: 'show' | 'dim' | 'hide'
  maxWords?: number
  maxLines?: number | null
  letterSpacing?: number
  entrancePop?: boolean
  colorTransition?: boolean
  dimOpacity?: number
  words: [string, string, string]
}

export const PRESETS: CaptionPreset[] = [
  {
    id: 'pop',
    name: 'Pop',
    description: 'The all-rounder',
    font: '"Montserrat", "Montserrat Black", system-ui, sans-serif',
    weight: 900,
    size: 15,
    primary: '#FFFFFF',
    highlight: '#FFE234',
    stroke: 6,
    shadow: 'soft',
    uppercase: true,
    words: ['this', 'changed', 'everything']
  },
  {
    id: 'spotlight',
    name: 'Spotlight',
    description: 'Word on a pill',
    font: '"Poppins", "Poppins Black", system-ui, sans-serif',
    weight: 900,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 5,
    shadow: 'soft',
    uppercase: true,
    pill: '#7C5CFF',
    words: ['the', 'real', 'secret']
  },
  {
    id: 'impact',
    letterSpacing: 1,
    name: 'Impact',
    description: 'Tall, two words at a time',
    font: '"Anton", "Impact", "Arial Narrow", sans-serif',
    weight: 400,
    size: 21,
    primary: '#FFFFFF',
    highlight: '#FFD60A',
    stroke: 7,
    shadow: 'hard',
    uppercase: true,
    future: 'hide',
    maxWords: 2,
    words: ['ten', 'million', 'views']
  },
  {
    id: 'glow',
    name: 'Glow',
    description: 'Cyan bloom, tech & gaming',
    font: '"Montserrat", "Montserrat ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 15,
    primary: '#FFFFFF',
    highlight: '#7DF9FF',
    stroke: 0,
    shadow: 'halo',
    uppercase: true,
    glow: '#00C8FF',
    words: ['level', 'up', 'now']
  },
  {
    id: 'boxed',
    name: 'Boxed',
    description: 'Readable on any footage',
    font: '"Archivo Black", "Arial Black", system-ui, sans-serif',
    weight: 400,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#FFD23F',
    stroke: 0,
    shadow: 'none',
    uppercase: true,
    plate: 'rgb(0 0 0 / 0.62)',
    words: ['ship it', 'faster', 'today']
  },
  {
    id: 'sweep',
    name: 'Sweep',
    description: 'Colour follows the voice',
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FF5FA2',
    stroke: 5,
    shadow: 'soft',
    uppercase: true,
    karaoke: true,
    maxWords: 4,
    entrancePop: false,
    words: ['sing', 'along', 'now']
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Serif for podcasts & stories',
    font: '"Instrument Serif", "Georgia", serif',
    weight: 400,
    italic: true,
    size: 20,
    primary: '#FFFFFF',
    highlight: '#FFE6B8',
    stroke: 0,
    shadow: 'halo',
    uppercase: false,
    future: 'dim',
    maxWords: 4,
    entrancePop: false,
    dimOpacity: 0.6,
    words: ['and that is', 'why', 'it works']
  },
  {
    id: 'hype',
    colorTransition: true,
    name: 'Hype',
    description: 'Heavy stroke, high energy',
    font: '"Montserrat", "Montserrat Black", system-ui, sans-serif',
    weight: 900,
    size: 16,
    primary: '#FFFFFF',
    highlight: '#39FF6A',
    stroke: 8,
    shadow: 'hard',
    uppercase: true,
    words: ['let’s', 'go', 'now']
  },
  {
    id: 'punch',
    letterSpacing: 1,
    maxWords: 1,
    name: 'Punch',
    description: 'One huge word at a time',
    font: '"Anton", "Impact", "Arial Narrow", sans-serif',
    weight: 400,
    size: 28,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 8,
    shadow: 'hard',
    uppercase: true,
    words: ['', 'boom', '']
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Magenta bloom, music & lifestyle',
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FF9CEB',
    stroke: 0,
    shadow: 'halo',
    uppercase: true,
    glow: '#FF2EC4',
    words: ['feel', 'the', 'beat']
  },
  {
    id: 'headline',
    name: 'Headline',
    description: 'Word on a red news tag',
    font: '"Archivo Black", "Arial Black", system-ui, sans-serif',
    weight: 400,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 4,
    shadow: 'soft',
    uppercase: true,
    pill: '#E5202E',
    words: ['this', 'just', 'in']
  },
  {
    id: 'paper',
    maxWords: 4,
    entrancePop: false,
    name: 'Paper',
    description: 'Dark type on a white card',
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 13,
    primary: '#111111',
    highlight: '#6D28D9',
    stroke: 0,
    shadow: 'none',
    uppercase: false,
    plate: 'rgb(255 255 255 / 0.94)',
    words: ['here is', 'how', 'it works']
  },
  {
    id: 'subtle',
    maxWords: 4,
    entrancePop: false,
    colorTransition: true,
    dimOpacity: 0.55,
    name: 'Subtle',
    description: 'Light touch for interviews & vlogs',
    font: '"Montserrat", "Montserrat ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#C4F1FF',
    stroke: 0,
    shadow: 'halo',
    uppercase: false,
    future: 'dim',
    words: ['I think', 'that’s', 'fair']
  }
]

/** Display names by preset id, for summaries outside the picker. */
export const CAPTION_PRESET_NAMES: Record<string, string> = Object.fromEntries(PRESETS.map((preset) => [preset.id, preset.name]))

/**
 * Preset `size` and `stroke` are tuned for an 84px-tall preview. The compact
 * tile is 60px tall, so samples render at this fraction to keep the same fit.
 */
export function captionPreviewPreset(id: string, custom?: CustomCaptionPreset): CaptionPreset {
  if (!custom) {
    const base = PRESETS.find(p => p.id === id) ?? PRESETS[0]
    return { ...base, exportSize: defaultCaptionStyle(base.id as CaptionPresetId).font_size }
  }
  const s = custom.style
  const font = s.font_name.startsWith('Montserrat') ? '"Montserrat", sans-serif'
    : s.font_name.startsWith('Poppins') ? '"Poppins", sans-serif'
    : s.font_name.startsWith('Instrument') ? '"Instrument Serif", serif' : `"${s.font_name}", sans-serif`
  return { id: custom.id, name: custom.name, description: 'Custom style', font,
    weight: s.font_name.includes('Black') && !s.font_name.includes('Archivo') ? 900 : s.font_name.includes('ExtraBold') ? 800 : 400,
    size: s.font_size * 15 / 84, exportSize: s.font_size,
    shadow: s.shadow_opacity === 0 ? 'none' : s.shadow_blur <= 1 ? 'hard' : s.shadow_spread >= 5 ? 'halo' : 'soft',
    letterSpacing: s.letter_spacing,
    italic: s.italic, primary: s.primary_color, highlight: s.highlight_color, outline: s.outline_color,
    stroke: s.outline_width, uppercase: s.uppercase, maxWords: s.max_words_per_line, maxLines: s.max_lines,
    entrancePop: s.entrance_pop, karaoke: s.karaoke_fill, colorTransition: s.color_transition,
    future: s.future_words, dimOpacity: s.dim_opacity, pill: s.highlight_box_color ?? undefined,
    glow: s.glow_color ?? undefined, platePaddingX: s.line_box_padding_x ?? s.line_box_padding, platePaddingY: s.line_box_padding_y ?? s.line_box_padding,
    words: s.max_words_per_line === 1 ? ['', 'yours', ''] : s.max_words_per_line === 2 ? ['make', 'yours', ''] : ['make', 'it', 'yours'],
    plate: s.line_box_color ? `rgb(${parseInt(s.line_box_color.slice(1, 3), 16)} ${parseInt(s.line_box_color.slice(3, 5), 16)} ${parseInt(s.line_box_color.slice(5, 7), 16)} / ${s.line_box_opacity})` : undefined }
}
const SAMPLE_SCALE = 60 / 84

/** Stroke + shadow as stacked text-shadows, scaled to the tile. */
export function textShadow(p: CaptionPreset, scale = SAMPLE_SCALE): string {
  const layers: string[] = []
  const w = p.stroke * 0.28 * scale
  if (w > 0) {
    for (let a = 0; a < 16; a++) {
      const r = (a / 16) * Math.PI * 2
      layers.push(`${(Math.cos(r) * w).toFixed(2)}px ${(Math.sin(r) * w).toFixed(2)}px 0 ${p.outline ?? '#000'}`)
    }
  }
  if (p.shadow === 'soft') layers.push(`0 ${(w + 1.5).toFixed(2)}px 4px rgb(0 0 0 / 0.6)`)
  if (p.shadow === 'hard') layers.push(`0 ${(w + 2.5).toFixed(2)}px 0 rgb(0 0 0 / 0.9)`)
  if (p.shadow === 'halo') layers.push('0 1px 6px rgb(0 0 0 / 0.85)', '0 0 3px rgb(0 0 0 / 0.6)')
  return layers.join(', ') || 'none'
}

/** Grow the backing without moving words or changing line wrapping. */
export function captionBackgroundStyle(preset: CaptionPreset, scale: number): CSSProperties {
  return { '--caption-background': preset.plate ?? 'transparent',
    '--caption-padding-x': `${(preset.platePaddingX ?? 22) * scale}px`,
    '--caption-padding-y': `${(preset.platePaddingY ?? 22) * scale}px` } as CSSProperties
}

export function CaptionSample({ preset }: { preset: CaptionPreset }): React.JSX.Element {
  const [before, active, after] = preset.words
  const base: CSSProperties = {
    color: preset.primary,
    fontFamily: preset.font,
    fontWeight: preset.weight,
    fontStyle: preset.italic ? 'italic' : 'normal',
    fontSize: preset.size * SAMPLE_SCALE,
    textShadow: textShadow(preset),
    textTransform: preset.uppercase ? 'uppercase' : 'none'
  }

  let activeWord: React.JSX.Element
  if (preset.karaoke) {
    // Show the sweep mid-word; two spans rather than background-clip:text,
    // which the stroke shadow would paint over.
    const at = Math.ceil(active.length * 0.6)
    activeWord = (
      <span>
        <span style={{ color: preset.highlight }}>{active.slice(0, at)}</span>
        {active.slice(at)}
      </span>
    )
  } else if (preset.pill) {
    activeWord = (
      <span
        style={{ background: preset.pill, color: preset.highlight, textShadow: 'none', borderRadius: 4, padding: '1px 3px' }}
      >
        {active}
      </span>
    )
  } else {
    const shadow = textShadow(preset)
    const bloom = preset.glow ? `0 0 4px ${preset.glow}, 0 0 10px ${preset.glow}` : ''
    activeWord = <span style={{ color: preset.highlight, textShadow: [shadow === 'none' ? '' : shadow, bloom].filter(Boolean).join(', ') || 'none' }}>{active}</span>
  }

  const afterStyle: CSSProperties | undefined =
    preset.future === 'dim' ? { opacity: preset.dimOpacity ?? 0.6 } : preset.future === 'hide' ? { visibility: 'hidden' } : undefined
  // Karaoke: words already swept keep the highlight colour.
  const beforeStyle: CSSProperties | undefined = preset.karaoke ? { color: preset.highlight } : undefined

  const line = (
    <>
      {before && <span style={beforeStyle}>{before} </span>}
      {activeWord}
      {after && <span style={afterStyle}> {after}</span>}
    </>
  )

  return (
    <span className="relative block text-center leading-[1.1]" style={base}>
      {preset.plate ? (
        <span className="caption-background inline-block rounded" style={captionBackgroundStyle(preset, preset.size / (preset.exportSize ?? 84))}>
          {line}
        </span>
      ) : (
        line
      )}
    </span>
  )
}

/** A stand-in "frame" behind each sample: a flat, dim video-like tone. */
const SCENE = '#14161d'

// libass sizes the font's OS/2 winAscent + winDescent, rather than the CSS em.
// These ratios come from the same bundled fonts used by caption_generator.py.
function captionFontHeight(font: string): number {
  if (font.includes('Montserrat')) return 1.562
  if (font.includes('Poppins')) return 1.762
  if (font.includes('Anton')) return 1.7334
  if (font.includes('Archivo')) return 1.347
  if (font.includes('Instrument')) return 1.3
  return 1.562
}

export function CaptionMotionPreview({ preset, disabled, labControls = false }: { preset: CaptionPreset; disabled?: boolean; labControls?: boolean }): React.JSX.Element {
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const { audioEnabled, setAudioEnabled, sample, setSample } = useCaptionPreviewStore()
  const longSample = labControls && sample === 'long'
  const demoWords = longSample ? CAPTION_LONG_DEMO_WORDS : CAPTION_DEMO_WORDS
  const demoDuration = longSample ? CAPTION_LONG_DEMO_DURATION_MS : CAPTION_DEMO_DURATION_MS
  const demoAudio = longSample ? captionLongDemoAudio : captionDemoAudio
  const audioRef = useRef<HTMLAudioElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ width: 480, height: 128 })
  const [playRequested, setPlayRequested] = useState(!labControls && !reducedMotion)
  const [playAttempt, setPlayAttempt] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  const [playbackError, setPlaybackError] = useState(false)
  const [duration, setDuration] = useState(demoDuration)
  const [time, setTime] = useState(0)
  const [fontRevision, setFontRevision] = useState(0)
  const exportSize = preset.exportSize ?? defaultCaptionStyle((PRESETS.find(item => item.id === preset.id)?.id ?? 'pop') as CaptionPresetId).font_size
  const fontSize = exportSize / captionFontHeight(preset.font)
  const fontSpec = `${preset.italic ? 'italic ' : ''}${preset.weight} ${fontSize}px ${preset.font}`
  const separator = preset.pill && !preset.karaoke ? '  ' : ' '

  useEffect(() => {
    let live = true
    const refresh = (): void => { if (live) setFontRevision(revision => revision + 1) }
    document.fonts.addEventListener('loadingdone', refresh)
    void document.fonts.load(fontSpec).then(refresh, () => undefined)
    return () => { live = false; document.fonts.removeEventListener('loadingdone', refresh) }
  }, [fontSpec])

  const layout = useMemo(() => {
    const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    if (context) context.font = fontSpec
    const measure = (text: string): number => {
      const shown = preset.uppercase ? text.toUpperCase() : text
      return (context?.measureText(shown).width ?? shown.length * fontSize * .6) + (preset.letterSpacing ?? 0) * shown.length
    }
    return { groups: captionPreviewGroups(demoWords, preset.maxWords ?? 3, preset.maxLines, measure, separator), gap: measure(separator) }
  // Loaded font metrics are different from the system fallback used on first paint.
  }, [demoWords, fontSpec, fontSize, preset.uppercase, preset.letterSpacing, preset.maxWords, preset.maxLines, separator, fontRevision])

  useEffect(() => {
    setDuration(demoDuration)
    setTime(0)
    setPlaybackError(false)
    if (audioRef.current) audioRef.current.currentTime = 0
    if (transcriptRef.current) transcriptRef.current.scrollTop = 0
  }, [demoDuration])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = (): void => setStageSize({ width: stage.clientWidth, height: stage.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    measure()
    return () => observer.disconnect()
  }, [])

  const syncTime = (): void => {
    const audio = audioRef.current
    if (audio) setTime(audio.currentTime * 1000)
  }

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => {
      setReducedMotion(media.matches)
      if (media.matches) {
        audioRef.current?.pause()
        setPlayRequested(false)
      }
    }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    const onVisibilityChange = (): void => {
      // Pause immediately; rendering the hidden state may happen later.
      if (document.hidden) audio?.pause()
      setVisible(!document.hidden)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      audio?.pause()
    }
  }, [])

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = !audioEnabled
  }, [audioEnabled])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!playRequested || disabled || !visible) {
      audio.pause()
      setPlaying(false)
      return
    }
    let cancelled = false
    setPlaybackError(false)
    void audio.play().catch(() => {
      if (cancelled) return
      setPlaying(false)
      setPlayRequested(false)
      setPlaybackError(true)
    })
    return () => {
      cancelled = true
      audio.pause()
    }
  }, [playRequested, playAttempt, disabled, visible, demoAudio])

  useEffect(() => {
    if (!playing || disabled || !visible) return
    let frame = 0
    const tick = (): void => {
      // The media clock owns both sound and captions, including seeks and loops.
      const audio = audioRef.current
      if (audio) setTime(audio.currentTime * 1000)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, disabled, visible])

  const seek = (ms: number): void => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, Math.min(ms, duration)) / 1000
    syncTime()
  }
  const pause = (): void => {
    audioRef.current?.pause()
    setPlayRequested(false)
    setPlaying(false)
  }
  const play = (): void => {
    if (audioRef.current?.ended) seek(0)
    setPlayRequested(true)
    setPlayAttempt((attempt) => attempt + 1)
  }
  const active = Math.max(0, demoWords.findLastIndex((word) => time >= word.start))
  const group = layout.groups.find(item => active >= item.start && active < item.end) ?? layout.groups[0]
  const groupStart = group.start
  const words = demoWords.slice(groupStart, group.end)
  const groupTime = time - words[0].start
  const groupEnd = Math.min(words[words.length - 1].end + 700, demoWords[group.end]?.start ?? duration, duration)
  const activeWord = demoWords[active]
  const activeDuration = (active + 1 < group.end ? demoWords[active + 1].start : groupEnd) - activeWord.start
  const fadeProgress = captionColorProgress(time - activeWord.start, activeDuration, Boolean(preset.colorTransition))
  const wordProgress = Math.max(0, Math.min(1, (time - activeWord.start) / Math.max(1, activeWord.end - activeWord.start)))
  const scale = playing && !reducedMotion && preset.entrancePop !== false && groupTime >= 0 && groupTime < 170
    ? groupTime < 90 ? 0.82 + 0.24 * groupTime / 90 : 1.06 - 0.06 * (groupTime - 90) / 80
    : 1
  // Keep the export's font-to-width ratio at every panel size. Reserve the
  // engine's 60px side margins, and enough height for up to three wrapped rows.
  const frameWidth = Math.max(1, Math.min(stageSize.width - 32, 480, (stageSize.height - 16) * 1080 / (exportSize * 3)))
  const frameScale = frameWidth / 1080
  const shadow = textShadow(preset, frameScale / .28)
  const base: CSSProperties = {
    color: preset.primary, fontFamily: preset.font, fontWeight: preset.weight,
    fontStyle: preset.italic ? 'italic' : 'normal', fontSize: fontSize * frameScale,
    width: 960 * frameScale, lineHeight: `${exportSize * frameScale}px`,
    letterSpacing: preset.maxLines != null ? (preset.letterSpacing ?? 0) * frameScale : undefined,
    textShadow: shadow, textTransform: preset.uppercase ? 'uppercase' : 'none',
    transform: `scale(${scale})`, visibility: groupTime < 0 && (!labControls || playing) || time >= groupEnd ? 'hidden' : undefined
  }

  const renderWord = (index: number): React.JSX.Element => {
    const word = demoWords[index].text
    const state = index === active ? 'active' : index < active ? 'past' : 'future'
    const style: CSSProperties = {
      transition: 'none',
      visibility: !preset.karaoke && state === 'future' && preset.future === 'hide' ? 'hidden' : undefined,
      opacity: !preset.karaoke && state === 'future' && preset.future === 'dim' ? preset.dimOpacity ?? 0.6 : 1,
      // Reserve pill padding on every word so the line stays put as it advances.
      padding: preset.pill && !preset.karaoke ? `0 ${10 * frameScale}px` : undefined,
      marginInline: preset.maxLines != null && preset.pill && !preset.karaoke ? -10 * frameScale : undefined,
      borderRadius: 10 * frameScale
    }
    if (preset.karaoke) {
      // ASS karaoke always dims the unspoken face, including the unswept part
      // of the active word. Its outline stays opaque, regardless of future mode.
      const alpha = (255 - Math.round((1 - (preset.dimOpacity ?? 0.6)) * 255)).toString(16).padStart(2, '0')
      style.color = state === 'past' ? preset.highlight : `${preset.primary}${alpha}`
    } else if (state === 'active') {
      style.color = preset.colorTransition && activeDuration >= 150
        ? `color-mix(in srgb, ${preset.highlight} ${fadeProgress * 100}%, ${preset.primary})`
        : preset.highlight
      if (preset.pill) { style.background = preset.pill; style.textShadow = 'none' }
    }
    if (preset.glow && (state === 'active' || preset.karaoke)) style.textShadow = [shadow === 'none' ? '' : shadow, `0 0 8px ${preset.glow}`, `0 0 18px ${preset.glow}`].filter(Boolean).join(', ')
    return (
      <span key={index} data-caption-state={state} className="relative inline-block whitespace-nowrap" style={style}>
        {word}
        {preset.karaoke && state === 'active' && (
          <span className="absolute inset-0" style={{ color: preset.highlight, textShadow: 'none', clipPath: `inset(0 ${(1 - wordProgress) * 100}% 0 0)` }}>{word}</span>
        )}
      </span>
    )
  }

  useEffect(() => {
    const list = transcriptRef.current
    if (!list) return
    const followLine = (): void => {
      const current = list.querySelector<HTMLElement>('[aria-current="true"]')
      if (!current || list.matches(':hover, :focus-within')) return
      const offset = current.offsetTop
      if (offset < list.scrollTop || offset + current.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = offset
    }
    followLine()
    const observer = new ResizeObserver(followLine)
    observer.observe(list)
    return () => observer.disconnect()
  }, [groupStart, layout.groups])

  return (<>
    <section aria-label="Caption preview" className="mb-3 overflow-hidden rounded-xl border border-white/[0.08]" style={{ background: SCENE }}>
      {!labControls && <div className="flex items-center justify-between gap-2 px-3 pt-3 text-xs">
        <span className="font-semibold text-ink">{preset.name} preview</span>
        <span className="text-2xs text-ink-subtle" role={playbackError ? 'status' : undefined}>{playbackError ? 'Couldn’t play preview' : audioEnabled ? 'Sound on' : 'Sound off'}</span>
      </div>}
      {labControls && playbackError && <p role="status" className="px-3 pt-3 text-xs text-danger">Couldn’t play audio. Try replaying.</p>}
      <div ref={stageRef} aria-hidden="true" className="caption-preview-stage flex h-32 items-center justify-center overflow-hidden px-4">
        <div className="text-center leading-snug" style={base}>
          {preset.maxLines == null ? <span className="caption-background inline-flex max-w-full flex-wrap justify-center gap-x-[0.3em] rounded-md" style={captionBackgroundStyle(preset, frameScale)}>
            {words.map((_, offset) => renderWord(groupStart + offset))}
          </span> : <span className="caption-background inline-flex max-w-full flex-col items-center rounded-md" style={captionBackgroundStyle(preset, frameScale)}>
            {group.lines.map(line => <span key={line.start} data-caption-line className="inline-flex flex-nowrap justify-center whitespace-nowrap" style={{ gap: layout.gap * frameScale, fontSize: line.scale < 1 ? fontSize * frameScale * line.scale : undefined, letterSpacing: line.scale < 1 ? (preset.letterSpacing ?? 0) * frameScale * line.scale : undefined }}>
              {demoWords.slice(line.start, line.end).map((_, offset) => renderWord(line.start + offset))}
            </span>)}
          </span>
          }
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-2 py-2">
        <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label={playing && !disabled ? 'Pause caption preview' : 'Play caption preview'} icon={playing && !disabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} onClick={() => { if (audioRef.current?.paused) play(); else pause() }} />
        <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label="Replay caption preview" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => { seek(0); play() }} />
        <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label={audioEnabled ? 'Mute preview audio' : 'Enable preview audio'} aria-pressed={audioEnabled} title={audioEnabled ? 'Mute preview audio' : 'Enable preview audio'} className={audioEnabled ? 'text-accent' : undefined} icon={audioEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />} onClick={() => {
          // Apply in the user gesture so browsers can permit unmuted playback.
          if (audioRef.current) audioRef.current.muted = audioEnabled
          setAudioEnabled(!audioEnabled)
        }} />
        <input type="range" aria-label="Caption preview position" aria-valuetext={`${(time / 1000).toFixed(1)} seconds`} min={0} max={duration} step={10} value={Math.min(time, duration)} disabled={disabled} className="min-w-0 flex-1 accent-accent" onChange={(event) => { pause(); seek(Number(event.target.value)) }} />
        <span aria-hidden="true" className="w-16 shrink-0 text-right text-2xs tabular-nums text-ink-subtle">{(time / 1000).toFixed(1)} / {(duration / 1000).toFixed(1)}s</span>
      </div>
      <audio ref={audioRef} src={demoAudio} preload="auto" loop muted={!audioEnabled} aria-hidden="true" className="hidden"
        onLoadedMetadata={() => {
          const actualDuration = (audioRef.current?.duration ?? 0) * 1000
          if (Number.isFinite(actualDuration) && actualDuration > 0) setDuration(actualDuration)
          syncTime()
        }}
        onTimeUpdate={syncTime} onSeeked={syncTime}
        onPlaying={() => {
          if (disabled || document.hidden || !playRequested) { audioRef.current?.pause(); return }
          setPlaybackError(false)
          setPlaying(true)
        }}
        onPause={() => { setPlaying(false); syncTime() }}
        onWaiting={() => setPlaying(false)}
        onError={() => { audioRef.current?.pause(); setPlaying(false); setPlayRequested(false); setPlaybackError(true) }} />
    </section>
    {labControls && <section aria-label="Preview text" className="caption-demo-text mt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="eyebrow">Sample text</h4>
        <Segmented label="Preview sample" size="sm" value={sample} options={[{ value: 'short', label: 'Short' }, { value: 'long', label: 'Long' }]} onChange={setSample} />
      </div>
      <div ref={transcriptRef} className="caption-demo-lines relative space-y-1 overflow-y-auto overscroll-contain" role="group" aria-label="Caption lines">
        {layout.groups.map(item => <button key={item.start} type="button" disabled={disabled} aria-current={item.start === groupStart ? true : undefined} title="Jump to this line" onClick={() => seek(demoWords[item.start].start)} className={cn('flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left text-xs transition-colors motion-reduce:transition-none', item.start === groupStart ? 'bg-accent/10 text-ink' : 'text-ink-muted hover:bg-white/[0.04] hover:text-ink')}>
          <span aria-hidden="true" className={cn('w-7 shrink-0 pt-px font-mono text-2xs tabular-nums', item.start === groupStart ? 'text-accent' : 'text-ink-faint')}>{(demoWords[item.start].start / 1000).toFixed(1)}s</span>
          <span>{demoWords.slice(item.start, item.end).map(word => word.text).join(' ')}</span>
        </button>)}
      </div>
    </section>}
  </>)
}

interface CaptionPresetPickerProps {
  value: string
  onChange: (preset: string, custom?: CustomCaptionPreset) => void
  customCaption?: CustomCaptionPreset
  disabled?: boolean
  showPreview?: boolean
}

export function CaptionPresetPicker({ value, customCaption, onChange, disabled, showPreview = false }: CaptionPresetPickerProps): React.JSX.Element {
  const { styles, error, load } = useCaptionStore()
  const favorites = useCaptionFavoritesStore(state => state.favorites)
  const [filter, setFilter] = useState<'all' | 'favorites'>('all')
  const { gridRef: pickerRef, capture } = useReorderMotion()
  useEffect(() => { void load() }, [load])
  const current = captionPreviewPreset(value, customCaption)
  // A draft owns its snapshot: editing or deleting a library style must not
  // quietly change the selected tile or the style that this job will receive.
  const customStyles = customCaption
    ? [customCaption, ...styles.filter(style => style.id !== customCaption.id)]
    : styles
  const allGroups = [
    { label: 'Default', items: PRESETS },
    { label: 'Your styles', items: customStyles.map(style => captionPreviewPreset(style.baseId, style)) }
  ]
  const favoriteCount = allGroups.reduce((count, group) => count + group.items.filter(item => favorites.includes(item.id)).length, 0)
  const groups = allGroups.map(group => ({ ...group, items: group.items
    .filter(item => filter === 'all' || favorites.includes(item.id))
    .sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id))) }))
  const afterBookmark = (): void => {
    if (filter !== 'favorites') return
    // A removed favorite leaves this filtered grid. Keep keyboard focus in the
    // picker instead of dropping it onto the document body.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) pickerRef.current?.querySelector<HTMLButtonElement>('[aria-label="Caption style filter"] [aria-checked="true"]')?.focus()
    })
  }
  return (
    <div ref={pickerRef}>
      {showPreview && <CaptionMotionPreview key={current.id} preset={current} disabled={disabled} />}
      {error && <div role="status" className="mb-2 flex items-center gap-2 text-xs text-warning">{error}<Button size="sm" onClick={() => void load()}>Retry</Button></div>}
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="eyebrow">Styles</p>
        <Segmented label="Caption style filter" size="sm" value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' },
          { value: 'favorites', label: <span className="inline-flex items-center gap-1.5"><Bookmark size={12} />Favorites{favoriteCount > 0 && <span className="font-mono text-2xs text-ink-subtle">{favoriteCount}</span>}</span> }
        ]} />
      </div>
      {filter === 'favorites' && favoriteCount === 0 && <p className="rounded-xl border border-white/[0.06] px-3 py-4 text-xs text-ink-muted">Bookmark a style to find it here. <button type="button" className="ml-1 text-accent hover:underline" onClick={() => setFilter('all')}>Browse all styles</button></p>}
      {groups.filter(group => filter === 'all' || group.items.length > 0).map(group => <div key={group.label} className="mt-3 first:mt-0">
        <p className="eyebrow mb-2">{group.label}</p>
        {group.items.length === 0 ? <p className="text-xs text-ink-subtle">Make your first style in the Captions lab.</p> :
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2" role="radiogroup" aria-label={group.label === 'Default' ? 'Caption style' : 'Your caption styles'}>
            {group.items.map((preset, index) => <CaptionStyleTile key={preset.id} preset={preset} selected={current.id === preset.id} disabled={disabled}
              tabIndex={current.id === preset.id || index === 0 && !group.items.some(item => item.id === current.id) ? 0 : -1}
              beforeBookmark={() => capture(preset.id)} onBookmark={afterBookmark}
              onClick={() => { const custom = customStyles.find(style => style.id === preset.id); onChange(custom?.baseId ?? preset.id, custom) }} />)}
          </div>}
      </div>)}
    </div>
  )
}

export function CaptionStyleTile({ preset, selected, disabled, onClick, tabIndex, onBookmark, beforeBookmark, actions }: { preset: CaptionPreset; selected: boolean; disabled?: boolean; onClick: () => void; tabIndex?: number; onBookmark?: () => void; beforeBookmark?: () => void; actions?: ReactNode }): React.JSX.Element {
  return <div className="caption-style-slot relative min-w-0" data-reorder-key={preset.id}><div className={cn('caption-style-card relative', disabled && 'is-disabled')}>
    <button type="button" role="radio" aria-checked={selected} aria-label={preset.name} aria-description={preset.description}
    title={`${preset.name} · ${preset.description}`} disabled={disabled} tabIndex={tabIndex ?? (selected ? 0 : -1)} onClick={onClick} onKeyDown={onRadioKeyDown}
    className={cn('glass-tile glass-tile-hover group relative w-full min-w-0 rounded-xl p-1 text-left', selected && 'glass-selected', disabled && 'opacity-50')}>
    <span className="relative flex h-[60px] items-end justify-center overflow-hidden rounded-lg px-1.5 pb-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]" style={{ background: SCENE }}>
      <CaptionSample preset={preset} />
      {selected && <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink animate-pop-in"><Check className="h-2.5 w-2.5" strokeWidth={3.5} /></span>}
    </span>
    <span className="block truncate pb-0.5 pl-1.5 pr-7 pt-1.5 text-xs font-semibold text-ink">{preset.name}</span>
    </button>
    {actions && <div className="absolute left-1.5 top-1.5">{actions}</div>}
    <CaptionFavoriteButton id={preset.id} name={preset.name} disabled={disabled} beforeToggle={beforeBookmark} onToggle={onBookmark} className="absolute bottom-0.5 right-0.5 h-6 w-6" />
  </div></div>
}
