import { useEffect, useMemo, useState } from 'react'
import { deleteLayout, getLayouts, saveLayout, type Layout } from '../api/client'
import { loadRegistry, type IndicatorDef, type InputSpec } from '../chart/indicators'
import { resolveIndicator } from '../chart/catalog'
import { toast, useScripts, useSymbols } from '../data'
import { OrderTicket } from '../panels/TradingPanel'
import { ChartSettingsDialog, CompareDialog, DrawingSettingsDialog, IndicatorTemplates } from './ChartDialogs'
import AlertDialog from './AlertDialog'
import { Modal } from './Modal'
import NotifySettingsDialog from './NotifySettingsDialog'
import { DEFAULT_LAYOUT, layoutSpec, useTerminal, useUi, type LayoutSpec } from '../store'

// ------------------------------------------------------------- symbol ------
function SymbolSearch({ onClose }: { onClose: () => void }) {
  const symbols = useSymbols((s) => s.list)
  const setSymbol = useTerminal((s) => s.setSymbol)
  const [q, setQ] = useState('')
  const [market, setMarket] = useState('all')
  const [cursor, setCursor] = useState(0)
  const markets = useMemo(() => ['all', ...new Set(symbols.map((s) => s.market))], [symbols])
  const list = symbols.filter(
    (s) => (market === 'all' || s.market === market) && s.symbol.toLowerCase().includes(q.trim().toLowerCase()),
  )
  const pick = (sym: string) => {
    setSymbol(sym)
    onClose()
  }
  return (
    <Modal title="Symbol search" onClose={onClose}>
      <input
        autoFocus
        className="search-input"
        placeholder="Symbol, e.g. ES, AAPL, BTC — or type any feed symbol and press Enter"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setCursor(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, list.length - 1))
          if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0))
          if (e.key === 'Enter') pick(list[cursor]?.symbol ?? q.trim())
        }}
      />
      <div className="seg">
        {markets.map((m) => (
          <button key={m} className={market === m ? 'on' : ''} onClick={() => setMarket(m)}>{m}</button>
        ))}
      </div>
      <div className="pick-list">
        {list.map((s, i) => (
          <button key={s.symbol} className={i === cursor ? 'on' : ''} onClick={() => pick(s.symbol)} onMouseEnter={() => setCursor(i)}>
            <b>{s.symbol}</b>
            <small>{s.market}</small>
          </button>
        ))}
        {list.length === 0 && <p className="muted pad">No match. Enter opens “{q}” anyway (add it to a provider's symbol list to get data).</p>}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------- indicators -----
function IndicatorsDialog({ onClose }: { onClose: () => void }) {
  const add = useTerminal((s) => s.addIndicator)
  const scripts = useScripts((s) => s.list)
  const [all, setAll] = useState<IndicatorDef[] | null>(null)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('Favorites')
  const [group, setGroup] = useState<'built-in' | 'community' | 'scripts' | 'templates'>('built-in')

  useEffect(() => {
    loadRegistry().then(setAll).catch((e) => toast('Indicators failed to load', String(e.message), 'error'))
    void useScripts.getState().refresh().catch(() => {})
  }, [])

  const FAVORITES = ['sma', 'ema', 'bb', 'rsi', 'macd', 'vwap', 'atr', 'supertrend', 'ichimoku', 'stoch', 'adx', 'obv', 'stoch-rsi', 'mfi', 'donchian', 'keltner', 'parabolic-sar', 'cvd']
  const cats = useMemo(() => ['Favorites', ...new Set((all ?? []).map((d) => d.category))], [all])

  const list = useMemo(() => {
    if (!all) return []
    const needle = q.trim().toLowerCase()
    let xs = all
    if (group === 'built-in') xs = xs.filter((d) => d.group !== 'community')
    if (group === 'community') xs = xs.filter((d) => d.group === 'community')
    if (needle) xs = all.filter((d) => d.name.toLowerCase().includes(needle) || d.shortName.toLowerCase().includes(needle))
    else if (cat === 'Favorites') xs = FAVORITES.map((k) => all.find((d) => d.key === k)).filter((d): d is IndicatorDef => !!d)
    else xs = xs.filter((d) => d.category === cat)
    return xs.slice(0, 400)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, q, cat, group])

  const pick = (key: string) => {
    add(key)
    toast('Indicator added', key.startsWith('script:') ? key.slice(7) : all?.find((d) => d.key === key)?.name)
  }

  return (
    <Modal title="Indicators, metrics & strategies" onClose={onClose} wide>
      <input autoFocus className="search-input" placeholder={`Search ${all?.length ?? ''} indicators…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="ind-layout">
        <div className="ind-cats">
          <div className="seg vertical">
            <button className={group === 'built-in' ? 'on' : ''} onClick={() => setGroup('built-in')}>Technicals</button>
            <button className={group === 'community' ? 'on' : ''} onClick={() => setGroup('community')}>Community</button>
            <button className={group === 'scripts' ? 'on' : ''} onClick={() => setGroup('scripts')}>My scripts</button>
            <button className={group === 'templates' ? 'on' : ''} onClick={() => setGroup('templates')}>Templates</button>
          </div>
          {group !== 'scripts' && group !== 'templates' && cats.map((c) => (
            <button key={c} className={`cat ${c === cat ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
        {group === 'templates' ? (
          <IndicatorTemplates onApplied={onClose} />
        ) : (
        <div className="pick-list">
          {!all && <p className="muted pad">Loading the indicator library…</p>}
          {group === 'scripts'
            ? scripts.map((s) => (
                <button key={s.id} onClick={() => pick(`script:${s.name}`)}>
                  <b>{s.name}</b>
                  <small>{s.kind}</small>
                </button>
              ))
            : list.map((d) => (
                <button key={d.key} onClick={() => pick(d.key)}>
                  <b>{d.name}</b>
                  <small>{d.category}{d.overlay ? ' · overlay' : ''}</small>
                </button>
              ))}
          {group === 'scripts' && scripts.length === 0 && <p className="muted pad">Write one in the editor (bottom panel) and save it.</p>}
        </div>
        )}
      </div>
    </Modal>
  )
}

// ------------------------------------------------- indicator settings ------
function IndicatorSettings({ uid, onClose }: { uid: string; onClose: () => void }) {
  const inst = useTerminal((s) => s.panes[s.active].indicators.find((i) => i.uid === uid))
  const update = useTerminal((s) => s.updateIndicator)
  const [def, setDef] = useState<IndicatorDef | null>(null)
  const [vals, setVals] = useState<Record<string, unknown>>(inst?.inputs ?? {})

  useEffect(() => {
    if (inst) resolveIndicator(inst.id, []).then(setDef).catch(() => {})
  }, [inst?.id])

  if (!inst) return null
  const value = (i: InputSpec) => (i.id in vals ? vals[i.id] : (def?.defaults[i.id] ?? i.defval))
  const set = (id: string, v: unknown) => setVals((x) => ({ ...x, [id]: v }))

  return (
    <Modal title={def?.name ?? inst.id} onClose={onClose}>
      {!def && <p className="muted">Loading…</p>}
      <div className="form">
        {def?.inputs
          .filter((i) => i.type !== 'color' && i.type !== 'time')
          .map((i) => (
            <label key={i.id}>
              <span>{i.title ?? i.id}</span>
              {i.type === 'bool' ? (
                <input type="checkbox" checked={Boolean(value(i))} onChange={(e) => set(i.id, e.target.checked)} />
              ) : i.options?.length ? (
                <select value={String(value(i))} onChange={(e) => set(i.id, e.target.value)}>
                  {i.options.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : i.type === 'source' ? (
                <select value={String(value(i))} onChange={(e) => set(i.id, e.target.value)}>
                  {['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'].map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : i.type === 'int' || i.type === 'float' ? (
                <input type="number" step={i.step ?? (i.type === 'int' ? 1 : 'any')} min={i.min} max={i.max} value={String(value(i))} onChange={(e) => set(i.id, Number(e.target.value))} />
              ) : (
                <input value={String(value(i))} onChange={(e) => set(i.id, e.target.value)} />
              )}
            </label>
          ))}
        {def && def.inputs.length === 0 && <p className="muted">This indicator has no inputs.</p>}
      </div>
      <div className="modal-foot">
        <button onClick={() => setVals({})}>Defaults</button>
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => { update(uid, { inputs: vals }); onClose() }}>OK</button>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------- layouts -----
function LayoutsDialog({ onClose }: { onClose: () => void }) {
  const current = useTerminal((s) => s.layoutName)
  const apply = useTerminal((s) => s.applyLayout)
  const [layouts, setLayouts] = useState<Layout<LayoutSpec>[]>([])
  const [name, setName] = useState('')
  const reload = () => getLayouts<LayoutSpec>().then(setLayouts).catch(() => {})
  useEffect(() => void reload(), [])

  return (
    <Modal title="Chart layouts" onClose={onClose}>
      <div className="pick-list">
        {layouts.map((l) => (
          <div key={l.id} className={`layout-row ${l.name === current ? 'on' : ''}`}>
            <button onClick={() => { apply(l.name, l.spec); onClose() }}>
              <b>{l.name}</b>
              <small>{l.spec.grid} · {l.spec.panes.slice(0, Number(l.spec.grid[0])).map((p) => p.symbol).join(', ')}</small>
            </button>
            <button className="danger" onClick={() => deleteLayout(l.id).then(reload)}>×</button>
          </div>
        ))}
        {layouts.length === 0 && <p className="muted pad">No saved layouts yet.</p>}
      </div>
      <div className="modal-foot">
        <input placeholder="Save current as…" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="primary"
          disabled={!name.trim()}
          onClick={async () => {
            await saveLayout(name.trim(), layoutSpec())
            useTerminal.setState({ layoutName: name.trim() })
            setName('')
            void reload()
            toast('Layout saved', name.trim(), 'success')
          }}
        >
          Save
        </button>
        <button onClick={() => { apply('Default', DEFAULT_LAYOUT); onClose() }}>Reset</button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- host -----
export default function Dialogs() {
  const dialog = useUi((s) => s.dialog)
  const close = useUi((s) => s.close)
  if (!dialog) return null
  switch (dialog.kind) {
    case 'symbol':
      return <SymbolSearch onClose={close} />
    case 'indicators':
      return <IndicatorsDialog onClose={close} />
    case 'indicatorSettings':
      return <IndicatorSettings uid={dialog.uid} onClose={close} />
    case 'alert':
      return <AlertDialog symbol={dialog.symbol} price={dialog.price} line={dialog.line} alertId={dialog.alertId} onClose={close} />
    case 'notifySettings':
      return <NotifySettingsDialog onClose={close} />
    case 'layouts':
      return <LayoutsDialog onClose={close} />
    case 'chartSettings':
      return <ChartSettingsDialog onClose={close} />
    case 'compare':
      return <CompareDialog onClose={close} />
    case 'drawingSettings':
      return <DrawingSettingsDialog paneId={dialog.paneId} drawingId={dialog.drawingId} onClose={close} />
    case 'order':
      return (
        <Modal title={`${dialog.side === 'buy' ? 'Buy' : 'Sell'} ${dialog.symbol}`} onClose={close}>
          <OrderTicket symbol={dialog.symbol} side={dialog.side} price={dialog.price} onDone={close} />
        </Modal>
      )
  }
}
