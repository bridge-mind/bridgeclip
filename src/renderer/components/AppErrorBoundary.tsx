import { Component, type ReactNode } from 'react'
import { getApi } from '../lib/ipc'
import { CrashReportPanel } from './CrashReportPanel'
import { Button } from './ui/Button'

export async function reportRendererError(error: unknown): Promise<void> {
  try {
    const e = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; stack?: unknown } : {}
    await getApi().diagnostics.rendererError({ name: typeof e.name === 'string' ? e.name.slice(0, 32) : undefined,
      code: typeof e.code === 'string' ? e.code.slice(0, 32) : undefined, stack: typeof e.stack === 'string' ? e.stack.slice(0, 8192) : undefined })
  } catch { /* Reporting must not cause another interface error. */ }
}
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; recorded: boolean }> {
  state = { failed: false, recorded: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: Error): void { void reportRendererError(error).then(() => this.setState({ recorded: true })) }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <div className="app-backdrop flex h-screen items-center justify-center p-6"><div className="glass w-full max-w-xl rounded-3xl p-6">
      <h1 className="text-lg font-semibold">The interface hit a problem</h1><p className="mt-2 text-sm text-ink-muted">Reload BridgeClip to continue. You can copy a report to help us investigate.</p>
      <Button className="mt-4" variant="primary" onClick={() => window.location.reload()}>Reload app</Button>
      {this.state.recorded && <CrashReportPanel />}
    </div></div>
  }
}
