import { useEffect, useState } from 'react'
import { cancelOrder, closePosition, getNinjaStatus, placeNinjaOrder, placeOrder, resetPaper, type NinjaStatus, type PaperOrder } from '../api/client'
import { toast, usePaper } from '../data'
import { priceDigits } from '../markets'
import { useTerminal } from '../store'

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function OrderTicket({ symbol, side: initialSide, price: initialPrice, onDone }: { symbol: string; side?: 'buy' | 'sell'; price?: number; onDone?: () => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide ?? 'buy')
  const [type, setType] = useState<PaperOrder['type']>(initialPrice ? 'limit' : 'market')
  const [qty, setQty] = useState(1)
  const [price, setPrice] = useState(initialPrice ? String(initialPrice) : '')
  const [busy, setBusy] = useState(false)
  const [route, setRoute] = useState<'paper' | 'ninja'>('paper')
  const [ninja, setNinja] = useState<NinjaStatus | null>(null)

  useEffect(() => {
    getNinjaStatus().then(setNinja).catch(() => {})
  }, [])

  const submit = async () => {
    setBusy(true)
    try {
      if (route === 'ninja') {
        if (!window.confirm(`Send a REAL order to NinjaTrader account ${ninja?.account}?\n${side.toUpperCase()} ${qty} ${symbol} ${type}${type !== 'market' ? ' @ ' + price : ''}`)) return
        const r = await placeNinjaOrder({ symbol, side, type, qty, price: type === 'market' ? undefined : Number(price) })
        toast('Sent to NinjaTrader', `${r.account} · ${r.contract} · ref ${r.ref}`)
        onDone?.()
        return
      }
      const o = await placeOrder({ symbol, side, type, qty, price: type === 'market' ? undefined : Number(price) })
      if (o.status === 'working') toast('Order working', `${side.toUpperCase()} ${qty} ${symbol} ${type} @ ${o.price}`)
      await usePaper.getState().refresh()
      onDone?.()
    } catch (e) {
      toast('Order rejected', String((e as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ticket">
      <div className="seg ticket-side">
        <button className={side === 'buy' ? 'on buy' : ''} onClick={() => setSide('buy')}>Buy</button>
        <button className={side === 'sell' ? 'on sell' : ''} onClick={() => setSide('sell')}>Sell</button>
      </div>
      <div className="seg">
        {(['market', 'limit', 'stop'] as const).map((t) => (
          <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>{t}</button>
        ))}
      </div>
      {ninja?.can_trade && (
        <label>
          Route
          <select value={route} onChange={(e) => setRoute(e.target.value as 'paper' | 'ninja')}>
            <option value="paper">Paper (simulated)</option>
            <option value="ninja" disabled={!ninja.connected}>
              NinjaTrader · {ninja.account}{ninja.connected ? '' : ' (bridge offline)'}
            </option>
          </select>
        </label>
      )}
      <label>Symbol <input value={symbol} readOnly /></label>
      <label>Qty <input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(Number(e.target.value))} /></label>
      {type !== 'market' && (
        <label>{type === 'limit' ? 'Limit' : 'Stop'} price <input type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      )}
      <button className={`ticket-go ${side}`} disabled={busy || qty <= 0 || (type !== 'market' && !price)} onClick={submit}>
        {side === 'buy' ? 'Buy' : 'Sell'} {qty} {symbol} {type === 'market' ? 'MKT' : `${type.toUpperCase()} ${price}`}
      </button>
      <p className="muted small">
        {route === 'paper' ? 'Paper trading — simulated fills on the live feed.' : `Routed to NinjaTrader account ${ninja?.account}. Fills come back from NT8.`}
      </p>
    </div>
  )
}

export default function TradingPanel() {
  const { account, positions, orders, refresh } = usePaper()
  const symbol = useTerminal((s) => s.panes[s.active].symbol)
  const setSymbol = useTerminal((s) => s.setSymbol)
  const [tab, setTab] = useState<'positions' | 'orders' | 'history'>('positions')

  useEffect(() => {
    void refresh().catch(() => {})
    const timer = setInterval(() => void refresh().catch(() => {}), 3000) // mark-to-market
    return () => clearInterval(timer)
  }, [refresh])

  const working = orders.filter((o) => o.status === 'working')
  const history = orders.filter((o) => o.status !== 'working')
  const act = (p: Promise<unknown>, ok: string) =>
    p.then(() => { toast(ok); return refresh() }).catch((e) => toast('Failed', String(e.message), 'error'))

  return (
    <div className="trading">
      <div className="trading-main">
        {account && (
          <div className="acct">
            <div><span>Balance</span><b>{money(account.balance)}</b></div>
            <div><span>Equity</span><b>{money(account.equity)}</b></div>
            <div><span>Realized P&amp;L</span><b className={account.realized_pnl >= 0 ? 'up' : 'down'}>{money(account.realized_pnl)}</b></div>
            <div><span>Unrealized P&amp;L</span><b className={account.unrealized_pnl >= 0 ? 'up' : 'down'}>{money(account.unrealized_pnl)}</b></div>
            <button onClick={() => window.confirm('Reset the paper account to $100,000 and flatten everything?') && act(resetPaper(), 'Account reset')}>Reset</button>
          </div>
        )}
        <div className="seg">
          <button className={tab === 'positions' ? 'on' : ''} onClick={() => setTab('positions')}>Positions ({positions.length})</button>
          <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>Working orders ({working.length})</button>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
        </div>
        <div className="table-wrap">
          {tab === 'positions' && (
            <table className="grid-table clickable">
              <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg</th><th>Last</th><th>Unrealized</th><th /></tr></thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol} onClick={() => setSymbol(p.symbol)}>
                    <td>{p.symbol}</td>
                    <td className={p.qty > 0 ? 'up' : 'down'}>{p.qty > 0 ? 'Long' : 'Short'}</td>
                    <td>{Math.abs(p.qty)}</td>
                    <td>{p.avg_price.toFixed(priceDigits(p.avg_price))}</td>
                    <td>{p.last.toFixed(priceDigits(p.last))}</td>
                    <td className={p.unrealized_pnl >= 0 ? 'up' : 'down'}>{money(p.unrealized_pnl)}</td>
                    <td><button onClick={(e) => { e.stopPropagation(); void act(closePosition(p.symbol), `Closing ${p.symbol}`) }}>Close</button></td>
                  </tr>
                ))}
                {positions.length === 0 && <tr><td colSpan={7} className="muted">No open positions</td></tr>}
              </tbody>
            </table>
          )}
          {tab === 'orders' && (
            <table className="grid-table">
              <thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Placed</th><th /></tr></thead>
              <tbody>
                {working.map((o) => (
                  <tr key={o.id}>
                    <td>{o.id}</td><td>{o.symbol}</td><td className={o.side === 'buy' ? 'up' : 'down'}>{o.side}</td><td>{o.type}</td><td>{o.qty}</td>
                    <td>{o.price}</td><td>{new Date(o.created_ms).toLocaleTimeString()}</td>
                    <td><button onClick={() => void act(cancelOrder(o.id), `Order ${o.id} cancelled`)}>Cancel</button></td>
                  </tr>
                ))}
                {working.length === 0 && <tr><td colSpan={8} className="muted">No working orders</td></tr>}
              </tbody>
            </table>
          )}
          {tab === 'history' && (
            <table className="grid-table">
              <thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Fill</th><th>Status</th><th>Time</th></tr></thead>
              <tbody>
                {history.map((o) => (
                  <tr key={o.id}>
                    <td>{o.id}</td><td>{o.symbol}</td><td className={o.side === 'buy' ? 'up' : 'down'}>{o.side}</td><td>{o.type}</td><td>{o.qty}</td>
                    <td>{o.price ?? '—'}</td><td>{o.fill_price ?? '—'}</td><td>{o.status}</td>
                    <td>{new Date(o.filled_ms ?? o.created_ms).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <OrderTicket key={symbol} symbol={symbol} />
    </div>
  )
}
