import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getEarningsCalendar,
  getEconCalendar,
  getHeatmap,
  getOverview,
  getWatchlists,
  type EarningsRow,
  type EconEvent,
  type HeatTile,
  type MarketSource,
  type QuoteRow,
} from '../api/client'
import { changeColor, compact, priceText, signedPct } from '../market/format'
import { squarify } from '../market/treemap'
import { useTerminal } from '../store'
import { SourceBadge } from './News'

type Tab = 'overview' | 'heatmap' | 'calendar' | 'earnings'

function useLoad<T>(fn: () => Promise<T>, deps: unknown[], refreshMs: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => fn().then((d) => { if (alive) { setData(d); setError(null) } }).catch((e) => alive && setError(String(e.message)))
    load()
    const timer = setInterval(load, refreshMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error }
}

function Spark({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 60},${18 - ((v - lo) / (hi - lo || 1)) * 16}`).join(' ')
  return (
    <svg className="spark" viewBox="0 0 60 20" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} className={up ? 'up' : 'down'} />
    </svg>
  )
}

// --------------------------------------------------------------- overview --
function Overview({ open }: { open: (s: string) => void }) {
  const { data, error } = useLoad(getOverview, [], 60_000)
  if (error) return <p className="muted pad">Couldn't load the overview: {error}</p>
  if (!data) return <p className="muted pad">Loading…</p>
  const row = (r: QuoteRow) => (
    <button key={r.symbol} className="ov-row" onClick={() => open(r.symbol)} title={`${r.symbol} — open chart`}>
      <span className="ov-name">{r.name}<small>{r.symbol}</small></span>
      <Spark values={r.spark} up={(r.change_pct ?? 0) >= 0} />
      <span className="ov-last">{priceText(r.last)}</span>
      <span className={`ov-chg ${(r.change_pct ?? 0) >= 0 ? 'up' : 'down'}`}>{signedPct(r.change_pct)}</span>
    </button>
  )
  const movers = (title: string, rows: HeatTile[]) => (
    <div className="ov-group">
      <h4>{title}</h4>
      {rows.map((m) => (
        <button key={m.symbol} className="ov-row" onClick={() => open(m.symbol)}>
          <span className="ov-name">{m.symbol}<small>{m.name}</small></span>
          <span className="ov-last">{priceText(m.last)}</span>
          <span className="ov-vol muted">{compact(m.volume)}</span>
          <span className={`ov-chg ${(m.change_pct ?? 0) >= 0 ? 'up' : 'down'}`}>{signedPct(m.change_pct)}</span>
        </button>
      ))}
    </div>
  )
  return (
    <div className="overview">
      {data.groups.map((g) => (
        <div key={g.name} className="ov-group">
          <h4>{g.name}</h4>
          {g.rows.map(row)}
        </div>
      ))}
      {movers('Top gainers', data.gainers)}
      {movers('Top losers', data.losers)}
      {movers('Most active', data.active)}
    </div>
  )
}

// ---------------------------------------------------------------- heatmap --
function Heatmap({ open }: { open: (s: string) => void }) {
  const { data, error } = useLoad(getHeatmap, [], 60_000)
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [sizing, setSizing] = useState<'cap' | 'equal'>('cap')
  const [hover, setHover] = useState<HeatTile | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(() => {
    if (!data || !size.w || !size.h) return []
    const weight = (t: HeatTile) => (sizing === 'cap' ? t.market_cap : 1)
    const sectors = new Map<string, HeatTile[]>()
    for (const t of data.tiles) sectors.set(t.sector, [...(sectors.get(t.sector) ?? []), t])
    const groups = [...sectors.entries()].map(([name, tiles]) => ({ name, tiles, weight: tiles.reduce((s, t) => s + weight(t), 0) }))
    return squarify(groups, (g) => g.weight, { x: 0, y: 0, w: size.w, h: size.h }).map((g) => {
      const head = g.h > 40 && g.w > 60 ? 16 : 0
      return {
        ...g,
        head,
        tiles: squarify(g.item.tiles, weight, { x: g.x + 1, y: g.y + head + 1, w: g.w - 2, h: g.h - head - 2 }),
      }
    })
  }, [data, size, sizing])

  const avg = (tiles: HeatTile[]) => {
    const cap = tiles.reduce((s, t) => s + t.market_cap, 0)
    return tiles.reduce((s, t) => s + (t.change_pct ?? 0) * t.market_cap, 0) / (cap || 1)
  }

  return (
    <div className="heatmap-wrap">
      <div className="heatmap-bar">
        <div className="seg">
          <button className={sizing === 'cap' ? 'on' : ''} onClick={() => setSizing('cap')}>By market cap</button>
          <button className={sizing === 'equal' ? 'on' : ''} onClick={() => setSizing('equal')}>Equal size</button>
        </div>
        <span className="muted small">
          {hover ? `${hover.symbol} · ${hover.name} · ${priceText(hover.last)} · ${signedPct(hover.change_pct)} · cap ${compact(hover.market_cap)}` : 'Large US stocks by sector, coloured by daily change. Click a tile to chart it.'}
        </span>
        <span className="spacer" />
        <div className="heat-legend">
          {[-3, -2, -1, 0, 1, 2, 3].map((p) => (
            <span key={p} style={{ background: changeColor(p) }}>{p > 0 ? `+${p}` : p}%</span>
          ))}
        </div>
      </div>
      <div className="heatmap" ref={ref} onMouseLeave={() => setHover(null)}>
        {error && <p className="muted pad">Couldn't load the heatmap: {error}</p>}
        {!data && !error && <p className="muted pad">Loading…</p>}
        {layout.map((g) => (
          <div key={g.item.name}>
            {g.head > 0 && (
              <div className="heat-sector" style={{ left: g.x, top: g.y, width: g.w, height: g.head }}>
                {g.item.name} <span className={avg(g.item.tiles) >= 0 ? 'up' : 'down'}>{signedPct(avg(g.item.tiles))}</span>
              </div>
            )}
            {g.tiles.map((t) => {
              const big = t.w > 70 && t.h > 40
              const mid = t.w > 34 && t.h > 22
              return (
                <button
                  key={t.item.symbol}
                  className="heat-tile"
                  style={{ left: t.x, top: t.y, width: t.w, height: t.h, background: changeColor(t.item.change_pct) }}
                  onMouseEnter={() => setHover(t.item)}
                  onClick={() => open(t.item.symbol)}
                  aria-label={`${t.item.symbol} ${signedPct(t.item.change_pct)}`}
                >
                  {mid && <b style={{ fontSize: Math.max(10, Math.min(22, Math.sqrt(t.w * t.h) / 5)) }}>{t.item.symbol}</b>}
                  {big && <span>{signedPct(t.item.change_pct)}</span>}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------- economic calendar --
const IMPACT_ORDER = { high: 3, medium: 2, low: 1, holiday: 0 } as const

function EconCalendar() {
  const { data, error } = useLoad(getEconCalendar, [], 15 * 60_000)
  const [impacts, setImpacts] = useState<Set<EconEvent['impact']>>(new Set(['high', 'medium', 'low', 'holiday']))
  const [country, setCountry] = useState('')
  const now = Date.now() / 1000
  const rows = (data?.rows ?? []).filter((e) => impacts.has(e.impact) && (!country || e.country === country))
  const countries = [...new Set((data?.rows ?? []).map((e) => e.country))].sort()
  const nextIdx = rows.findIndex((e) => e.time >= now)
  const days = new Map<string, EconEvent[]>()
  for (const e of rows) {
    const k = new Date(e.time * 1000).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
    days.set(k, [...(days.get(k) ?? []), e])
  }
  const toggle = (i: EconEvent['impact']) => setImpacts((s) => {
    const n = new Set(s)
    if (n.has(i)) n.delete(i)
    else n.add(i)
    return n
  })
  return (
    <div className="econ">
      <div className="econ-bar">
        {(['high', 'medium', 'low', 'holiday'] as const).map((i) => (
          <label key={i} className="inline"><input type="checkbox" checked={impacts.has(i)} onChange={() => toggle(i)} /> <span className={`impact ${i}`} /> {i}</label>
        ))}
        <select value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">All currencies</option>
          {countries.map((c) => <option key={c}>{c}</option>)}
        </select>
        <span className="spacer" />
        <SourceBadge source={data?.source as MarketSource} />
        <span className="muted small">Times in your time zone · this week</span>
      </div>
      <div className="table-wrap">
        {error && <p className="muted pad">Couldn't load the calendar: {error}</p>}
        {!data && !error && <p className="muted pad">Loading…</p>}
        <table className="grid-table econ-table">
          <thead><tr><th>Time</th><th>Cur.</th><th>Impact</th><th>Event</th><th>Actual</th><th>Forecast</th><th>Previous</th></tr></thead>
          <tbody>
            {[...days.entries()].map(([day, evs]) => [
              <tr key={day} className="day-row"><td colSpan={7}>{day}</td></tr>,
              ...evs.map((e) => {
                const i = rows.indexOf(e)
                return (
                  <tr key={`${e.time}-${e.title}-${e.country}`} className={`${e.time < now ? 'past' : ''} ${i === nextIdx ? 'next' : ''}`}>
                    <td>{e.impact === 'holiday' ? 'All day' : new Date(e.time * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{e.country}</td>
                    <td><span className={`impact ${e.impact}`} title={e.impact} />{IMPACT_ORDER[e.impact] >= 2 && <span className={`impact ${e.impact}`} />}{IMPACT_ORDER[e.impact] >= 3 && <span className={`impact ${e.impact}`} />}</td>
                    <td>{e.title}{i === nextIdx && <span className="tag">next</span>}</td>
                    <td><b>{e.actual ?? ''}</b></td>
                    <td>{e.forecast ?? ''}</td>
                    <td className="muted">{e.previous ?? ''}</td>
                  </tr>
                )
              }),
            ])}
            {data && rows.length === 0 && <tr><td colSpan={7} className="muted">No events match the filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// -------------------------------------------------------- earnings calendar --
function Earnings({ open, watch }: { open: (s: string) => void; watch: string[] }) {
  const key = watch.join(',')
  const { data, error } = useLoad(() => getEarningsCalendar(watch), [key], 30 * 60_000)
  const [onlyWatch, setOnlyWatch] = useState(false)
  const watchSet = new Set(watch.map((s) => s.split(':').pop()!.toUpperCase()))
  const rows: EarningsRow[] = (data?.rows ?? []).filter((r) => !onlyWatch || watchSet.has(r.symbol))
  const days = new Map<string, EarningsRow[]>()
  for (const r of rows) {
    const k = new Date(r.time * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    days.set(k, [...(days.get(k) ?? []), r])
  }
  return (
    <div className="econ">
      <div className="econ-bar">
        <label className="inline"><input type="checkbox" checked={onlyWatch} onChange={(e) => setOnlyWatch(e.target.checked)} /> Watchlist only</label>
        <span className="spacer" />
        <SourceBadge source={data?.source as MarketSource} />
      </div>
      <div className="table-wrap">
        {error && <p className="muted pad">Couldn't load earnings: {error}</p>}
        {!data && !error && <p className="muted pad">Loading…</p>}
        <table className="grid-table clickable">
          <thead><tr><th>Symbol</th><th>Company</th><th>EPS estimate</th><th>Revenue estimate</th></tr></thead>
          <tbody>
            {[...days.entries()].map(([day, rs]) => [
              <tr key={day} className="day-row"><td colSpan={4}>{day}</td></tr>,
              ...rs.map((r) => (
                <tr key={r.symbol} onClick={() => open(r.symbol)}>
                  <td><b>{r.symbol}</b>{watchSet.has(r.symbol) && <span className="tag">watchlist</span>}</td>
                  <td>{r.name}</td>
                  <td>{r.eps_estimate != null ? r.eps_estimate.toFixed(2) : '—'}</td>
                  <td>{compact(r.revenue_estimate)}</td>
                </tr>
              )),
            ])}
            {data && rows.length === 0 && <tr><td colSpan={4} className="muted">No upcoming earnings.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function Markets() {
  const [tab, setTab] = useState<Tab>('overview')
  const setSymbol = useTerminal((s) => s.setSymbol)
  const panes = useTerminal((s) => s.panes.map((p) => p.symbol).join(','))
  const [lists, setLists] = useState<string[]>([])
  useEffect(() => {
    getWatchlists().then((ws) => setLists(ws.flatMap((w) => w.symbols))).catch(() => {})
  }, [])
  const watch = useMemo(() => [...new Set([...panes.split(','), ...lists])].filter(Boolean).sort(), [panes, lists])
  const { data: hm } = useLoad(getHeatmap, [], 5 * 60_000)
  return (
    <div className="markets">
      <div className="markets-tabs">
        <div className="seg">
          {(['overview', 'heatmap', 'calendar', 'earnings'] as const).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {{ overview: 'Overview', heatmap: 'Heatmap', calendar: 'Economic calendar', earnings: 'Earnings' }[t]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {tab !== 'calendar' && tab !== 'earnings' && <SourceBadge source={hm?.source} />}
      </div>
      <div className="markets-body">
        {tab === 'overview' && <Overview open={setSymbol} />}
        {tab === 'heatmap' && <Heatmap open={setSymbol} />}
        {tab === 'calendar' && <EconCalendar />}
        {tab === 'earnings' && <Earnings open={setSymbol} watch={watch} />}
      </div>
    </div>
  )
}
