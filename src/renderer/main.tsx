import './components/clip-editor.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppErrorBoundary, reportRendererError } from './components/AppErrorBoundary'
import { isMac } from './lib/utils'
import './globals.css'

// macOS windows have native vibrancy; the backdrop turns translucent over it.
if (isMac) document.documentElement.classList.add('vibrant')

window.addEventListener('error', event => { void reportRendererError(event.error) })
window.addEventListener('unhandledrejection', event => { void reportRendererError(event.reason) })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>
)
