import { useEffect, useRef, useState } from 'react'
import { saveLayout } from './api/client'
import { getPane } from './chart/registry'
import { stream } from './chart/stream'
import { toast } from './data'
import { Icon } from './icons'
import { GRID_PANES, TFS, layoutSpec, parseTf, useAuth, useTerminal, useUi, type ChartType, type Grid } from './store'

const CHART_TYPES: { group: string; items: { id: ChartType; label: string }[] }[] = [
  {
    group: 'Time-based',
    items: [
      { id: 'candles', label: 'Candles' },
      { id: 'hollow', label: 'Hollow candles' },
      { id: 'heikin', label: 'Heikin Ashi' },
      { id: 'bars', label: 'Bars' },
      { id: 'columns', label: 'Columns' },
      { id: 'line', label: 'Line' },
      { id: 'area', label: 'Area' },
      { id: 'baseline', label: 'Baseline' },
    ],
  },
  {
    group: 'Price-based',
    items: [
      { id: 'renko', label: 'Renko' },
      { id: 'range', label: 'Range' },
      { id: 'linebreak', label: 'Line break' },
      { id: 'kagi', label: 'Kagi' },
      { id: 'pnf', label: 'Point & figure' },
    ],
  },
]

/** Favourite intervals as buttons, every interval (and a custom one) in a dropdown. */
function Intervals() {
  const tf = useTerminal((s) => s.panes[s.active].tf)
  const fav = useTerminal((s) => s.favTfs)
  const { setTf, toggleFavTf } = useTerminal.getState()
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])
  const shown = fav.includes(tf) ? fav : [...fav, tf]
  return (
    <div className="tfs" ref={ref}>
      {shown.map((t) => (
        <button key={t} className={t === tf ? 'on' : ''} onClick={() => setTf(t)}>
          {t}
        </button>
      ))}
      <button className="tf-more" title="All intervals" onClick={() => setOpen(!open)}>▾</button>
      {open && (
        <div className="dropdown tf-drop">
          {TFS.map((t) => (
            <div key={t} className={`dd-row ${t === tf ? 'on' : ''}`}>
              <button onClick={() => { setTf(t); setOpen(false) }}>{t}</button>
              <button className={`star ${fav.includes(t) ? 'on' : ''}`} title="Favourite" onClick={() => toggleFavTf(t)}>★</button>
            </div>
          ))}
          <form
            className="dd-custom"
            onSubmit={(e) => {
              e.preventDefault()
              const t = parseTf(custom)
              if (!t) return toast('Invalid interval', 'Use e.g. 7, 90, 3h, 1D', 'warn')
              setTf(t)
              setCustom('')
              setOpen(false)
            }}
          >
            <input placeholder="Custom: 7, 45, 3h…" value={custom} onChange={(e) => setCustom(e.target.value)} />
          </form>
        </div>
      )}
    </div>
  )
}

const GRIDS: { id: Grid; label: string }[] = [
  { id: '1', label: '1 chart' },
  { id: '2h', label: '2 side by side' },
  { id: '2v', label: '2 stacked' },
  { id: '3', label: '3 charts' },
  { id: '4', label: '4 charts' },
]

export default function TopBar() {
  const username = useAuth((s) => s.username)
  const logout = useAuth((s) => s.logout)
  const pane = useTerminal((s) => s.panes[s.active])
  const grid = useTerminal((s) => s.grid)
  const theme = useTerminal((s) => s.theme)
  const layoutName = useTerminal((s) => s.layoutName)
  const syncSymbol = useTerminal((s) => s.syncSymbol)
  const syncCrosshair = useTerminal((s) => s.syncCrosshair)
  const replay = useTerminal((s) => s.replay)
  const t = useTerminal.getState
  const open = useUi((s) => s.open)
  const [connected, setConnected] = useState(stream.connected)

  useEffect(() => stream.onStatus(setConnected), [])

  const save = async () => {
    try {
      await saveLayout(layoutName, layoutSpec())
      toast('Layout saved', layoutName, 'success')
    } catch (e) {
      toast('Save failed', String((e as Error).message), 'error')
    }
  }

  return (
    <header className="topbar">
      <span className="logo" title="OpenTerminal">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
          <rect x="7" y="12" width="5" height="12" rx="1" fill="#089981" />
          <rect x="9" y="8" width="1" height="20" fill="#089981" />
          <rect x="19" y="9" width="5" height="10" rx="1" fill="#f23645" />
          <rect x="21" y="5" width="1" height="18" fill="#f23645" />
        </svg>
      </span>

      <button className="sym-btn" onClick={() => open({ kind: 'symbol' })} title="Symbol search (/)">
        <Icon.search /> <b>{pane.symbol}</b>
      </button>

      <Intervals />

      <select className="tb-select" value={pane.chartType} onChange={(e) => t().setChartType(e.target.value as ChartType)} title="Chart type">
        {CHART_TYPES.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button className="tb-icon" onClick={() => open({ kind: 'compare' })} title="Compare or add symbol">
        <Icon.plus />
      </button>

      <button className="tb-btn" onClick={() => open({ kind: 'indicators' })} title="Indicators & strategies">
        <Icon.indicators /> <span>Indicators</span>
      </button>
      <button
        className="tb-btn"
        onClick={() => open({ kind: 'alert', symbol: pane.symbol, price: NaN })}
        title="Create alert"
      >
        <Icon.alert /> <span>Alert</span>
      </button>
      <button
        className={`tb-btn ${replay ? 'on' : ''}`}
        onClick={() => t().setReplay(replay ? null : { paneId: pane.id, start: null, playing: false, speedMs: 500 })}
        title="Bar replay"
      >
        <Icon.replay /> <span>Replay</span>
      </button>

      <span className="spacer" />
      <button className="tb-icon" onClick={() => getPane(pane.id)?.undo()} title="Undo drawing (Ctrl+Z)">
        <Icon.undo />
      </button>
      <button className="tb-icon" onClick={() => getPane(pane.id)?.redo()} title="Redo drawing (Ctrl+Y)">
        <Icon.redo />
      </button>
      <button className="tb-icon" onClick={() => open({ kind: 'chartSettings' })} title="Chart settings">
        <Icon.gear />
      </button>
      <button className="tb-icon" onClick={() => void getPane(pane.id)?.snapshot()} title="Snapshot (Alt+S)">
        <Icon.camera />
      </button>

      <select className="tb-select" value={grid} onChange={(e) => t().setGrid(e.target.value as Grid)} title="Chart layout">
        {GRIDS.map((g) => (
          <option key={g.id} value={g.id}>
            {g.label}
          </option>
        ))}
      </select>
      {GRID_PANES[grid] > 1 && (
        <span className="sync">
          <label title="Change symbol on all charts together">
            <input type="checkbox" checked={syncSymbol} onChange={(e) => t().setSync({ syncSymbol: e.target.checked })} /> sym
          </label>
          <label title="Sync crosshair">
            <input type="checkbox" checked={syncCrosshair} onChange={(e) => t().setSync({ syncCrosshair: e.target.checked })} /> cross
          </label>
        </span>
      )}
      <button className="tb-btn" onClick={() => open({ kind: 'layouts' })} title="Layouts">
        <Icon.layout /> <span>{layoutName}</span>
      </button>
      <button className="tb-icon" onClick={save} title="Save layout">
        <Icon.save />
      </button>
      <button className="tb-icon" onClick={() => t().setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme">
        {theme === 'dark' ? <Icon.sun /> : <Icon.moon />}
      </button>
      <button className="trade-btn sell" onClick={() => open({ kind: 'order', symbol: pane.symbol, side: 'sell' })}>
        Sell
      </button>
      <button className="trade-btn buy" onClick={() => open({ kind: 'order', symbol: pane.symbol, side: 'buy' })}>
        Buy
      </button>
      <span className={`conn ${connected ? 'ok' : ''}`} title={connected ? 'Live' : 'Reconnecting…'} />
      <span className="user">{username}</span>
      <button className="tb-icon" onClick={logout} title="Sign out">
        <Icon.logout />
      </button>
    </header>
  )
}
