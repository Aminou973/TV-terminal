import { useEffect, useMemo, useState } from 'react'
import { annotateTrade, getTrades, type PaperTrade } from '../api/client'
import { stream } from '../chart/stream'
import { toast } from '../data'
import { tickSize } from '../markets'
import { useTerminal } from '../store'
import { formatDuration, groupPnl, journalStats, tagList, tradesToCsv } from '../trading/journal'
import { money, signedMoney, tickDigits } from '../trading/math'

type Range = 'today' | '7d' | '30d' | 'all'
const RANGE_MS: Record<Range, number> = { today: 0, '7d': 7 * 864e5, '30d': 30 * 864e5, all: Infinity }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function EquityCurve({ points }: { points: { t: number; v: number }[] }) {
  if (points.length < 2) return <div className="equity-empty muted small">The equity curve appears after two closed trades.</div>
  const w = 600
  const h = 120
  const vs = [0, ...points.map((p) => p.v)]
  const lo = Math.min(...vs)
  const hi = Math.max(...vs)
  const y = (v: number) => h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 12)
  const x = (i: number) => (i / points.length) * w
  const line = [`0,${y(0)}`, ...points.map((p, i) => `${x(i + 1)},${y(p.v)}`)].join(' ')
  const end = points[points.length - 1].v
  return (
    <svg className="equity" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <line x1={0} x2={w} y1={y(0)} y2={y(0)} className="zero" />
      <polygon points={`0,${y(0)} ${line} ${w},${y(0)}`} className={end >= 0 ? 'fill up' : 'fill down'} />
      <polyline points={line} className={end >= 0 ? 'stroke up' : 'stroke down'} />
    </svg>
  )
}

function TradeNotes({ trade, onSaved }: { trade: PaperTrade; onSaved: (t: PaperTrade) => void }) {
  const [notes, setNotes] = useState(trade.notes)
  const [tags, setTags] = useState(trade.tags)
  const dirty = notes !== trade.notes || tags !== trade.tags
  const save = () =>
    annotateTrade(trade.id, { notes, tags })
      .then((t) => { onSaved(t); toast('Journal entry saved') })
      .catch((e) => toast('Save failed', String(e.message), 'error'))
  return (
    <div className="trade-notes">
      <label>Tags <input value={tags} placeholder="breakout, A+ setup, fomo…" onChange={(e) => setTags(e.target.value)} /></label>
      <label>Notes <textarea rows={3} value={notes} placeholder="Why did you take it? What went right or wrong?" onChange={(e) => setNotes(e.target.value)} /></label>
      <button className="primary" disabled={!dirty} onClick={save}>Save</button>
    </div>
  )
}

export default function Journal() {
  const [trades, setTrades] = useState<PaperTrade[]>([])
  const [range, setRange] = useState<Range>('all')
  const [symbolFilter, setSymbolFilter] = useState('')
  const [side, setSide] = useState<'' | 'long' | 'short'>('')
  const [result, setResult] = useState<'' | 'win' | 'loss'>('')
  const [tag, setTag] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const [view, setView] = useState<'trades' | 'breakdown'>('trades')
  const setSymbol = useTerminal((s) => s.setSymbol)

  useEffect(() => {
    const load = () => getTrades().then(setTrades).catch(() => {})
    load()
    // closed trades arrive with fills
    const off = stream.onUser((m) => m.type === 'paper' && (m as { event?: string }).event === 'fill' && load())
    const timer = setInterval(load, 15000) // MAE / MFE of open trades
    return () => {
      off()
      clearInterval(timer)
    }
  }, [])

  const symbols = useMemo(() => [...new Set(trades.map((t) => t.symbol))].sort(), [trades])
  const tags = useMemo(() => [...new Set(trades.flatMap(tagList))].sort(), [trades])
  const filtered = useMemo(() => {
    const now = Date.now()
    const start = range === 'today' ? new Date().setHours(0, 0, 0, 0) : now - RANGE_MS[range]
    return trades.filter(
      (t) =>
        t.entry_ms >= start &&
        (!symbolFilter || t.symbol === symbolFilter) &&
        (!side || t.side === side) &&
        (!result || t.status === 'closed' && (result === 'win' ? t.pnl > 0 : t.pnl < 0)) &&
        (!tag || tagList(t).includes(tag)),
    )
  }, [trades, range, symbolFilter, side, result, tag])
  const s = useMemo(() => journalStats(filtered), [filtered])

  const exportCsv = () => {
    const blob = new Blob([tradesToCsv(filtered)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `openterminal-journal-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const stat = (label: string, value: string, tone?: 'up' | 'down') => (
    <div className="jstat"><span>{label}</span><b className={tone}>{value}</b></div>
  )
  const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : undefined)

  return (
    <div className="journal">
      <div className="journal-filters">
        <div className="seg">
          {(['today', '7d', '30d', 'all'] as const).map((r) => (
            <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r === 'all' ? 'All' : r === 'today' ? 'Today' : r}</button>
          ))}
        </div>
        <select value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)}>
          <option value="">All symbols</option>
          {symbols.map((x) => <option key={x}>{x}</option>)}
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value as typeof side)}>
          <option value="">Long &amp; short</option><option value="long">Long</option><option value="short">Short</option>
        </select>
        <select value={result} onChange={(e) => setResult(e.target.value as typeof result)}>
          <option value="">Wins &amp; losses</option><option value="win">Winners</option><option value="loss">Losers</option>
        </select>
        {tags.length > 0 && (
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All tags</option>
            {tags.map((x) => <option key={x}>{x}</option>)}
          </select>
        )}
        <span className="spacer" />
        <div className="seg">
          <button className={view === 'trades' ? 'on' : ''} onClick={() => setView('trades')}>Trades</button>
          <button className={view === 'breakdown' ? 'on' : ''} onClick={() => setView('breakdown')}>Breakdown</button>
        </div>
        <button disabled={!filtered.length} onClick={exportCsv}>Export CSV</button>
      </div>
      <div className="journal-top">
        <div className="jstats">
          {stat('Net P&L', signedMoney(s.net), tone(s.net))}
          {stat('Trades', String(s.trades))}
          {stat('Win rate', s.trades ? `${(s.winRate * 100).toFixed(1)}%` : '—')}
          {stat('Profit factor', s.trades ? (Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞') : '—')}
          {stat('Expectancy', s.trades ? signedMoney(s.expectancy) : '—', tone(s.expectancy))}
          {stat('Avg win / loss', s.trades ? `${money(s.avgWin)} / ${money(s.avgLoss)}` : '—')}
          {stat('Largest win', money(s.largestWin), s.largestWin ? 'up' : undefined)}
          {stat('Largest loss', money(s.largestLoss), s.largestLoss ? 'down' : undefined)}
          {stat('Max drawdown', money(-s.maxDrawdown), s.maxDrawdown ? 'down' : undefined)}
          {stat('Streaks', `${s.maxConsecWins}W / ${s.maxConsecLosses}L`)}
          {stat('Avg hold', s.trades ? formatDuration(s.avgHoldMs) : '—')}
          {stat('Commission', money(s.commission))}
        </div>
        <EquityCurve points={s.equity} />
      </div>
      {view === 'breakdown' ? (
        <div className="journal-breakdown">
          {[
            ['By symbol', groupPnl(filtered, (t) => [t.symbol])],
            ['By side', groupPnl(filtered, (t) => [t.side])],
            ['By tag', groupPnl(filtered, (t) => (tagList(t).length ? tagList(t) : ['(untagged)']))],
            ['By weekday', groupPnl(filtered, (t) => [WEEKDAYS[new Date(t.entry_ms).getDay()]])],
            ['By hour', groupPnl(filtered, (t) => [`${String(new Date(t.entry_ms).getHours()).padStart(2, '0')}:00`])],
          ].map(([title, rows]) => (
            <table key={title as string} className="grid-table">
              <thead><tr><th>{title as string}</th><th>Trades</th><th>Win %</th><th>Net</th></tr></thead>
              <tbody>
                {(rows as ReturnType<typeof groupPnl>).map((r) => (
                  <tr key={r.key}><td>{r.key}</td><td>{r.trades}</td><td>{(r.winRate * 100).toFixed(0)}%</td><td className={tone(r.net)}>{signedMoney(r.net)}</td></tr>
                ))}
                {(rows as unknown[]).length === 0 && <tr><td colSpan={4} className="muted">No closed trades</td></tr>}
              </tbody>
            </table>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="grid-table clickable">
            <thead>
              <tr><th>#</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Opened</th><th>Held</th><th>P&amp;L</th><th>MAE</th><th>MFE</th><th>Tags</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const d = tickDigits(tickSize(t.symbol, t.entry_price))
                return [
                  <tr key={t.id} className={open === t.id ? 'sel' : ''} onClick={() => setOpen(open === t.id ? null : t.id)} onDoubleClick={() => setSymbol(t.symbol)}>
                    <td>{t.id}</td>
                    <td>{t.symbol}</td>
                    <td className={t.side === 'long' ? 'up' : 'down'}>{t.side}</td>
                    <td>{t.qty}</td>
                    <td>{t.entry_price.toFixed(d)}</td>
                    <td>{t.exit_price != null ? t.exit_price.toFixed(d) : <span className="muted">open</span>}</td>
                    <td>{new Date(t.entry_ms).toLocaleString()}</td>
                    <td>{formatDuration((t.exit_ms ?? Date.now()) - t.entry_ms)}</td>
                    <td className={tone(t.pnl)}>{t.status === 'open' ? <span className="muted">{signedMoney(t.pnl)}</span> : signedMoney(t.pnl)}</td>
                    <td className="down">{money(t.mae)}</td>
                    <td className="up">{money(t.mfe)}</td>
                    <td>{tagList(t).map((x) => <span key={x} className="tag">{x}</span>)}</td>
                    <td className="notes-cell">{t.notes || <span className="muted">+ add</span>}</td>
                  </tr>,
                  open === t.id && (
                    <tr key={`n${t.id}`} className="notes-row">
                      <td colSpan={13}>
                        <TradeNotes trade={t} onSaved={(nt) => setTrades((ts) => ts.map((x) => (x.id === nt.id ? nt : x)))} />
                      </td>
                    </tr>
                  ),
                ]
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={13} className="muted">No trades yet. Every flat → position → flat round trip on the paper account lands here.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
