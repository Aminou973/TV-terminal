import { formatTime, priceDigits } from '../markets'
import { useCrosshair } from '../store'

/** Values under the crosshair of the active chart (TradingView's Data Window). */
export default function DataWindow() {
  const info = useCrosshair((s) => s.info)
  if (!info?.bar) return <div className="panel"><p className="muted pad">Move the crosshair over a chart.</p></div>
  const b = info.bar
  const d = priceDigits(b.close)
  const n = (v: number | null) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d))
  const up = (info.change ?? 0) >= 0
  return (
    <div className="panel data-window">
      <div className="panel-title plain">{info.symbol} · {info.tf}</div>
      <dl className="det-grid pad">
        <dt>Date</dt><dd>{formatTime(b.time, undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        <dt>Open</dt><dd>{n(b.open)}</dd>
        <dt>High</dt><dd>{n(b.high)}</dd>
        <dt>Low</dt><dd>{n(b.low)}</dd>
        <dt>Close</dt><dd>{n(b.close)}</dd>
        <dt>Change</dt>
        <dd className={up ? 'up' : 'down'}>
          {info.change == null ? '—' : `${up ? '+' : ''}${n(info.change)} (${up ? '+' : ''}${info.changePct?.toFixed(2)}%)`}
        </dd>
        <dt>Volume</dt><dd>{b.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</dd>
        {info.rows.filter((r) => r.value != null).map((r, i) => (
          <div key={i} className="dw-row">
            <dt style={{ color: r.color }}>{r.label}</dt>
            <dd>{r.value == null ? '—' : r.value.toFixed(Math.abs(r.value) < 10 ? 4 : 2)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
