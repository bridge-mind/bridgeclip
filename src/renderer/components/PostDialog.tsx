import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowUpRight, CalendarClock, Check, Inbox, Loader2, Play, Search, Send, Share2, X } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, localFileUrl } from '../lib/utils'
import { loadThumbnail } from '../lib/thumbnails'
import { useSettingsStore } from '../store/use-settings-store'
import { ensureAccountsLoaded, useAccountsStore } from '../store/use-accounts-store'
import { usePostsStore } from '../store/use-posts-store'
import { isPostableAccount, isZernioPlatform, ZERNIO_PLATFORMS, type ZernioAccount, type ZernioPlatform } from '../../shared/zernio'
import {
  EMPTY_TIKTOK_ACCOUNT,
  PLATFORM_RULES,
  TIKTOK_PRIVACY_LABELS,
  YOUTUBE_TITLE_MAX,
  captionLength,
  checkCaption,
  checkClip,
  defaultCaption,
  defaultFacebookFormat,
  formatClipDuration,
  scheduleError,
  scheduleWindow,
  sharedCommercialTypes,
  tiktokConsentText,
  tiktokOptionsError,
  youtubeTitleFor,
  type ClipMediaInfo,
  type FacebookFormat,
  type PostClipResult,
  type PostProgress,
  type PostRecordTarget,
  type TikTokAccountOptions,
  type TikTokCreatorInfo,
  type TikTokPostOptions,
  type YouTubePostOptions,
  type YouTubeVisibility
} from '../../shared/zernio-posts'
import { PlatformIcon, platformName } from './PlatformIcon'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { Switch } from './ui/Switch'
import { Select, TextArea, TextInput, WELL } from './ui/Field'
import { ProgressBar } from './ui/ProgressBar'
import { Badge } from './ui/Badge'
import { Callout } from './ui/Callout'
import { Dialog, DialogFooter } from './ui/Dialog'
import { IconTile } from './ui/IconTile'
import { Segmented } from './ui/Segmented'
import type { Page } from './Sidebar'

export interface PostableClip {
  path: string
  title: string
  tags: string[]
  durationMs: number
}

interface PostDialogProps {
  /** One clip, or several posted one after another with the same accounts and options. */
  clips: PostableClip[]
  onClose: () => void
  onNavigate?: (page: Page) => void
}

type Phase = 'editing' | 'sending' | 'done'
type CreatorInfoState = TikTokCreatorInfo | { error: string } | 'loading'

/** Past this many accounts the picker gets a search box. */
const SEARCH_ACCOUNTS_AT = 8

export const EMPTY_TIKTOK: TikTokPostOptions = {
  accounts: {},
  disclose: false,
  yourBrand: false,
  brandedContent: false,
  madeWithAi: false,
  draft: false,
  consent: false
}

function newAttemptId(): string {
  return crypto.randomUUID()
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function zoneName(at: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/** `YYYY-MM-DDTHH:mm` in local time, the value format of <input type="datetime-local">. */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** An hour from now, rounded up to the next quarter hour. */
function defaultScheduleValue(): string {
  const quarter = 15 * 60_000
  return toLocalInput(Math.ceil((Date.now() + 60 * 60_000) / quarter) * quarter)
}

export function formatScheduled(iso: string, timeZone?: string | null): string {
  const at = Date.parse(iso)
  const text = new Date(at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const zone = timeZone && timeZone !== localTimeZone() ? ` (${zoneName(at, timeZone) || timeZone})` : ''
  return `${text}${zone}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function accountHandle(account: Pick<ZernioAccount, 'username' | 'displayName'>): string {
  return account.username ? `@${account.username}` : account.displayName ?? 'Connected account'
}

function isCreatorInfo(value: CreatorInfoState | undefined): value is TikTokCreatorInfo {
  return typeof value === 'object' && value !== null && 'privacyLevels' in value
}

export function PostDialog({ clips, onClose, onNavigate }: PostDialogProps): React.JSX.Element {
  const zernioConfigured = useSettingsStore((s) => s.zernioConfigured)
  const { accounts, profiles, loaded: accountsLoaded, loading: accountsLoading, error: accountsError, load: loadAccounts } = useAccountsStore()

  const [index, setIndex] = useState(0)
  const clip = clips[index]
  const [attemptId, setAttemptId] = useState(newAttemptId)
  const attemptRef = useRef(attemptId)
  attemptRef.current = attemptId

  // Per clip.
  const [media, setMedia] = useState<ClipMediaInfo | null>(null)
  const [thumb, setThumb] = useState<string | null>(null)
  const [caption, setCaption] = useState(() => defaultCaption(clip.title, clip.tags))
  const [youtube, setYoutube] = useState<YouTubePostOptions>(() => ({ title: youtubeTitleFor(clip.title) || 'Untitled clip', visibility: 'public', madeForKids: false }))
  const [phase, setPhase] = useState<Phase>('editing')
  const [progress, setProgress] = useState<PostProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PostClipResult | null>(null)

  // Kept across clips in a batch.
  const [selected, setSelected] = useState<string[]>([])
  const [tiktok, setTiktok] = useState<TikTokPostOptions>(EMPTY_TIKTOK)
  const [creatorInfo, setCreatorInfo] = useState<Record<string, CreatorInfoState>>({})
  const [shareToFeed, setShareToFeed] = useState(true)
  const [facebookFormat, setFacebookFormat] = useState<FacebookFormat | null>(null)
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [scheduleValue, setScheduleValue] = useState(defaultScheduleValue)
  const [now, setNow] = useState(() => Date.now())

  const dialogRef = useRef<HTMLDivElement>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const titleId = useId()

  // Cached accounts show at once; Zernio is asked again when they're over a minute old.
  useEffect(() => {
    if (zernioConfigured) void ensureAccountsLoaded()
  }, [zernioConfigured])

  // Keep "at least 5 minutes from now" honest while the dialog stays open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    setMedia(null)
    setThumb(null)
    getApi().zernio.posts.probe(clip.path, clip.durationMs)
      .then((info) => { if (!cancelled) setMedia(info) })
      .catch(() => { if (!cancelled) setMedia({ durationMs: clip.durationMs, width: null, height: null, sizeBytes: 0 }) })
    loadThumbnail(clip.path, clip.durationMs > 0 ? clip.durationMs / 2000 : undefined).then((path) => { if (!cancelled) setThumb(path) })
    return () => { cancelled = true }
  }, [clip.path, clip.durationMs])

  useEffect(() => getApi().zernio.posts.onProgress((update) => {
    if (update.attemptId === attemptRef.current) setProgress(update)
  }), [])

  // Every account in every Zernio profile, grouped by platform. A profile holds
  // one account per platform, so several TikToks means several profiles.
  const profileNames = useMemo(() => new Map(profiles.map((p) => [p.id, p.name])), [profiles])
  const postable = useMemo(
    () => accounts.filter((a) => isZernioPlatform(a.platform)).sort((a, b) =>
      ZERNIO_PLATFORMS.indexOf(a.platform as ZernioPlatform) - ZERNIO_PLATFORMS.indexOf(b.platform as ZernioPlatform) ||
      (profileNames.get(a.profileId ?? '') ?? '').localeCompare(profileNames.get(b.profileId ?? '') ?? '') ||
      accountHandle(a).localeCompare(accountHandle(b))),
    [accounts, profileNames]
  )
  // An account disconnected while this dialog was open cannot remain selected.
  useEffect(() => {
    const availableIds = new Set(postable.map((account) => account.id))
    setSelected((current) => current.every((id) => availableIds.has(id)) ? current : current.filter((id) => availableIds.has(id)))
  }, [postable])
  const selectedAccounts = postable.filter((a) => selected.includes(a.id) && isPostableAccount(a))
  const unavailableSelected = selected.filter((id) => !selectedAccounts.some((account) => account.id === id))
  const platforms = [...new Set(selectedAccounts.map((a) => a.platform as ZernioPlatform))]
  const has = (platform: ZernioPlatform): boolean => platforms.includes(platform)
  const accountLabel = (id: string): string => {
    const account = postable.find((a) => a.id === id)
    return account ? `${platformName(account.platform)} ${accountHandle(account)}` : 'Account'
  }

  // Facebook defaults to a Reel when the clip qualifies.
  const fbFormat: FacebookFormat = facebookFormat ?? (media ? defaultFacebookFormat(media) : 'feed')

  // TikTok creator info, fetched once per selected TikTok account for this
  // dialog, and only for selected ones (60 requests a minute on the free tier).
  const tiktokAccounts = selectedAccounts.filter((a) => a.platform === 'tiktok')
  const tiktokIds = tiktokAccounts.map((a) => a.id).join(',')
  const businessTikTokIds = tiktokAccounts.filter((a) => a.integrationLane === 'business').map((a) => a.id).join(',')
  const requested = useRef(new Set<string>())
  const [creatorInfoRetry, setCreatorInfoRetry] = useState(0)
  useEffect(() => {
    for (const id of tiktokIds ? tiktokIds.split(',') : []) {
      if (requested.current.has(id)) continue
      requested.current.add(id)
      setCreatorInfo((state) => ({ ...state, [id]: 'loading' }))
      getApi().zernio.posts.tiktokCreatorInfo(id)
        .then((info) => setCreatorInfo((state) => ({ ...state, [id]: info })))
        .catch((err) => setCreatorInfo((state) => ({ ...state, [id]: { error: errorMessage(err, 'Could not load TikTok settings.') } })))
    }
  }, [tiktokIds, creatorInfoRetry])

  const { tiktokInfos, tiktokReady, tiktokError } = useMemo(() => {
    const states = (tiktokIds ? tiktokIds.split(',') : []).map((id) => creatorInfo[id])
    const infos = states.filter(isCreatorInfo)
    return {
      tiktokInfos: infos,
      tiktokReady: infos.length === states.length,
      tiktokError: states.find((s): s is { error: string } => typeof s === 'object' && s !== null && 'error' in s)?.error ?? null
    }
  }, [tiktokIds, creatorInfo])

  const retryTikTok = (id: string): void => {
    requested.current.delete(id)
    setCreatorInfo((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setCreatorInfoRetry((revision) => revision + 1)
  }

  // A privacy choice an account doesn't offer, "Only me" once branded
  // content is on, or a private direct video on a Business connection is
  // cleared, never swapped for another value.
  useEffect(() => {
    const cleared: Record<string, TikTokAccountOptions> = {}
    for (const info of tiktokInfos) {
      const choice = tiktok.accounts[info.accountId]
      if (!choice?.privacyLevel) continue
      const offered = info.privacyLevels.some((l) => l.value === choice.privacyLevel)
      const privateBranded = choice.privacyLevel === 'SELF_ONLY' && tiktok.disclose && tiktok.brandedContent
      const businessDirectPrivate = !tiktok.draft && choice.privacyLevel !== 'PUBLIC_TO_EVERYONE' &&
        businessTikTokIds.split(',').includes(info.accountId)
      if (!offered || privateBranded || businessDirectPrivate) cleared[info.accountId] = { ...choice, privacyLevel: '' }
    }
    if (Object.keys(cleared).length > 0) setTiktok((t) => ({ ...t, accounts: { ...t.accounts, ...cleared } }))
  }, [tiktokInfos, tiktok, businessTikTokIds])

  const clipCheck = (platform: ZernioPlatform, accountId?: string): ReturnType<typeof checkClip> | null => {
    if (!media) return null
    const info = accountId ? creatorInfo[accountId] : undefined
    return checkClip(platform, media, {
      tiktokMaxSec: isCreatorInfo(info) ? info.maxVideoDurationSec : null,
      facebookFormat: platform === 'facebook' ? fbFormat : undefined
    })
  }

  const scheduledAt = mode === 'schedule' ? new Date(scheduleValue).getTime() : NaN
  const scheduleProblem = mode === 'schedule' ? scheduleError(scheduledAt, now) : null
  const bounds = scheduleWindow(now)

  const captionProblems = platforms.map((p) => ({ platform: p, ...checkCaption(p, caption) }))
  const youtubeProblem = has('youtube')
    ? !youtube.title.trim() ? 'Add a YouTube title.' : [...youtube.title.trim()].length > YOUTUBE_TITLE_MAX ? `YouTube titles can be at most ${YOUTUBE_TITLE_MAX} characters.` : /[<>]/.test(youtube.title) ? 'YouTube titles can’t contain < or >.' : null
    : null

  const issues: string[] = []
  if (unavailableSelected.length > 0) issues.push('A selected account is no longer available. Remove it or reconnect it on the Accounts page.')
  if (selectedAccounts.length === 0) issues.push('Choose at least one account.')
  if (!media) issues.push('Checking the clip…')
  for (const platform of platforms) {
    if (platform === 'tiktok') {
      for (const account of tiktokAccounts) {
        const blocking = clipCheck('tiktok', account.id)?.blocking
        if (blocking) issues.push(tiktokAccounts.length > 1 ? `${accountLabel(account.id)}: ${blocking}` : blocking)
      }
      continue
    }
    const blocking = clipCheck(platform)?.blocking
    if (blocking) issues.push(blocking)
  }
  for (const problem of captionProblems) if (problem.error) issues.push(problem.error)
  if (youtubeProblem) issues.push(youtubeProblem)
  if (has('tiktok')) {
    if (tiktokError) issues.push(tiktokError)
    else if (!tiktokReady) issues.push('Loading TikTok settings…')
    else {
      const problem = tiktokOptionsError(tiktok, tiktokInfos, accountLabel)
      if (problem) issues.push(problem)
      for (const account of tiktokAccounts) {
        const privacy = tiktok.accounts[account.id]?.privacyLevel
        if (account.integrationLane === 'business' && !tiktok.draft && privacy && privacy !== 'PUBLIC_TO_EVERYONE') {
          issues.push(`${accountLabel(account.id)}: TikTok Business connections can post videos directly to Everyone only. Choose Everyone or send to your TikTok inbox.`)
        }
      }
    }
  }
  if (scheduleProblem) issues.push(scheduleProblem)
  const ready = issues.length === 0 && phase === 'editing'

  const submit = async (): Promise<void> => {
    if (!ready) return
    setPhase('sending')
    setError(null)
    setProgress(null)
    try {
      const outcome = await getApi().zernio.posts.publish({
        attemptId,
        clipPath: clip.path,
        clipTitle: clip.title,
        durationMs: clip.durationMs,
        caption,
        targets: selectedAccounts.map((a) => ({ platform: a.platform as ZernioPlatform, accountId: a.id })),
        timing: mode === 'now' ? { mode: 'now' } : { mode: 'schedule', scheduledFor: new Date(scheduledAt).toISOString(), timezone: localTimeZone() },
        options: {
          ...(has('tiktok') ? { tiktok } : {}),
          ...(has('youtube') ? { youtube: { ...youtube, title: youtube.title.trim() } } : {}),
          ...(has('instagram') ? { instagram: { shareToFeed } } : {}),
          ...(has('facebook') ? { facebook: { format: fbFormat } } : {})
        }
      })
      if (outcome.post) usePostsStore.getState().upsert(outcome.post)
      setResult(outcome)
      setPhase('done')
    } catch (err) {
      setError(errorMessage(err, 'Could not post the clip.'))
      setPhase('editing')
    }
  }

  /** After a failed post, go back to the form. The upload is kept for the next try. */
  const editAgain = (): void => {
    setResult(null)
    setPhase('editing')
  }

  const nextClip = (): void => {
    const next = clips[index + 1]
    if (!next) return
    setIndex(index + 1)
    setAttemptId(newAttemptId())
    setCaption(defaultCaption(next.title, next.tags))
    setYoutube((y) => ({ ...y, title: youtubeTitleFor(next.title) || 'Untitled clip' }))
    // TikTok's consent covers one piece of content.
    setTiktok((t) => ({ ...t, consent: false }))
    setFacebookFormat(null)
    setResult(null)
    setError(null)
    setProgress(null)
    setPhase('editing')
  }

  const close = useCallback((): void => {
    if (phaseRef.current !== 'sending') onClose()
  }, [onClose])

  const goToAccounts = (): void => {
    onClose()
    onNavigate?.('accounts')
  }

  const viewPosts = (): void => {
    usePostsStore.getState().requestReveal()
    goToAccounts()
  }

  // Focus trap and Escape, as in UpdateModal.
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    dialog?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [close])

  const sending = phase === 'sending'
  const uploading = sending && progress?.phase !== 'publishing'
  const percent = progress && progress.total > 0 ? (progress.transferred / progress.total) * 100 : 0

  let body: ReactNode
  if (!zernioConfigured) {
    body = (
      <SetupPrompt
        title="Connect your social accounts"
        description="Add your Zernio API key on the Accounts page, connect TikTok, YouTube, Instagram and more, then post clips from here."
        action={onNavigate ? <Button variant="primary" onClick={goToAccounts}>Go to Accounts</Button> : <p className="text-xs text-ink-subtle">Open Accounts in the sidebar.</p>}
      />
    )
  } else if (!accountsLoaded) {
    body = (
      <div className="flex items-center justify-center gap-3 px-4 py-8 text-sm text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin text-accent-hover" />
        Loading your Zernio accounts…
      </div>
    )
  } else if (accountsError && postable.length === 0) {
    body = (
      <SetupPrompt
        title="Couldn’t load your accounts"
        description={accountsError.message}
        action={<Button onClick={() => void loadAccounts()} loading={accountsLoading}>Try again</Button>}
      />
    )
  } else if (postable.length === 0) {
    body = (
      <SetupPrompt
        title="No accounts connected yet"
        description="Connect TikTok, YouTube, Instagram or another platform on the Accounts page to post this clip."
        action={onNavigate ? <Button variant="primary" onClick={goToAccounts}>Connect accounts</Button> : <p className="text-xs text-ink-subtle">Open Accounts in the sidebar.</p>}
      />
    )
  } else if (phase === 'done' && result) {
    body = <ResultView result={result} />
  } else {
    body = (
      <div className={cn('space-y-5 px-4 py-4 transition-opacity duration-200', sending && 'pointer-events-none opacity-60')} aria-busy={sending}>
        <Section
          title="Post to"
          aside={selectedAccounts.length > 0 && <span className="rounded-full bg-accent/[0.14] px-2 py-0.5 text-2xs font-medium text-accent-hover">{selectedAccounts.length} selected</span>}
        >
          {accountsError && <p className="mb-2.5 text-xs text-warning">{accountsError.message} These are the accounts Zernio reported last.</p>}
          <AccountPicker
            accounts={postable}
            selected={selected}
            onChange={setSelected}
            profileName={(account) => (profiles.length > 1 && account.profileId ? profileNames.get(account.profileId) ?? null : null)}
            reasonFor={(account) => {
              if (!isPostableAccount(account)) {
                return account.needsReconnect ? 'Reconnect this account on the Accounts page first.'
                  : !account.isActive ? 'This account is inactive in Zernio.'
                  : 'Zernio reports this account can’t post right now. Check it on the Accounts page.'
              }
              // Facebook can switch to a feed video, so its limits show in its own section.
              return account.platform === 'facebook' ? null : clipCheck(account.platform as ZernioPlatform, account.id)?.blocking ?? null
            }}
          />
        </Section>

        <CaptionField caption={caption} onChange={setCaption} problems={captionProblems} />

        {has('youtube') && (
          <PlatformSection platform="youtube" notes={clipCheck('youtube')?.notes}>
            <YouTubeFields value={youtube} onChange={setYoutube} problem={youtubeProblem} />
          </PlatformSection>
        )}

        {has('tiktok') && (
          <PlatformSection
            platform="tiktok"
            subtitle={tiktokAccounts.length > 1 ? `${tiktokAccounts.length} accounts` : undefined}
            notes={clipCheck('tiktok')?.notes}
          >
            {tiktokAccounts.map((account) => (
              <TikTokAccountFields
                key={account.id}
                heading={tiktokAccounts.length > 1 || profiles.length > 1
                  ? [accountHandle(account), account.profileId && profiles.length > 1 ? profileNames.get(account.profileId) : null].filter(Boolean).join(' · ')
                  : null}
                state={creatorInfo[account.id]}
                value={tiktok.accounts[account.id] ?? EMPTY_TIKTOK_ACCOUNT}
                onChange={(value) => setTiktok((t) => ({ ...t, accounts: { ...t.accounts, [account.id]: value } }))}
                brandedContent={tiktok.disclose && tiktok.brandedContent}
                draft={tiktok.draft}
                businessConnection={account.integrationLane === 'business'}
                onRetry={() => retryTikTok(account.id)}
              />
            ))}
            <TikTokSharedFields value={tiktok} onChange={setTiktok} commercialTypes={sharedCommercialTypes(tiktokInfos)} />
          </PlatformSection>
        )}

        {has('instagram') && (
          <PlatformSection platform="instagram" notes={clipCheck('instagram')?.notes}>
            <SwitchRow
              checked={shareToFeed}
              onChange={setShareToFeed}
              label="Also show on your profile grid"
              description="Off keeps the Reel in the Reels tab only."
            />
          </PlatformSection>
        )}

        {has('facebook') && media && (
          <PlatformSection platform="facebook" notes={clipCheck('facebook')?.blocking ? [] : clipCheck('facebook')?.notes}>
            <FacebookFields media={media} value={fbFormat} onChange={setFacebookFormat} />
          </PlatformSection>
        )}

        <WhenField
          mode={mode}
          onModeChange={setMode}
          value={scheduleValue}
          onValueChange={setScheduleValue}
          min={toLocalInput(bounds.min)}
          max={toLocalInput(bounds.max)}
          problem={scheduleProblem}
        />
      </div>
    )
  }

  const showForm = zernioConfigured && accountsLoaded && postable.length > 0 && phase !== 'done'
  const outcome = result?.outcome

  return (
    <Dialog ref={dialogRef} aria-labelledby={titleId} onBackdropMouseDown={close} panelClassName="max-w-[640px]">
      <div className="relative flex items-start gap-3 border-b border-white/[0.07] px-4 py-4">
        <ClipPreview path={clip.path} thumb={thumb} vertical={media ? (media.height ?? 0) > (media.width ?? 0) : true} />
        <div className="relative min-w-0 flex-1 pt-0.5">
          <p className="eyebrow">{clips.length > 1 ? `Post clip ${index + 1} of ${clips.length}` : 'Post clip'}</p>
          <h2 id={titleId} className="mt-1.5 line-clamp-2 text-lg font-semibold leading-snug tracking-[-0.01em] text-ink" title={clip.title}>
            {clip.title}
          </h2>
          <p className="mt-2 flex flex-wrap gap-1.5 font-mono text-2xs tabular text-ink-muted">
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5">{media?.durationMs != null ? formatClipDuration(media.durationMs / 1000) : '–:––'}</span>
            {media?.width && media.height ? <span className="rounded-full bg-white/[0.06] px-2 py-0.5">{media.width}×{media.height}</span> : null}
            {media && media.sizeBytes > 0 ? <span className="rounded-full bg-white/[0.06] px-2 py-0.5">{formatBytes(media.sizeBytes)}</span> : null}
          </p>
        </div>
        <Button variant="ghost" size="sm" iconOnly aria-label="Close" onClick={close} disabled={sending} className="relative" icon={<X className="h-4 w-4" />} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>

      {showForm && (
        <div className="border-t border-white/[0.07] bg-black/20 px-4 py-3">
          {error && (
            <Callout tone="danger" className="mb-3">
              {error}
            </Callout>
          )}
          {sending ? (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1" aria-live="polite">
                {uploading ? (
                  <>
                    <ProgressBar value={percent} className="h-2" />
                    <p className="mt-2 flex justify-between font-mono text-2xs tabular text-ink-subtle">
                      <span>Uploading to Zernio · {Math.round(percent)}%</span>
                      {progress && progress.total > 0 && <span>{formatBytes(progress.transferred)} / {formatBytes(progress.total)}</span>}
                    </p>
                  </>
                ) : (
                  <p className="flex items-center gap-2 text-sm text-ink-muted">
                    <Loader2 className="h-4 w-4 animate-spin text-accent-hover" />
                    {mode === 'now' ? `Publishing to ${selectedAccounts.length} account${selectedAccounts.length === 1 ? '' : 's'}…` : 'Scheduling…'}
                  </p>
                )}
              </div>
              {uploading && (
                <Button variant="ghost" onClick={() => void getApi().zernio.posts.cancelUpload(attemptId)}>
                  Cancel upload
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <p className={cn('min-w-0 flex-1 truncate text-xs', issues[0] ? 'text-ink-muted' : 'text-ink-subtle')} title={issues[0]}>
                {issues[0] ?? (mode === 'now' ? 'Publishes right away.' : `Publishes ${formatScheduled(new Date(scheduledAt).toISOString())}.`)}
              </p>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!ready}
                onClick={() => void submit()}
                icon={mode === 'now' ? <Send className="h-3.5 w-3.5" /> : <CalendarClock className="h-3.5 w-3.5" />}
              >
                {mode === 'now' ? 'Post now' : 'Schedule'}
              </Button>
            </div>
          )}
        </div>
      )}

      {phase === 'done' && result && (
        <DialogFooter>
          {onNavigate && result.post && (
            <Button variant="ghost" onClick={viewPosts} className="mr-auto">View posts</Button>
          )}
          {(outcome === 'failed' || outcome === 'duplicate') && <Button onClick={editAgain}>Edit and try again</Button>}
          {index < clips.length - 1 ? (
            <Button variant="primary" onClick={nextClip}>Next clip ({index + 2} of {clips.length})</Button>
          ) : (
            <Button variant="primary" onClick={onClose}>Done</Button>
          )}
        </DialogFooter>
      )}
    </Dialog>
  )
}

function SetupPrompt({ title, description, action }: { title: string; description: string; action: ReactNode }): React.JSX.Element {
  return (
    <div className="relative flex flex-col items-center overflow-hidden px-5 py-8 text-center">
      <IconTile size="xl" className="relative mb-4">
        <Share2 />
      </IconTile>
      <p className="relative text-lg font-semibold tracking-[-0.01em] text-ink">{title}</p>
      <p className="relative mt-2 max-w-sm text-sm leading-relaxed text-ink-muted" data-selectable>{description}</p>
      <div className="relative mt-5">{action}</div>
    </div>
  )
}

/** The clip itself, playable in place: TikTok asks that people can preview what they post. */
function ClipPreview({ path, thumb, vertical }: { path: string; thumb: string | null; vertical: boolean }): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const toggle = (): void => {
    const element = video.current
    if (!element) return
    if (element.paused) void element.play().catch(() => {})
    else element.pause()
  }
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={playing ? 'Pause preview' : 'Play preview'}
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-xl bg-black shadow-[0_10px_28px_-10px_rgb(0_0_0/0.8)] ring-1 ring-white/[0.12]',
        vertical ? 'h-[112px] w-[63px]' : 'h-[63px] w-[112px]'
      )}
    >
      <video
        ref={video}
        src={localFileUrl(path)}
        poster={thumb ? localFileUrl(thumb) : undefined}
        preload="metadata"
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {!playing && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/25">
          <span className="glass-chip flex h-9 w-9 items-center justify-center rounded-full text-white transition-transform duration-200 ease-out group-hover:scale-110">
            <Play className="ml-0.5 h-3.5 w-3.5" fill="currentColor" />
          </span>
        </span>
      )}
    </button>
  )
}

function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function PlatformSection({ platform, subtitle, notes, children }: { platform: ZernioPlatform; subtitle?: string; notes?: string[]; children: ReactNode }): React.JSX.Element {
  return (
    <section className="glass-tile rounded-2xl p-4 animate-fade-in">
      <div className="mb-3 flex items-center gap-3">
        <PlatformIcon platform={platform} className="h-8 w-8 rounded-[10px] [&_svg]:h-[15px] [&_svg]:w-[15px]" />
        <h3 className="text-sm font-semibold text-ink">{platformName(platform)}</h3>
        {subtitle && <span className="truncate text-xs text-ink-muted">{subtitle}</span>}
      </div>
      <div className="space-y-3">{children}</div>
      {notes && notes.length > 0 && <p className="mt-3 text-xs leading-relaxed text-ink-subtle">{notes.join(' ')}</p>}
    </section>
  )
}

function CaptionField({ caption, onChange, problems }: { caption: string; onChange: (value: string) => void; problems: { platform: ZernioPlatform; error: string | null; warning: string | null }[] }): React.JSX.Element {
  const id = useId()
  const length = captionLength(caption)
  const messages = problems.filter((p) => p.error || p.warning)
  return (
    <Section
      title={<label htmlFor={id}>Caption</label>}
      aside={<span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-2xs tabular text-ink-subtle">{length.toLocaleString('en-US')}</span>}
    >
      <TextArea
        id={id}
        value={caption}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        spellCheck
        aria-describedby={`${id}-hint`}
        placeholder="Say something about this clip"
      />
      <div id={`${id}-hint`} className="mt-2 space-y-1 text-xs">
        {problems.length > 0 && (
          <p className="text-ink-subtle">
            {problems.map((p, i) => (
              <span key={p.platform}>
                {i > 0 && ' · '}
                <span className={cn(p.error && 'text-danger', p.warning && 'text-warning')}>
                  {platformName(p.platform)} {PLATFORM_RULES[p.platform].captionMax.toLocaleString('en-US')}
                </span>
              </span>
            ))}
          </p>
        )}
        {messages.map((p) => (
          <p key={p.platform} className={p.error ? 'text-danger' : 'text-warning'} role={p.error ? 'alert' : undefined}>
            {p.error ?? p.warning}
          </p>
        ))}
      </div>
    </Section>
  )
}

/** A checkbox with visible text; the text is a mouse target only, so the control is one tab stop. */
function CheckRow({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox checked={checked} onChange={onChange} disabled={disabled} label={label} className="mt-px" />
      <div className="min-w-0">
        <span
          aria-hidden
          onClick={() => { if (!disabled) onChange(!checked) }}
          className={cn('select-none text-sm', disabled ? 'cursor-not-allowed text-ink-subtle' : 'cursor-pointer text-ink')}
        >
          {label}
        </span>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{description}</p>}
      </div>
    </div>
  )
}

function SwitchRow({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{description}</p>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} className="mt-0.5" />
    </div>
  )
}

function YouTubeFields({ value, onChange, problem }: { value: YouTubePostOptions; onChange: (value: YouTubePostOptions) => void; problem: string | null }): React.JSX.Element {
  const id = useId()
  const length = [...value.title.trim()].length
  return (
    <>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label htmlFor={id} className="text-sm font-medium text-ink">Title</label>
          <span className={cn('font-mono text-2xs tabular', length > YOUTUBE_TITLE_MAX ? 'text-danger' : 'text-ink-subtle')}>{length}/{YOUTUBE_TITLE_MAX}</span>
        </div>
        <TextInput id={id} value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} aria-invalid={Boolean(problem)} />
        {problem && <p role="alert" className="mt-2 text-xs text-danger">{problem}</p>}
        <p className="mt-2 text-xs text-ink-subtle">The caption becomes the video description.</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">Visibility</span>
        <Segmented<YouTubeVisibility>
          label="YouTube visibility"
          value={value.visibility}
          onChange={(visibility) => onChange({ ...value, visibility })}
          options={[{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'private', label: 'Private' }]}
        />
      </div>
      <CheckRow
        checked={value.madeForKids}
        onChange={(madeForKids) => onChange({ ...value, madeForKids })}
        label="Made for kids"
        description="YouTube requires this for videos directed at children."
      />
    </>
  )
}

/**
 * All selectable accounts, grouped by platform. Several accounts on one
 * platform get a group header with "Select all".
 */
function AccountPicker({ accounts, selected, onChange, profileName, reasonFor }: {
  accounts: ZernioAccount[]
  selected: string[]
  onChange: (ids: string[]) => void
  profileName: (account: ZernioAccount) => string | null
  reasonFor: (account: ZernioAccount) => string | null
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const visible = q
    ? accounts.filter((a) => [platformName(a.platform), a.username, a.displayName, profileName(a)].some((text) => text?.toLowerCase().includes(q)))
    : accounts
  const groups = ZERNIO_PLATFORMS
    .map((platform) => ({ platform, accounts: visible.filter((a) => a.platform === platform) }))
    .filter((group) => group.accounts.length > 0)
  const toggle = (id: string): void => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])

  return (
    <div className="space-y-2">
      {accounts.length > SEARCH_ACCOUNTS_AT && (
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search accounts or profiles"
          aria-label="Search accounts"
          leading={<Search className="h-3.5 w-3.5" />}
        />
      )}
      <div className="glass-well max-h-[340px] overflow-y-auto rounded-2xl p-1.5" role="group" aria-label="Accounts">
        {groups.length === 0 && <p className="px-3 py-3 text-sm text-ink-muted">No accounts match “{query}”.</p>}
        {groups.map(({ platform, accounts: members }) => {
          const choosable = members.filter((a) => !reasonFor(a)).map((a) => a.id)
          const allOn = choosable.length > 0 && choosable.every((id) => selected.includes(id))
          const grouped = members.length > 1
          return (
            <div key={platform} className="border-white/[0.06] [&:not(:last-child)]:mb-1.5 [&:not(:last-child)]:border-b [&:not(:last-child)]:pb-1.5">
              {grouped && (
                <div className="flex items-center gap-3 px-2.5 pb-1 pt-2">
                  <PlatformIcon platform={platform} className="h-8 w-8" />
                  <span className="min-w-0 flex-1 text-sm font-medium text-ink">
                    {platformName(platform)}
                    <span className="ml-1.5 font-normal text-ink-subtle">{members.length} accounts</span>
                  </span>
                  {choosable.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${allOn ? 'Clear' : 'Select all'} ${platformName(platform)} accounts`}
                      onClick={() => onChange(allOn ? selected.filter((id) => !choosable.includes(id)) : [...new Set([...selected, ...choosable])])}
                    >
                      {allOn ? 'Clear' : 'Select all'}
                    </Button>
                  )}
                </div>
              )}
              {members.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  grouped={grouped}
                  profile={profileName(account)}
                  reason={reasonFor(account)}
                  selected={selected.includes(account.id)}
                  onToggle={() => toggle(account.id)}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AccountRow({ account, grouped, profile, reason, selected, onToggle }: {
  account: ZernioAccount
  grouped: boolean
  profile: string | null
  reason: string | null
  selected: boolean
  onToggle: () => void
}): React.JSX.Element {
  const dimmed = Boolean(reason) && !selected
  const name = platformName(account.platform)
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={`${name} ${accountHandle(account)}${profile ? `, ${profile}` : ''}`}
      // A selected account stays clickable so it can be removed even after it became unavailable.
      disabled={dimmed}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-[background,box-shadow] duration-150',
        selected
          ? 'bg-accent/[0.12] shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.3)]'
          : 'hover:bg-white/[0.05]',
        dimmed && 'cursor-not-allowed hover:bg-transparent'
      )}
    >
      {grouped ? <span aria-hidden className="w-8 shrink-0" /> : <PlatformIcon platform={account.platform} className={cn('h-8 w-8', dimmed && 'opacity-50')} />}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm', dimmed ? 'text-ink-muted' : 'text-ink')}>
          {!grouped && <span className="mr-1.5 font-medium">{name}</span>}
          <span className={grouped ? 'text-ink' : 'text-ink-muted'}>{accountHandle(account)}</span>
          {profile && <span className="ml-1.5 text-xs text-ink-subtle">· {profile}</span>}
        </span>
        {reason && <span className="mt-0.5 block text-xs text-warning">{reason}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-[background,box-shadow] duration-150',
          selected
            ? 'bg-accent text-accent-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_0_0_1px_rgb(var(--accent)/0.7)]'
            : 'text-transparent shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.22)]'
        )}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    </button>
  )
}

/** Choices for one TikTok account, from its own creator info. */
export function TikTokAccountFields({ heading, state, value, onChange, brandedContent, draft, businessConnection, onRetry }: {
  heading: string | null
  state: CreatorInfoState | undefined
  value: TikTokAccountOptions
  onChange: (value: TikTokAccountOptions) => void
  brandedContent: boolean
  draft: boolean
  businessConnection: boolean
  onRetry: () => void
}): React.JSX.Element {
  const id = useId()
  const set = (patch: Partial<TikTokAccountOptions>): void => onChange({ ...value, ...patch })
  const info = isCreatorInfo(state) ? state : null

  let content: ReactNode
  if (state && typeof state === 'object' && 'error' in state) {
    content = (
      <div role="alert" className="flex items-center justify-between gap-3">
        <p className="text-sm text-danger" data-selectable>{state.error}</p>
        <Button size="sm" onClick={onRetry}>Try again</Button>
      </div>
    )
  } else if (!info) {
    content = <p className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading TikTok settings…</p>
  } else {
    const { interactions } = info
    content = (
      <>
        {!info.canPostMore && !draft && (
          <p role="alert" className="rounded-xl bg-warning/[0.07] px-3.5 py-2.5 text-xs leading-relaxed text-ink shadow-[inset_0_0_0_1px_rgb(var(--warning)/0.24)]">
            TikTok isn’t accepting more posts from this account right now. Try later, or send it to your TikTok inbox below.
          </p>
        )}
        {businessConnection && (
          <p className="rounded-xl bg-white/[0.04] px-3.5 py-2.5 text-xs leading-relaxed text-ink-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
            {draft
              ? 'Choose the audience when you finish posting this video from your TikTok inbox.'
              : 'Direct video posts from this TikTok Business connection are public. Choose Everyone, or send to your TikTok inbox to set a different audience in TikTok.'}
          </p>
        )}
        <div>
          <label htmlFor={id} className="mb-2 block text-sm font-medium text-ink">Who can view this video</label>
          <Select
            id={id}
            value={value.privacyLevel}
            onChange={(e) => set({ privacyLevel: e.target.value })}
          >
            <option value="" disabled>Choose who can view</option>
            {info.privacyLevels.map((level) => {
              const privateBranded = level.value === 'SELF_ONLY' && brandedContent
              const businessDirectPrivate = businessConnection && !draft && level.value !== 'PUBLIC_TO_EVERYONE'
              return (
                <option key={level.value} value={level.value} disabled={privateBranded || businessDirectPrivate}>
                  {TIKTOK_PRIVACY_LABELS[level.value] ?? level.label}
                  {privateBranded ? ' (not for branded content)' : businessDirectPrivate ? ' (send to inbox)' : ''}
                </option>
              )
            })}
          </Select>
          {info.privacyLevels.length === 0 && <p className="mt-2 text-xs text-danger">TikTok returned no privacy options for this account.</p>}
        </div>
        <div>
          <p className="mb-2.5 text-sm font-medium text-ink">Allow people to</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <CheckRow checked={value.allowComment && interactions.comment} disabled={!interactions.comment} onChange={(allowComment) => set({ allowComment })} label="Comment" />
            <CheckRow checked={value.allowDuet && interactions.duet} disabled={!interactions.duet} onChange={(allowDuet) => set({ allowDuet })} label="Duet" />
            <CheckRow checked={value.allowStitch && interactions.stitch} disabled={!interactions.stitch} onChange={(allowStitch) => set({ allowStitch })} label="Stitch" />
          </div>
          {(!interactions.comment || !interactions.duet || !interactions.stitch) && (
            <p className="mt-2 text-xs text-ink-subtle">Greyed out options are turned off in this account’s TikTok settings.</p>
          )}
        </div>
      </>
    )
  }

  if (!heading) return <>{content}</>
  return (
    <div className="space-y-3.5 rounded-2xl bg-black/20 p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07),inset_0_1px_2px_rgb(0_0_0/0.25)]" role="group" aria-label={`TikTok ${heading}`}>
      <p className="text-sm font-medium text-ink">
        {heading}
        {info?.nickname && <span className="ml-1.5 font-normal text-ink-subtle">{info.nickname}</span>}
      </p>
      {content}
    </div>
  )
}

/** Choices that apply to every TikTok account in the post, and TikTok's consent. */
export function TikTokSharedFields({ value, onChange, commercialTypes }: { value: TikTokPostOptions; onChange: (value: TikTokPostOptions) => void; commercialTypes: string[] }): React.JSX.Element {
  const set = (patch: Partial<TikTokPostOptions>): void => onChange({ ...value, ...patch, ...('consent' in patch ? {} : { consent: false }) })
  const canBrand = commercialTypes.length === 0 || commercialTypes.includes('brand_organic')
  const canBranded = commercialTypes.length === 0 || commercialTypes.includes('brand_content')
  const label = value.disclose && value.brandedContent ? 'Paid partnership' : value.disclose && value.yourBrand ? 'Promotional content' : null

  return (
    <>
      <div className="space-y-3.5 border-t border-white/[0.07] pt-3">
        <SwitchRow
          checked={value.disclose}
          onChange={(disclose) => set({ disclose, ...(disclose ? {} : { yourBrand: false, brandedContent: false }), consent: false })}
          label="Disclose commercial content"
          description="Turn on if this video promotes you, a brand, a product or a service."
        />
        {value.disclose && (
          <div className="space-y-2.5 rounded-xl bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
            {canBrand && (
              <CheckRow checked={value.yourBrand} onChange={(yourBrand) => set({ yourBrand })} label="Your brand" description="You’re promoting yourself or your own business." />
            )}
            {canBranded && (
              <CheckRow
                checked={value.brandedContent}
                onChange={(brandedContent) => set({ brandedContent, consent: false })}
                label="Branded content"
                description="You’re promoting another brand or a third party. It can’t be private."
              />
            )}
            {label ? (
              <p className="text-xs text-ink-muted">Your video will be labeled “{label}”.</p>
            ) : (
              <p className="text-xs text-warning">Choose whether this promotes your brand, a third party, or both.</p>
            )}
          </div>
        )}
        <SwitchRow
          checked={value.madeWithAi}
          onChange={(madeWithAi) => set({ madeWithAi })}
          label="AI-generated content"
          description="Turn on if the video shows realistic people or scenes made with AI."
        />
        <SwitchRow
          checked={value.draft}
          onChange={(draft) => set({ draft })}
          label="Send to your TikTok inbox"
          description="Finish and post it in TikTok. Use this for a non-public video on a Business connection or when direct posting is busy."
        />
      </div>

      <div className="glass-well rounded-2xl px-3 py-3.5">
        <CheckRow
          checked={value.consent}
          onChange={(consent) => set({ consent })}
          label={tiktokConsentText(value.disclose && value.brandedContent)}
        />
        <p className="mt-2 flex flex-wrap gap-x-3 pl-[28px] text-xs">
          {value.disclose && value.brandedContent && <LegalLink which="brandedContent">Branded Content Policy</LegalLink>}
          <LegalLink which="musicUsage">Music Usage Confirmation</LegalLink>
        </p>
        <p className="mt-1.5 pl-[28px] text-xs text-ink-subtle">
          {value.draft ? 'TikTok sends the video to your inbox for you to finish.' : 'After posting, it can take a few minutes for the video to appear on your profile.'}
        </p>
      </div>
    </>
  )
}

function LegalLink({ which, children }: { which: 'musicUsage' | 'brandedContent'; children: ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => void getApi().zernio.posts.openTikTokLegal(which).catch(() => {})}
      className="inline-flex items-center gap-0.5 text-ink-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
    >
      {children}
      <ArrowUpRight className="h-3 w-3" />
    </button>
  )
}

function FacebookFields({ media, value, onChange }: { media: ClipMediaInfo; value: FacebookFormat; onChange: (value: FacebookFormat) => void }): React.JSX.Element {
  const reel = checkClip('facebook', media, { facebookFormat: 'reel' })
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-ink">Post as</p>
        <p className="mt-0.5 text-xs text-ink-subtle">{reel.blocking ?? 'Reels are vertical videos of up to 60 seconds.'}</p>
      </div>
      <Segmented<FacebookFormat>
        label="Facebook format"
        value={value}
        onChange={onChange}
        options={[{ value: 'reel', label: 'Reel', disabled: reel.blocking ?? undefined }, { value: 'feed', label: 'Feed video' }]}
      />
    </div>
  )
}

function WhenField({ mode, onModeChange, value, onValueChange, min, max, problem }: {
  mode: 'now' | 'schedule'
  onModeChange: (mode: 'now' | 'schedule') => void
  value: string
  onValueChange: (value: string) => void
  min: string
  max: string
  problem: string | null
}): React.JSX.Element {
  const id = useId()
  const at = new Date(value).getTime()
  return (
    <Section title="When">
      <Segmented<'now' | 'schedule'> label="When to post" value={mode} onChange={onModeChange} options={[{ value: 'now', label: 'Post now' }, { value: 'schedule', label: 'Schedule' }]} />
      {mode === 'schedule' && (
        <div className="mt-3.5 animate-fade-in">
          <div className="flex flex-wrap items-center gap-3">
            <input
              id={id}
              type="datetime-local"
              value={value}
              min={min}
              max={max}
              onChange={(e) => onValueChange(e.target.value)}
              aria-label="Publish date and time"
              aria-invalid={Boolean(problem)}
              className={cn('h-9 rounded-full px-3 font-mono text-xs tabular text-ink [color-scheme:dark] focus:outline-none', WELL)}
            />
            <span className="text-xs text-ink-muted">
              {localTimeZone().replace(/_/g, ' ')}
              {Number.isFinite(at) && zoneName(at) ? ` (${zoneName(at)})` : ''}
            </span>
          </div>
          {problem ? (
            <p role="alert" className="mt-2 text-xs text-danger">{problem}</p>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-ink-subtle">Zernio publishes it at this time, even when BridgeClip is closed. Up to 6½ days ahead, because Zernio keeps uploads for 7 days.</p>
          )}
        </div>
      )}
    </Section>
  )
}

const TARGET_BADGE: Record<PostRecordTarget['status'], { label: string; tone: 'neutral' | 'accent' | 'danger' }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'accent' },
  uploading: { label: 'Uploading', tone: 'accent' },
  published: { label: 'Published', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' }
}

export function targetBadge(target: PostRecordTarget, postStatus: string): { label: string; tone: 'neutral' | 'accent' | 'danger' } {
  if (target.status === 'published' && target.inbox) return { label: 'In TikTok inbox', tone: 'neutral' }
  if (target.status === 'pending' && postStatus === 'scheduled') return { label: 'Scheduled', tone: 'neutral' }
  if (target.status === 'pending' && postStatus === 'publishing') return { label: 'Publishing', tone: 'accent' }
  return TARGET_BADGE[target.status]
}

const RESULT_TITLES: Record<PostClipResult['outcome'], string> = {
  published: 'Posted',
  scheduled: 'Scheduled',
  partial: 'Posted to some accounts',
  failed: 'Not posted',
  retrying: 'Retrying automatically',
  publishing: 'Still publishing',
  duplicate: 'Already posted'
}

function ResultView({ result }: { result: PostClipResult }): React.JSX.Element {
  const failed = result.outcome === 'failed' || result.outcome === 'partial' || result.outcome === 'duplicate'
  const post = result.post
  const inboxOnly = result.outcome === 'published' && Boolean(post?.targets.every((t) => t.inbox))
  return (
    <div className="relative px-4 py-4 animate-fade-in">
      <div className="flex items-start gap-3">
        <IconTile size="lg" tone={failed ? 'danger' : result.outcome === 'scheduled' ? 'accent' : 'success'}>
          {failed ? <AlertTriangle /> : result.outcome === 'scheduled' ? <CalendarClock /> : inboxOnly ? <Inbox /> : <Check strokeWidth={2.5} />}
        </IconTile>
        <div className="min-w-0 pt-0.5" role={failed ? 'alert' : 'status'}>
          <p className="text-lg font-semibold tracking-[-0.01em] text-ink">{inboxOnly ? 'Sent to your TikTok inbox' : RESULT_TITLES[result.outcome]}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted" data-selectable>
            {result.outcome === 'scheduled' && post?.scheduledFor ? `${formatScheduled(post.scheduledFor, post.timezone)}. ` : ''}
            {result.message}
          </p>
        </div>
      </div>

      {post && (
        <ul className="glass-well mt-4 divide-y divide-white/[0.06] overflow-hidden rounded-2xl">
          {post.targets.map((target, i) => {
            const badge = targetBadge(target, post.status)
            return (
              <li key={`${target.platform}:${target.accountId}`} className="px-3 py-3">
                <div className="flex items-center gap-3">
                  <PlatformIcon platform={target.platform} className="h-8 w-8 rounded-[10px] [&_svg]:h-[15px] [&_svg]:w-[15px]" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {platformName(target.platform)}
                    {target.handle && <span className="ml-1.5 text-ink-muted">{target.handle}</span>}
                  </span>
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  {target.url && (
                    <Button size="sm" variant="ghost" trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => usePostsStore.getState().open(post.id, i)}>
                      Open
                    </Button>
                  )}
                </div>
                {target.error && <p className="mt-1.5 pl-7 text-xs text-danger" data-selectable>{target.error}</p>}
              </li>
            )
          })}
        </ul>
      )}

      {result.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-warning">
          {result.warnings.map((warning) => <li key={warning} data-selectable>{warning}</li>)}
        </ul>
      )}
      {result.outcome === 'failed' && (
        <p className="mt-3 text-xs text-ink-subtle">Trying again reuses this upload.</p>
      )}
    </div>
  )
}
