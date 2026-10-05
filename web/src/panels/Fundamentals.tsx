import { useEffect, useState } from 'react'
import { getFundamentals, type EarningsPoint, type Fundamentals as F } from '../api/client'
import { compact, num, pct, priceText } from '../market/format'
import { SourceBadge } from './News'

const n = (f: F, k: string) => (typeof f[k] === 'number' ? (f[k] as number) : null)

function EpsChart({ data }: { data: EarningsPoint[] }) {
  const rows = data.filter((d) => d.eps_actual != null || d.eps_estimate != null).slice(-8)
  if (!rows.length) return null
  const vals = rows.flatMap((r) => [r.eps_actual ?? 0, r.eps_estimate ?? 0])
  const hi = Math.max(0, ...vals)
  const lo = Math.min(0, ...vals)
  const w = 280
  const h = 90
  const y = (v: number) => 8 + ((hi - v) / (hi - lo || 1)) * (h - 22)
  const step = w / rows.length
  return (
    <svg className="eps-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="EPS estimate vs actual by quarter">
      <line x1={0} x2={w} y1={y(0)} y2={y(0)} className="zero" />
      {rows.map((r, i) => {
        const cx = i * step + step / 2
        const beat = r.eps_actual != null && r.eps_estimate != null ? r.eps_actual >= r.eps_estimate : null
        return (
          <g key={r.time}>
            <title>
              {new Date(r.time * 1000).toLocaleDateString()} · EPS {r.eps_actual ?? '—'} vs est. {r.eps_estimate ?? '—'}
              {r.surprise_pct != null ? ` (${r.surprise_pct > 0 ? '+' : ''}${r.surprise_pct.toFixed(1)}%)` : ''}
            </title>
            {r.eps_estimate != null && <circle cx={cx} cy={y(r.eps_estimate)} r={5} className="est" />}
            {r.eps_actual != null && <circle cx={cx} cy={y(r.eps_actual)} r={4} className={beat == null ? 'act' : beat ? 'act beat' : 'act miss'} />}
            <text x={cx} y={h - 3} textAnchor="middle">
              {`Q${Math.floor(new Date(r.time * 1000).getUTCMonth() / 3) + 1} '${String(new Date(r.time * 1000).getUTCFullYear()).slice(2)}`}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

/** Key statistics, valuation, profitability, analyst view and earnings for a symbol. */
export default function Fundamentals({ symbol }: { symbol: string }) {
  const [f, setF] = useState<F | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)

  useEffect(() => {
    let alive = true
    setF(null)
    setError(null)
    getFundamentals(symbol)
      .then((r) => alive && setF(r))
      .catch((e) => alive && setError(String(e.message)))
    return () => {
      alive = false
    }
  }, [symbol])

  if (error) return <p className="muted small pad">Fundamentals unavailable: {error}</p>
  if (!f) return <p className="muted small pad">Loading fundamentals…</p>

  const equity = (f.quote_type ?? 'EQUITY') === 'EQUITY'
  const price = n(f, 'price')
  const tMean = n(f, 'target_mean')
  const tLo = n(f, 'target_low')
  const tHi = n(f, 'target_high')
  const lo52 = n(f, 'low_52w')
  const hi52 = n(f, 'high_52w')
  const pos52 = price != null && lo52 != null && hi52 != null && hi52 > lo52 ? ((price - lo52) / (hi52 - lo52)) * 100 : null
  const nextE = f.next_earnings ? new Date(f.next_earnings * 1000) : null
  const days = f.next_earnings ? Math.ceil((f.next_earnings - Date.now() / 1000) / 86400) : null

  return (
    <div className="fundamentals">
      <div className="fund-head">
        <div>
          <b>{f.name || f.short_name || f.yahoo}</b>
          <div className="small muted">{[f.sector, f.industry, f.exchange].filter(Boolean).join(' · ') || f.quote_type}</div>
        </div>
        <SourceBadge source={f.source} />
      </div>

      {pos52 != null && (
        <div className="fund-block">
          <div className="small muted">52-week range</div>
          <div className="det-range">
            <span>{priceText(lo52)}</span>
            <div className="bar"><i style={{ left: `${pos52}%` }} /></div>
            <span>{priceText(hi52)}</span>
          </div>
        </div>
      )}

      {equity && (
        <>
          {nextE && (
            <div className="fund-earn">
              <span>Next earnings</span>
              <b>{nextE.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</b>
              {days != null && days >= 0 && <span className="muted small">in {days}d</span>}
              {n(f, 'eps_estimate') != null && <span className="muted small">EPS est. {num(n(f, 'eps_estimate'))}</span>}
            </div>
          )}
          <dl className="det-grid">
            <Row label="Market cap" value={compact(n(f, 'market_cap'))} />
            <Row label="P/E (TTM)" value={num(n(f, 'pe'))} />
            <Row label="Forward P/E" value={num(n(f, 'forward_pe'))} />
            <Row label="EPS (TTM)" value={num(n(f, 'eps'))} />
            <Row label="Dividend yield" value={pct(n(f, 'dividend_yield'), 2, true)} />
            <Row label="Beta" value={num(n(f, 'beta'))} />
            <Row label="Avg volume" value={compact(n(f, 'avg_volume'))} />
            <Row label="Revenue (TTM)" value={compact(n(f, 'revenue'))} />
            <Row label="Profit margin" value={pct(n(f, 'profit_margin'), 1, true)} />
            {more && (
              <>
                <Row label="Enterprise value" value={compact(n(f, 'enterprise_value'))} />
                <Row label="PEG" value={num(n(f, 'peg'))} />
                <Row label="Price / book" value={num(n(f, 'price_to_book'))} />
                <Row label="Price / sales" value={num(n(f, 'price_to_sales'))} />
                <Row label="Revenue growth" value={pct(n(f, 'revenue_growth'), 1, true)} />
                <Row label="Earnings growth" value={pct(n(f, 'earnings_growth'), 1, true)} />
                <Row label="Gross margin" value={pct(n(f, 'gross_margin'), 1, true)} />
                <Row label="Operating margin" value={pct(n(f, 'operating_margin'), 1, true)} />
                <Row label="EBITDA" value={compact(n(f, 'ebitda'))} />
                <Row label="Return on equity" value={pct(n(f, 'roe'), 1, true)} />
                <Row label="Debt / equity" value={num(n(f, 'debt_to_equity'))} />
                <Row label="Free cash flow" value={compact(n(f, 'free_cash_flow'))} />
                <Row label="Cash" value={compact(n(f, 'total_cash'))} />
                <Row label="Debt" value={compact(n(f, 'total_debt'))} />
                <Row label="Shares out" value={compact(n(f, 'shares_outstanding'))} />
                <Row label="Payout ratio" value={pct(n(f, 'payout_ratio'), 1, true)} />
                {f.employees != null && <Row label="Employees" value={f.employees.toLocaleString()} />}
              </>
            )}
          </dl>
          <button className="link-btn" onClick={() => setMore((v) => !v)}>{more ? 'Fewer stats' : 'More stats'}</button>

          {tMean != null && price != null && (
            <div className="fund-block">
              <div className="small muted">
                Analyst target · {f.analysts ? `${f.analysts} analysts` : ''} {f.recommendation ? `· ${String(f.recommendation).replace('_', ' ')}` : ''}
              </div>
              {tLo != null && tHi != null && tHi > tLo && (
                <div className="target-bar">
                  <i className="now" style={{ left: `${Math.max(0, Math.min(100, ((price - tLo) / (tHi - tLo)) * 100))}%` }} title={`Price ${priceText(price)}`} />
                  <i className="mean" style={{ left: `${((tMean - tLo) / (tHi - tLo)) * 100}%` }} title={`Mean target ${priceText(tMean)}`} />
                </div>
              )}
              <div className="target-row small">
                <span>{priceText(tLo)}</span>
                <b className={tMean >= price ? 'up' : 'down'}>
                  {priceText(tMean)} ({tMean >= price ? '+' : ''}{(((tMean - price) / price) * 100).toFixed(1)}%)
                </b>
                <span>{priceText(tHi)}</span>
              </div>
            </div>
          )}

          {(f.earnings?.length ?? 0) > 0 && (
            <div className="fund-block">
              <div className="small muted">
                EPS: <span className="legend-dot est" /> estimate <span className="legend-dot act beat" /> beat <span className="legend-dot act miss" /> miss
              </div>
              <EpsChart data={f.earnings!} />
            </div>
          )}

          {f.summary && (
            <details className="fund-about">
              <summary>About</summary>
              <p>{f.summary}</p>
              {f.website && <a href={f.website} target="_blank" rel="noopener noreferrer">{f.website}</a>}
            </details>
          )}
        </>
      )}
    </div>
  )
}
