import { useEffect, useState } from 'react'
import { getStats, type Stats } from '../api/client'
import { stream } from '../chart/stream'
import { useSymbols } from '../data'
import { useTerminal } from '../store'
import Fundamentals from './Fundamentals'

const digits = (v: number) => (Math.abs(v) < 1 ? 5 : Math.abs(v) < 10 ? 4 : 2)

export default function Details() {
  const symbol = useTerminal((s) => s.panes[s.active].symbol)
  const market = useSymbols((s) => s.list.find((x) => x.symbol === symbol)?.market)
  const [st, setSt] = useState<Stats | null>(null)
  const [last, setLast] = useState<number | null>(null)
  const [quote, setQuote] = useState<{ bid: number; ask: number } | null>(null)

  useEffect(() => {
    setSt(null)
    setLast(null)
    setQuote(null)
    const load = () => getStats([symbol]).then(({ stats }) => setSt(stats[0] ?? null)).catch(() => {})
    load()
    const timer = setInterval(load, 15_000)
    const off = stream.subscribeQuotes([symbol], (q) => {
      setLast(q.last)
      if (q.bid && q.ask) setQuote({ bid: q.bid, ask: q.ask })
    })
    return () => {
      clearInterval(timer)
      off()
    }
  }, [symbol])

  const px = last ?? st?.last
  const d = digits(px ?? 100)
  const chg = px != null && st ? px - st.prev_close : null
  const pct = chg != null && st?.prev_close ? (chg / st.prev_close) * 100 : null
  const range = st ? st.high - st.low : 0
  const pos = st && range > 0 && px != null ? ((px - st.low) / range) * 100 : 50

  return (
    <div className="panel details">
      <div className="det-sym">{symbol}</div>
      <div className="small muted">{market ?? '—'} · session</div>
      <div className="det-px">
        <span>{px != null ? px.toFixed(d) : '—'}</span>
        {chg != null && (
          <b className={chg >= 0 ? 'up' : 'down'}>
            {chg >= 0 ? '+' : ''}{chg.toFixed(d)} ({pct! >= 0 ? '+' : ''}{pct!.toFixed(2)}%)
          </b>
        )}
      </div>
      {st && (
        <>
          <div className="det-range">
            <span>{st.low.toFixed(d)}</span>
            <div className="bar"><i style={{ left: `${pos}%` }} /></div>
            <span>{st.high.toFixed(d)}</span>
          </div>
          <dl className="det-grid">
            <dt>Open</dt><dd>{st.open.toFixed(d)}</dd>
            <dt>Prev close</dt><dd>{st.prev_close.toFixed(d)}</dd>
            <dt>High</dt><dd>{st.high.toFixed(d)}</dd>
            <dt>Low</dt><dd>{st.low.toFixed(d)}</dd>
            <dt>Volume</dt><dd>{st.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</dd>
            {quote && (<><dt>Bid</dt><dd>{quote.bid.toFixed(d)}</dd><dt>Ask</dt><dd>{quote.ask.toFixed(d)}</dd></>)}
          </dl>
        </>
      )}
      {!st && <p className="muted pad">No session data yet.</p>}
      <Fundamentals symbol={symbol} />
    </div>
  )
}
