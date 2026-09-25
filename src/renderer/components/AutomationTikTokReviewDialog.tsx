import { useEffect, useId, useRef, useState } from 'react'
import type { Automation, AutomationTikTokReview } from '../../shared/automations'
import { captionLength, checkCaption, checkClip, EMPTY_TIKTOK_ACCOUNT, PLATFORM_RULES, sharedCommercialTypes, tiktokOptionsError, type TikTokPostOptions } from '../../shared/zernio-posts'
import { getApi } from '../lib/ipc'
import { errorMessage, localFileUrl } from '../lib/utils'
import { EMPTY_TIKTOK, TikTokAccountFields, TikTokSharedFields } from './PostDialog'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { Checkbox } from './ui/Checkbox'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Field, TextArea } from './ui/Field'

export function AutomationTikTokReviewDialog({ automationId, contentId, title, onClose, onPrepared, onApproved }: {
  automationId: string
  contentId: string
  title: string
  onClose: () => void
  onPrepared: () => void
  onApproved: (automations: Automation[]) => void
}): React.JSX.Element {
  const [review, setReview] = useState<AutomationTikTokReview | null>(null)
  const [caption, setCaption] = useState('')
  const [options, setOptions] = useState<TikTokPostOptions>(EMPTY_TIKTOK)
  const [previewConfirmed, setPreviewConfirmed] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)
  const preparation = useRef<{ key: string; promise: Promise<AutomationTikTokReview> } | null>(null)
  const preparedRef = useRef(onPrepared)
  preparedRef.current = onPrepared
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    let active = true
    setError(null); setReview(null); setPreviewConfirmed(false); setPreviewReady(false); setOptions(EMPTY_TIKTOK)
    // React's development effect replay must reuse the same preparation.
    const key = `${automationId}:${contentId}:${retry}`
    if (preparation.current?.key !== key) preparation.current = { key, promise: getApi().automations.prepareTikTokReview(automationId, contentId) }
    preparation.current.promise.then((value) => {
      if (active) { setReview(value); setCaption(value.caption); preparedRef.current() }
    }).catch((cause) => { if (active) setError(errorMessage(cause, 'Could not prepare the TikTok review.')) })
    return () => { active = false }
  }, [automationId, contentId, retry])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => previous?.focus()
  }, [])

  const issues: string[] = []
  if (review) {
    if (!caption.trim()) issues.push('Enter a TikTok caption.')
    const captionError = checkCaption('tiktok', caption).error
    if (captionError) issues.push(captionError)
    const optionsError = tiktokOptionsError(options, review.creators.map((creator) => creator.info))
    if (optionsError) issues.push(optionsError)
    for (const { info, businessConnection } of review.creators) {
      const blocking = checkClip('tiktok', review.media, { tiktokMaxSec: info.maxVideoDurationSec }).blocking
      if (blocking) issues.push(blocking)
      if (businessConnection && !options.draft && options.accounts[info.accountId]?.privacyLevel && options.accounts[info.accountId].privacyLevel !== 'PUBLIC_TO_EVERYONE') {
        issues.push('Choose Everyone for a direct video post on this Business connection, or send it to your TikTok inbox.')
      }
    }
  }

  const approve = async (): Promise<void> => {
    if (!review || saving || !previewReady || !previewConfirmed || issues.length) return
    setSaving(true); setError(null)
    try {
      const result = await getApi().automations.approveTikTokReview(automationId, contentId, {
        reviewId: review.reviewId, caption, options, previewConfirmed
      })
      onApproved(result)
    } catch (cause) { setError(errorMessage(cause, 'Could not approve this clip.')) }
    finally { setSaving(false) }
  }

  return (
    <Dialog ref={dialogRef} aria-labelledby={titleId} panelClassName="max-w-[640px]" onBackdropMouseDown={() => { if (!saving) onClose() }} onKeyDown={(event) => {
      if (event.key === 'Escape' && !saving) { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), video[controls]') ?? [])
          .filter((element) => element.getClientRects().length > 0 && element.tabIndex >= 0)
        const first = focusable?.[0]
        const last = focusable?.[focusable.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <div className="border-b border-white/[0.07] px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold text-ink">Review for TikTok</h2>
        <p className="mt-1 text-sm text-ink-muted">{title}</p>
        <p className="mt-2 text-xs text-ink-subtle">This clip waits until you approve it here. It will then submit at a daily posting time while BridgeClip is open, or when you choose Run now. Closing this review leaves the clip waiting for approval.</p>
      </div>
      <div className="min-h-0 overflow-y-auto p-5">
        {error && <Callout tone="danger" className="mb-3" action={!saving && <Button size="sm" onClick={() => setRetry((value) => value + 1)}>Reload review</Button>}>{error}</Callout>}
        {!review && !error && <p className="text-sm text-ink-muted" role="status">Preparing the preview and TikTok settings…</p>}
        {review && (
          <fieldset disabled={saving} className="min-w-0 space-y-4">
            <video key={review.reviewId} src={localFileUrl(review.clipPath)} controls preload="metadata" className="mx-auto max-h-[280px] w-full rounded-xl bg-black" aria-label="TikTok clip preview"
              onLoadedData={() => setPreviewReady(true)} onError={() => { setPreviewReady(false); setPreviewConfirmed(false); setError('The clip preview could not be loaded. Reopen the review to try again.') }} />
            <Field label="TikTok caption" htmlFor={`${titleId}-caption`}>
              <TextArea id={`${titleId}-caption`} aria-describedby={`${titleId}-caption-count`} value={caption} onChange={(event) => { setCaption(event.target.value); setPreviewConfirmed(false); setOptions((current) => ({ ...current, consent: false })) }} />
              <p id={`${titleId}-caption-count`} className="mt-1 text-xs text-ink-subtle">{captionLength(caption).toLocaleString()} / {PLATFORM_RULES.tiktok.captionMax.toLocaleString()} characters</p>
            </Field>
            {review.creators.map(({ info, businessConnection, handle }) => (
              <TikTokAccountFields key={info.accountId} heading={handle} state={info} value={options.accounts[info.accountId] ?? EMPTY_TIKTOK_ACCOUNT}
                onChange={(value) => setOptions({ ...options, accounts: { ...options.accounts, [info.accountId]: value }, consent: false })}
                brandedContent={options.disclose && options.brandedContent} draft={options.draft} businessConnection={businessConnection} onRetry={() => setRetry((value) => value + 1)} />
            ))}
            <TikTokSharedFields value={options} onChange={setOptions} commercialTypes={sharedCommercialTypes(review.creators.map((creator) => creator.info))} />
            <div className="flex items-start gap-2 text-sm text-ink">
              <Checkbox checked={previewConfirmed} disabled={!previewReady} onChange={setPreviewConfirmed} label="I reviewed this clip and caption for TikTok" />
              <span>I reviewed this clip and caption for TikTok.</span>
            </div>
            {issues.length > 0 && <p className="text-xs text-ink-muted" role="status">{issues[0]}</p>}
          </fieldset>
        )}
      </div>
      <DialogFooter>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" loading={saving} disabled={!review || !previewReady || !previewConfirmed || issues.length > 0 || saving} onClick={() => void approve()}>Approve for automation</Button>
      </DialogFooter>
    </Dialog>
  )
}
