import { useEffect, useState } from 'react'
import { stream, type BookMessage, type TradeMessage } from '../chart/stream'
import { useTerminal } from '../store'

const digits = (v: number) => (Math.abs(v) < 1 ? 5 : Math.abs(v) < 10 ? 4 : 2)

export default function Depth() {
  const symbol = useTerminal((s) => s.panes[s.active].symbol)
  const [book, setBook] = useState<BookMessage | null>(null)
  const [trades, setTrades] = useState<TradeMessage[]>([])

  useEffect(() => {
    setBook(null)
    setTrades([])
    const offBook = stream.subscribeBook(symbol, setBook)
    let buf: TradeMessage[] = []
    const offTrades = stream.subscribeTrades(symbol, (t) => buf.push(t))
    // batch busy prints into ~4 renders/s
    const timer = setInterval(() => {
      if (!buf.length) return
      const add = buf.reverse()
      buf = []
      setTrades((ts) => [...add, ...ts].slice(0, 60))
    }, 250)
    return () => {
      offBook()
      offTrades()
      clearInterval(timer)
    }
  }, [symbol])

  const bids = book?.bids.slice(0, 12) ?? []
  const asks = book?.asks.slice(0, 12) ?? []
  const max = Math.max(1, ...bids.map((b) => b[1]), ...asks.map((a) => a[1]))
  const ref = bids[0]?.[0] ?? asks[0]?.[0] ?? trades[0]?.price ?? 1
  const d = digits(ref)
  const spread = bids[0] && asks[0] ? asks[0][0] - bids[0][0] : null

  return (
    <div className="panel depth">
      <div className="panel-title">Order book · {symbol}</div>
      {!book ? (
        <p className="muted pad">No depth for this symbol. Books stream from the simulator, crypto exchanges and NinjaTrader.</p>
      ) : (
        <div className="book">
          {[...asks].reverse().map(([p, s]) => (
            <div key={`a${p}`} className="book-row ask">
              <i style={{ width: `${(s / max) * 100}%` }} />
              <span>{p.toFixed(d)}</span>
              <span>{s.toLocaleString()}</span>
            </div>
          ))}
          <div className="book-spread">{spread != null ? `Spread ${spread.toFixed(d)}` : '—'}</div>
          {bids.map(([p, s]) => (
            <div key={`b${p}`} className="book-row bid">
              <i style={{ width: `${(s / max) * 100}%` }} />
              <span>{p.toFixed(d)}</span>
              <span>{s.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
      <div className="panel-title">Time &amp; sales</div>
      <div className="tape">
        {trades.length === 0 && <p className="muted pad">Waiting for prints…</p>}
        {trades.map((t, i) => (
          <div key={`${t.ts_ms}-${i}`} className={`tape-row ${t.side}`}>
            <span>{new Date(t.ts_ms).toLocaleTimeString()}</span>
            <span>{t.price.toFixed(d)}</span>
            <span>{t.size.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
