import { useCallback, useRef, useState } from 'react'
import { useSetupState } from '../store/use-settings-store'
import { isCaptionPresetId } from '../../shared/caption-presets'
import { useCaptionStore } from '../store/use-caption-store'
import { useDraftStore } from '../store/use-draft-store'
import { useJobStore } from '../store/use-job-store'
import { errorMessage } from '../lib/utils'
import { getApi } from '../lib/ipc'
import type { ClipJobRequest } from '../../shared/jobs'
import { JobForm } from '../components/JobForm'
import { SetupCard } from '../components/SetupCard'
import { PageHeader } from '../components/ui/PageHeader'
import { Page } from '../components/ui/Page'
import { Callout } from '../components/ui/Callout'
import type { Page as PageId } from '../components/Sidebar'

/**
 * Create: the setup card (until the OpenRouter key exists) and the clipping wizard. Runs go
 * to the main process's queue and are followed on the Jobs page, so this page
 * is always ready for the next video.
 */
export function ClipPage({ onNavigate }: { onNavigate: (page: PageId) => void }): React.JSX.Element {
  const setup = useSetupState()
  const startingRef = useRef(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const handleSubmit = useCallback(async (config: ClipJobRequest) => {
    if (startingRef.current) return
    startingRef.current = true
    setStarting(true)
    setStartError(null)
    try {
      const result = await getApi().job.start(config)
      if (result.error) setStartError(result.error)
      else if (result.jobId) {
        // Starting must not depend on an event arriving before navigation.
        if (result.job) useJobStore.getState().upsert(result.job)
        else await getApi().job.list().then(useJobStore.getState().hydrate).catch(() => {})
        useDraftStore.getState().markStarted({ jobId: result.jobId, source: config.videoUrl, queued: Boolean(result.queued) })
        if (config.workflow === 'review') { useJobStore.getState().focusJob(result.jobId); onNavigate('jobs') }
      }
    } catch (err) {
      setStartError(errorMessage(err, 'Could not start the job. Please try again.'))
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }, [onNavigate])

  const viewJob = useCallback((jobId: string) => {
    useJobStore.getState().focusJob(jobId)
    onNavigate('jobs')
  }, [onNavigate])

  const openCaptionsLab = (): void => {
    const draft = useDraftStore.getState()
    const lab = useCaptionStore.getState()
    const savedStyle = lab.styles.find(style => style.id === lab.editing?.id)
    const hasUnsavedChanges = lab.editing !== null && JSON.stringify(lab.editing) !== JSON.stringify(savedStyle)
    useCaptionStore.setState({
      fromWizard: true,
      ...(!hasUnsavedChanges ? {
        view: 'home' as const,
        editing: null,
        selectedBaseId: isCaptionPresetId(draft.captionPreset) ? draft.captionPreset : 'pop',
        selectedCustomId: draft.customCaption?.id ?? null
      } : {})
    })
    onNavigate('captions')
  }

  const blockedReason =
    setup.missingKeys.length > 0
      ? `Add your ${setup.missingKeys.join(' and ')} key${setup.missingKeys.length > 1 ? 's' : ''} above to start.`
      : setup.toolsOk === false
        ? 'Fix the missing tools in Settings to start.'
        : !setup.ready ? 'Checking required tools…' : undefined

  return (
    <Page width="narrow">
      <PageHeader
        eyebrow="Studio"
        title="Create clips"
        description="Pick a long video and a few options. BridgeClip finds the strongest moments and cuts them into captioned clips."
      />

      <SetupCard className="mt-4" onOpenSettings={() => onNavigate('settings')} />

      {startError && (
        <Callout tone="danger" className="mt-3" onDismiss={() => setStartError(null)}>
          <span className="whitespace-pre-line">{startError}</span>
        </Callout>
      )}

      <JobForm onOpenCaptionsLab={openCaptionsLab} className="mt-4" onSubmit={handleSubmit} onViewJob={viewJob} blockedReason={blockedReason} submitting={starting} />
    </Page>
  )
}
