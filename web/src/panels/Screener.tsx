import { useEffect, useMemo, useState } from 'react'
import { getScreener, type ScreenerRow } from '../api/client'
import { toast } from '../data'
import { priceDigits } from '../markets'
import { useTerminal, type Tf } from '../store'

type Col = { key: keyof ScreenerRow; label: string; fmt: (r: ScreenerRow) => string; tone?: (r: ScreenerRow) => number }

const n2 = (v: number | null, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d))

const COLS: Col[] = [
  { key: 'symbol', label: 'Symbol', fmt: (r) => r.symbol },
  { key: 'market', label: 'Market', fmt: (r) => r.market },
  { key: 'last', label: 'Last', fmt: (r) => n2(r.last, priceDigits(r.last)) },
  { key: 'change_pct', label: 'Chg %', fmt: (r) => `${r.change_pct >= 0 ? '+' : ''}${n2(r.change_pct)}%`, tone: (r) => r.change_pct },
  { key: 'volume', label: 'Volume', fmt: (r) => r.volume.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
  { key: 'rsi14', label: 'RSI 14', fmt: (r) => n2(r.rsi14, 1), tone: (r) => (r.rsi14 == null ? 0 : r.rsi14 > 70 ? -1 : r.rsi14 < 30 ? 1 : 0) },
  { key: 'atr_pct', label: 'ATR %', fmt: (r) => n2(r.atr_pct) },
  { key: 'above_sma20', label: '> SMA20', fmt: (r) => (r.sma20 == null ? '—' : r.above_sma20 ? '✓' : '✗'), tone: (r) => (r.above_sma20 ? 1 : -1) },
  { key: 'above_sma50', label: '> SMA50', fmt: (r) => (r.sma50 == null ? '—' : r.above_sma50 ? '✓' : '✗'), tone: (r) => (r.above_sma50 ? 1 : -1) },
]

export default function Screener() {
  const setSymbol = useTerminal((s) => s.setSymbol)
  const [tf, setTf] = useState<Tf>('1D')
  const [rows, setRows] = useState<ScreenerRow[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [market, setMarket] = useState('all')
  const [minChg, setMinChg] = useState('')
  const [rsiMin, setRsiMin] = useState('')
  const [rsiMax, setRsiMax] = useState('')
  const [trend, setTrend] = useState<'any' | 'up' | 'down'>('any')
  const [sort, setSort] = useState<{ key: keyof ScreenerRow; dir: 1 | -1 }>({ key: 'change_pct', dir: -1 })

  const load = () => {
    setLoading(true)
    getScreener(tf)
      .then((r) => setRows(r.rows))
      .catch((e) => toast('Screener failed', String(e.message), 'error'))
      .finally(() => setLoading(false))
  }
  useEffect(load, [tf])

  const markets = useMemo(() => [...new Set(rows.map((r) => r.market))], [rows])
  const shown = useMemo(() => {
    const out = rows.filter((r) => {
      if (q && !r.symbol.toLowerCase().includes(q.toLowerCase())) return false
      if (market !== 'all' && r.market !== market) return false
      if (minChg && r.change_pct < Number(minChg)) return false
      if (rsiMin && (r.rsi14 == null || r.rsi14 < Number(rsiMin))) return false
      if (rsiMax && (r.rsi14 == null || r.rsi14 > Number(rsiMax))) return false
      if (trend === 'up' && !(r.above_sma20 && r.above_sma50)) return false
      if (trend === 'down' && (r.above_sma20 || r.above_sma50)) return false
      return true
    })
    const { key, dir } = sort
    return out.sort((a, b) => {
      const x = a[key] as number | string | boolean | null
      const y = b[key] as number | string | boolean | null
      if (x == null) return 1
      if (y == null) return -1
      return (x > y ? 1 : x < y ? -1 : 0) * dir
    })
  }, [rows, q, market, minChg, rsiMin, rsiMax, trend, sort])

  return (
    <div className="screener">
      <div className="tester-bar">
        <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="all">All markets</option>
          {markets.map((m) => <option key={m}>{m}</option>)}
        </select>
        <select value={tf} onChange={(e) => setTf(e.target.value as Tf)}>
          {(['15m', '1h', '4h', '1D', '1W'] as Tf[]).map((t) => <option key={t}>{t}</option>)}
        </select>
        <label>Chg% ≥ <input type="number" value={minChg} onChange={(e) => setMinChg(e.target.value)} /></label>
        <label>RSI <input type="number" placeholder="min" value={rsiMin} onChange={(e) => setRsiMin(e.target.value)} /> – <input type="number" placeholder="max" value={rsiMax} onChange={(e) => setRsiMax(e.target.value)} /></label>
        <select value={trend} onChange={(e) => setTrend(e.target.value as 'any' | 'up' | 'down')}>
          <option value="any">Any trend</option>
          <option value="up">Above SMA20 &amp; 50</option>
          <option value="down">Below SMA20 &amp; 50</option>
        </select>
        <button onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        <span className="muted small">{shown.length} / {rows.length}</span>
      </div>
      <div className="table-wrap">
        <table className="grid-table clickable">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} onClick={() => setSort({ key: c.key, dir: sort.key === c.key ? (-sort.dir as 1 | -1) : -1 })}>
                  {c.label}{sort.key === c.key ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.symbol} onClick={() => setSymbol(r.symbol)}>
                {COLS.map((c) => {
                  const t = c.tone?.(r) ?? 0
                  return <td key={c.key} className={t > 0 ? 'up' : t < 0 ? 'down' : ''}>{c.fmt(r)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
