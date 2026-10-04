import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react'
import ChartPane from './chart/ChartPane'
import Dialogs from './dialogs/Dialogs'
import DrawingToolbar from './DrawingToolbar'
import LoginView from './auth/LoginView'
import TopBar from './TopBar'
import { requestNotifications, useAlerts, usePaper, useScripts, useSymbols, useToasts, wireUserEvents } from './data'
import { Icon } from './icons'
import AlertsPanel from './panels/AlertsPanel'
import Depth from './panels/Depth'
import Details from './panels/Details'
import TradingPanel from './panels/TradingPanel'
import Watchlist from './panels/Watchlist'
import { GRID_PANES, useAuth, useTerminal, useUi, type BottomTab, type RightTab } from './store'

// heavy, rarely-open panels load on first use (CodeMirror, equity chart)
const ScriptEditor = lazy(() => import('./panels/ScriptEditor'))
const StrategyTester = lazy(() => import('./panels/StrategyTester'))
const Screener = lazy(() => import('./panels/Screener'))

const RIGHT_TABS: { id: RightTab; title: string; icon: () => ReactNode }[] = [
  { id: 'watchlist', title: 'Watchlist', icon: Icon.list },
  { id: 'depth', title: 'Order book & trades', icon: Icon.depth },
  { id: 'alerts', title: 'Alerts', icon: Icon.alert },
  { id: 'details', title: 'Symbol details', icon: Icon.info },
]

const BOTTOM_TABS: { id: BottomTab; title: string; icon: () => ReactNode }[] = [
  { id: 'editor', title: 'Script Editor', icon: Icon.code },
  { id: 'tester', title: 'Strategy Tester', icon: Icon.flask },
  { id: 'screener', title: 'Screener', icon: Icon.filter },
  { id: 'trading', title: 'Trading Panel', icon: Icon.wallet },
]

function ChartGrid() {
  const grid = useTerminal((s) => s.grid)
  const n = GRID_PANES[grid]
  return (
    <div className={`chart-grid g${grid}`}>
      {Array.from({ length: n }, (_, i) => (
        <ChartPane key={i} index={i} />
      ))}
    </div>
  )
}

function BottomPanel() {
  const tab = useTerminal((s) => s.bottomTab)
  const setTab = useTerminal((s) => s.setBottomTab)
  const [height, setHeight] = useState(320)
  const drag = useRef<{ y: number; h: number } | null>(null)

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return
      setHeight(Math.max(160, Math.min(window.innerHeight - 200, drag.current.h + drag.current.y - e.clientY)))
    }
    const up = () => (drag.current = null)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  return (
    <div className="bottom" style={tab ? { height } : undefined}>
      {tab && <div className="bottom-resize" onMouseDown={(e) => (drag.current = { y: e.clientY, h: height })} />}
      <div className="bottom-tabs">
        {BOTTOM_TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(tab === t.id ? null : t.id)}>
            <t.icon /> {t.title}
          </button>
        ))}
        <span className="spacer" />
        {tab && (
          <button className="icon-btn" onClick={() => setTab(null)} title="Collapse">
            <Icon.x />
          </button>
        )}
      </div>
      {tab && (
        <div className="bottom-body">
          <Suspense fallback={<p className="muted pad">Loading…</p>}>
            {tab === 'editor' && <ScriptEditor />}
            {tab === 'tester' && <StrategyTester />}
            {tab === 'screener' && <Screener />}
            {tab === 'trading' && <TradingPanel />}
          </Suspense>
        </div>
      )}
    </div>
  )
}

function RightPanel() {
  const tab = useTerminal((s) => s.rightTab)
  const setTab = useTerminal((s) => s.setRightTab)
  return (
    <>
      {tab && (
        <aside className="right">
          {tab === 'watchlist' && <Watchlist />}
          {tab === 'depth' && <Depth />}
          {tab === 'alerts' && <AlertsPanel />}
          {tab === 'details' && <Details />}
        </aside>
      )}
      <nav className="rail">
        {RIGHT_TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} title={t.title} onClick={() => setTab(tab === t.id ? null : t.id)}>
            <t.icon />
          </button>
        ))}
      </nav>
    </>
  )
}

function Toasts() {
  const list = useToasts((s) => s.list)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
          <b>{t.title}</b>
          {t.body && <span>{t.body}</span>}
        </div>
      ))}
    </div>
  )
}

function Terminal() {
  const theme = useTerminal((s) => s.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const refreshSymbols = () => void useSymbols.getState().refresh().catch(() => {})
    refreshSymbols()
    void useAlerts.getState().refresh().catch(() => {})
    void usePaper.getState().refresh().catch(() => {})
    void useScripts.getState().refresh().catch(() => {})
    const off = wireUserEvents()
    requestNotifications()
    const timer = setInterval(refreshSymbols, 30_000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [])

  // keyboard: "/" symbol search, Alt+A alert, Alt+I indicators
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, .cm-editor')) return
      const ui = useUi.getState()
      const pane = useTerminal.getState().panes[useTerminal.getState().active]
      if (e.key === '/' && !ui.dialog) {
        e.preventDefault()
        ui.open({ kind: 'symbol' })
      } else if (e.altKey && e.code === 'KeyA') {
        e.preventDefault()
        ui.open({ kind: 'alert', symbol: pane.symbol, price: NaN })
      } else if (e.altKey && e.code === 'KeyI') {
        e.preventDefault()
        ui.open({ kind: 'indicators' })
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="terminal">
      <TopBar />
      <div className="body">
        <DrawingToolbar />
        <div className="center">
          <ChartGrid />
          <BottomPanel />
        </div>
        <RightPanel />
      </div>
      <Dialogs />
      <Toasts />
    </div>
  )
}

export default function App() {
  const token = useAuth((s) => s.token)
  return token ? <Terminal /> : <LoginView />
}
