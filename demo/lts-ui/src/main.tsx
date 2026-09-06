import React from 'react'
import ReactDOM from 'react-dom/client'
import { getAppHostExtension, installAppHostExtension } from './platform/host/appHost'
import { initRiaLiveDebug } from './integrations/ake/riaLiveDebug'

declare global {
  interface Window {
    __DMG_MARK_MODULE_READY__?: () => void
    __DMG_RECOVER_STARTUP__?: () => Promise<void>
    __DMG_ENSURE_SERVICE_WORKER__?: () => Promise<boolean>
    __DMG_MOBILE_ENTRY__?: boolean
  }
}

// Refreshing the browser must not be blocked by a stale workbench unload guard.
// Keep the original handler here for a deliberate future re-enable.
// window.onbeforeunload = (event: BeforeUnloadEvent) => {
//   event.preventDefault()
//   event.returnValue = '确定要离开当前页面吗？'
//   return event.returnValue
// }

const root = ReactDOM.createRoot(document.getElementById('root')!)

if (import.meta.env.VITE_AKE_DEMO === '1') {
  initRiaLiveDebug();
  installAppHostExtension({
    id: 'ake-demo',
    workspace: {
      skipAccessGate: true,
      requestControlWhenSecondary: true,
      startupLabel: () => '正在载入 LTS 工作台与 AKE 数据',
    },
    ui: {
      showPageVersionUpdate: false,
      showAccessSettings: false,
      showLocalResourcePackager: false,
    },
  })
}

async function mountEntry() {
  await getAppHostExtension().beforeMount?.()
  const Entry = (await import('./components/WebApp/WebBootstrap')).WebBootstrap

  root.render(
    <React.StrictMode>
      <Entry />
    </React.StrictMode>,
  )

  // The selected entry module is now usable. Desktop themes and image services
  // continue their own initialization after WebBootstrap mounts.
  window.__DMG_MARK_MODULE_READY__?.()
}

void mountEntry()
