import { useEffect, useState } from 'react'
import {
  cancelAllOrders,
  cancelOrder,
  closePosition,
  flattenAll,
  getNinjaStatus,
  modifyOrder,
  placeNinjaOrder,
  placeOrder,
  resetPaper,
  reversePosition,
  savePaperSettings,
  setPositionBrackets,
  type NinjaStatus,
  type OrderIn,
  type OrderType,
  type PaperOrder,
  type PaperPosition,
} from '../api/client'
import { toast, usePaper } from '../data'
import { pointValue, tickSize } from '../markets'
import { useTerminal } from '../store'
import { useAtm, useQuote } from '../trading/live'
import { bracketPrices, money, riskQty, roundToTick, tickDigits } from '../trading/math'

const TYPE_LABEL: Record<OrderType, string> = {
  market: 'Market',
  limit: 'Limit',
  stop: 'Stop',
  stop_limit: 'Stop limit',
  trailing_stop: 'Trailing',
}

export function orderLabel(o: PaperOrder): string {
  if (o.tag === 'tp') return 'TP'
  if (o.tag === 'sl') return 'SL'
  return { market: 'MKT', limit: 'LMT', stop: 'STP', stop_limit: 'STP LMT', trailing_stop: 'TRAIL' }[o.type]
}

export function orderPriceText(o: PaperOrder, digits: number): string {
  const f = (v: number | null) => (v == null ? '—' : v.toFixed(digits))
  if (o.type === 'stop_limit') return `${f(o.stop_price)} → ${f(o.price)}${o.triggered ? ' (triggered)' : ''}`
  if (o.type === 'trailing_stop') return `${f(o.price)} (trail ${o.trail})`
  return f(o.price)
}

// ------------------------------------------------------------- ticket -----
export function OrderTicket({ symbol, side: initialSide, price: initialPrice, onDone }: { symbol: string; side?: 'buy' | 'sell'; price?: number; onDone?: () => void }) {
  const atm = useAtm()
  const account = usePaper((s) => s.account)
  const quote = useQuote(symbol)
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide ?? 'buy')
  const [type, setType] = useState<OrderType>(initialPrice ? 'limit' : 'market')
  const [qty, setQty] = useState(atm.qty)
  const [price, setPrice] = useState(initialPrice ? String(initialPrice) : '')
  const [stopPrice, setStopPrice] = useState(initialPrice ? String(initialPrice) : '')
  const [trail, setTrail] = useState('')
  const [useTp, setUseTp] = useState(atm.brackets)
  const [useSl, setUseSl] = useState(atm.brackets)
  const [unit, setUnit] = useState<'ticks' | 'price'>('ticks')
  const [tpVal, setTpVal] = useState(String(atm.tpTicks))
  const [slVal, setSlVal] = useState(String(atm.slTicks))
  const [riskPct, setRiskPct] = useState('')
  const [reduceOnly, setReduceOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [route, setRoute] = useState<'paper' | 'ninja'>('paper')
  const [ninja, setNinja] = useState<NinjaStatus | null>(null)

  useEffect(() => {
    getNinjaStatus().then(setNinja).catch(() => {})
  }, [])

  const last = quote.last
  const tick = tickSize(symbol, last ?? (Number(price) || null))
  const digits = tickDigits(tick)
  const pv = pointValue(symbol)
  const entry = type === 'market' || type === 'trailing_stop' ? last : Number(price) || null
  const bracketsAllowed = !reduceOnly && route === 'paper'
  const levels = (() => {
    if (!entry || !bracketsAllowed) return { tp: undefined, sl: undefined }
    if (unit === 'price') return { tp: useTp && Number(tpVal) ? Number(tpVal) : undefined, sl: useSl && Number(slVal) ? Number(slVal) : undefined }
    return bracketPrices(side, entry, tick, useTp ? Number(tpVal) : 0, useSl ? Number(slVal) : 0)
  })()
  const risk = entry && levels.sl ? Math.abs(entry - levels.sl) * qty * pv : null
  const reward = entry && levels.tp ? Math.abs(levels.tp - entry) * qty * pv : null

  // risk-% sizing needs a stop
  useEffect(() => {
    const r = Number(riskPct)
    if (!r || !entry || !levels.sl || !account) return
    const q = riskQty(account.equity, r, entry, levels.sl, pv)
    if (q > 0) setQty(q)
  }, [riskPct, entry, levels.sl, account, pv])

  const ninjaOk = type === 'market' || type === 'limit' || type === 'stop'
  const needsPrice = type === 'limit' || type === 'stop' || type === 'stop_limit'
  const valid =
    qty > 0 &&
    (!needsPrice || Number(price) > 0) &&
    (type !== 'stop_limit' || Number(stopPrice) > 0) &&
    (type !== 'trailing_stop' || Number(trail) > 0) &&
    (route === 'paper' || ninjaOk)

  const submit = async () => {
    setBusy(true)
    try {
      if (route === 'ninja') {
        if (!window.confirm(`Send a REAL order to NinjaTrader account ${ninja?.account}?\n${side.toUpperCase()} ${qty} ${symbol} ${type}${type !== 'market' ? ' @ ' + price : ''}`)) return
        const r = await placeNinjaOrder({ symbol, side, type: type as 'market' | 'limit' | 'stop', qty, price: type === 'market' ? undefined : Number(price) })
        toast('Sent to NinjaTrader', `${r.account} · ${r.contract} · ref ${r.ref}`)
        onDone?.()
        return
      }
      const body: OrderIn = { symbol, side, type, qty, reduce_only: reduceOnly || undefined }
      if (needsPrice) body.price = roundToTick(Number(price), tick)
      if (type === 'stop_limit') body.stop_price = roundToTick(Number(stopPrice), tick)
      if (type === 'trailing_stop') body.trail = Number(trail)
      if (levels.tp != null) body.tp = levels.tp
      if (levels.sl != null) body.sl = levels.sl
      const o = await placeOrder(body)
      if (o.status === 'working') toast('Order working', `${side.toUpperCase()} ${qty} ${symbol} ${TYPE_LABEL[type]} @ ${orderPriceText(o, digits)}`)
      await usePaper.getState().refresh()
      onDone?.()
    } catch (e) {
      toast('Order rejected', String((e as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }

  const priceSummary =
    type === 'market' ? 'MKT' : type === 'trailing_stop' ? `TRAIL ${trail}` : type === 'stop_limit' ? `STP ${stopPrice} LMT ${price}` : `${type.toUpperCase()} ${price}`

  return (
    <div className="ticket">
      <div className="seg ticket-side">
        <button className={side === 'buy' ? 'on buy' : ''} onClick={() => setSide('buy')}>
          Buy {quote.ask != null && <small>{quote.ask.toFixed(digits)}</small>}
        </button>
        <button className={side === 'sell' ? 'on sell' : ''} onClick={() => setSide('sell')}>
          Sell {quote.bid != null && <small>{quote.bid.toFixed(digits)}</small>}
        </button>
      </div>
      <select className="ticket-type" value={type} onChange={(e) => setType(e.target.value as OrderType)}>
        {(Object.keys(TYPE_LABEL) as OrderType[]).map((t) => (
          <option key={t} value={t} disabled={route === 'ninja' && !['market', 'limit', 'stop'].includes(t)}>{TYPE_LABEL[t]}</option>
        ))}
      </select>
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
      <label>
        Qty
        <span className="qty-row">
          <input type="number" min={0} step="any" value={qty} onChange={(e) => { setRiskPct(''); setQty(Number(e.target.value)) }} />
          {[1, 2, 5, 10].map((n) => (
            <button key={n} className={qty === n ? 'on' : ''} onClick={() => { setRiskPct(''); setQty(n) }}>{n}</button>
          ))}
        </span>
      </label>
      {type === 'stop_limit' && (
        <label>Stop price <input type="number" step={tick} value={stopPrice} onChange={(e) => setStopPrice(e.target.value)} /></label>
      )}
      {needsPrice && (
        <label>{type === 'stop' ? 'Stop' : 'Limit'} price <input type="number" step={tick} value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      )}
      {type === 'trailing_stop' && (
        <label>Trail by (price) <input type="number" step={tick} min={0} value={trail} placeholder={`e.g. ${tick * 8}`} onChange={(e) => setTrail(e.target.value)} /></label>
      )}
      {route === 'paper' && (
        <div className="ticket-brackets">
          <div className="ticket-brackets-head">
            <span>Brackets</span>
            <div className="seg mini">
              <button className={unit === 'ticks' ? 'on' : ''} onClick={() => setUnit('ticks')}>ticks</button>
              <button className={unit === 'price' ? 'on' : ''} onClick={() => setUnit('price')}>price</button>
            </div>
          </div>
          <label className="inline">
            <input type="checkbox" checked={useTp} disabled={!bracketsAllowed} onChange={(e) => setUseTp(e.target.checked)} /> Take profit
            <input type="number" step={unit === 'ticks' ? 1 : tick} value={tpVal} disabled={!useTp || !bracketsAllowed} onChange={(e) => setTpVal(e.target.value)} />
            {levels.tp != null && unit === 'ticks' && <span className="muted small">{levels.tp.toFixed(digits)}</span>}
          </label>
          <label className="inline">
            <input type="checkbox" checked={useSl} disabled={!bracketsAllowed} onChange={(e) => setUseSl(e.target.checked)} /> Stop loss
            <input type="number" step={unit === 'ticks' ? 1 : tick} value={slVal} disabled={!useSl || !bracketsAllowed} onChange={(e) => setSlVal(e.target.value)} />
            {levels.sl != null && unit === 'ticks' && <span className="muted small">{levels.sl.toFixed(digits)}</span>}
          </label>
          <label className="inline">
            Size by risk <input type="number" min={0} step={0.1} placeholder="%" value={riskPct} disabled={!levels.sl} onChange={(e) => setRiskPct(e.target.value)} /> % of equity
          </label>
          <label className="inline"><input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} /> Reduce only</label>
          {(risk != null || reward != null) && (
            <div className="ticket-risk small">
              {risk != null && <span className="down">Risk {money(risk)}</span>}
              {reward != null && <span className="up">Reward {money(reward)}</span>}
              {risk && reward ? <span>R:R 1:{(reward / risk).toFixed(2)}</span> : null}
            </div>
          )}
        </div>
      )}
      <button className={`ticket-go ${side}`} disabled={busy || !valid} onClick={submit}>
        {side === 'buy' ? 'Buy' : 'Sell'} {qty} {symbol} {priceSummary}
      </button>
      <p className="muted small">
        {route === 'paper' ? 'Paper trading: simulated fills on the live feed.' : `Routed to NinjaTrader account ${ninja?.account}. Fills come back from NT8.`}
      </p>
    </div>
  )
}

// ------------------------------------------------------ inline editors ----
function PriceCell({ value, digits, onSave, placeholder = '—' }: { value: number | null; digits: number; onSave: (v: number | null) => void; placeholder?: string }) {
  const [edit, setEdit] = useState<string | null>(null)
  if (edit == null)
    return (
      <span className="editable" title="Click to edit" onClick={(e) => { e.stopPropagation(); setEdit(value == null ? '' : String(value)) }}>
        {value == null ? <span className="muted">{placeholder}</span> : value.toFixed(digits)}
      </span>
    )
  const commit = () => {
    const v = edit.trim() === '' ? null : Number(edit)
    setEdit(null)
    if (v !== value && (v == null || Number.isFinite(v))) onSave(v)
  }
  return (
    <input
      className="cell-input"
      autoFocus
      type="number"
      value={edit}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setEdit(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setEdit(null)
      }}
    />
  )
}

function AccountSettings({ onClose }: { onClose: () => void }) {
  const account = usePaper((s) => s.account)
  const [start, setStart] = useState(String(account?.starting_balance ?? 100000))
  const [comm, setComm] = useState(String(account?.commission ?? 0))
  const save = () =>
    savePaperSettings({ starting_balance: Number(start), commission: Number(comm) })
      .then(() => usePaper.getState().refresh())
      .then(() => { toast('Paper account updated'); onClose() })
      .catch((e) => toast('Failed', String(e.message), 'error'))
  return (
    <div className="acct-settings">
      <label>Starting balance <input type="number" min={1} value={start} onChange={(e) => setStart(e.target.value)} /></label>
      <label>Commission / contract / side <input type="number" min={0} step={0.01} value={comm} onChange={(e) => setComm(e.target.value)} /></label>
      <button className="primary" onClick={save}>Save</button>
      <button onClick={onClose}>Cancel</button>
    </div>
  )
}

// -------------------------------------------------------------- panel -----
export default function TradingPanel() {
  const { account, positions, orders, refresh } = usePaper()
  const symbol = useTerminal((s) => s.panes[s.active].symbol)
  const setSymbol = useTerminal((s) => s.setSymbol)
  const [tab, setTab] = useState<'positions' | 'orders' | 'history'>('positions')
  const [settings, setSettings] = useState(false)

  useEffect(() => {
    void refresh().catch(() => {})
    const timer = setInterval(() => void refresh().catch(() => {}), 3000) // mark-to-market
    return () => clearInterval(timer)
  }, [refresh])

  const working = orders.filter((o) => o.status === 'working')
  const history = orders.filter((o) => o.status !== 'working')
  const act = (p: Promise<unknown>, ok?: string) =>
    p.then(() => { if (ok) toast(ok); return refresh() }).catch((e) => toast('Failed', String(e.message), 'error'))

  const digitsFor = (sym: string, ref: number | null) => tickDigits(tickSize(sym, ref))
  const bracket = (p: PaperPosition, patch: { tp?: number | null; sl?: number | null }) =>
    act(setPositionBrackets(p.symbol, { tp: 'tp' in patch ? patch.tp : p.tp, sl: 'sl' in patch ? patch.sl : p.sl }), `${p.symbol} brackets updated`)

  return (
    <div className="trading">
      <div className="trading-main">
        {account && (
          <div className="acct">
            <div><span>Balance</span><b>{money(account.balance)}</b></div>
            <div><span>Equity</span><b>{money(account.equity)}</b></div>
            <div><span>Realized P&amp;L</span><b className={account.realized_pnl >= 0 ? 'up' : 'down'}>{money(account.realized_pnl)}</b></div>
            <div><span>Unrealized P&amp;L</span><b className={account.unrealized_pnl >= 0 ? 'up' : 'down'}>{money(account.unrealized_pnl)}</b></div>
            <span className="spacer" />
            <button title="Close every position and cancel every order" disabled={!positions.length && !working.length}
              onClick={() => window.confirm('Flatten everything: close all positions and cancel all orders?') && act(flattenAll(), 'Flattened')}>
              Flatten all
            </button>
            <button disabled={!working.length} onClick={() => act(cancelAllOrders(), 'All orders cancelled')}>Cancel all</button>
            <button title="Account settings" onClick={() => setSettings((v) => !v)}>⚙</button>
            <button onClick={() => window.confirm(`Reset the paper account to ${money(account.starting_balance)}, flatten everything and clear the journal?`) && act(resetPaper(), 'Account reset')}>Reset</button>
          </div>
        )}
        {settings && <AccountSettings onClose={() => setSettings(false)} />}
        <div className="seg">
          <button className={tab === 'positions' ? 'on' : ''} onClick={() => setTab('positions')}>Positions ({positions.length})</button>
          <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>Working orders ({working.length})</button>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
        </div>
        <div className="table-wrap">
          {tab === 'positions' && (
            <table className="grid-table clickable">
              <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg</th><th>Last</th><th>Take profit</th><th>Stop loss</th><th>Unrealized</th><th /></tr></thead>
              <tbody>
                {positions.map((p) => {
                  const d = digitsFor(p.symbol, p.last)
                  return (
                    <tr key={p.symbol} onClick={() => setSymbol(p.symbol)}>
                      <td>{p.symbol}</td>
                      <td className={p.qty > 0 ? 'up' : 'down'}>{p.qty > 0 ? 'Long' : 'Short'}</td>
                      <td>{Math.abs(p.qty)}</td>
                      <td>{p.avg_price.toFixed(d)}</td>
                      <td>{p.last.toFixed(d)}</td>
                      <td><PriceCell value={p.tp} digits={d} placeholder="+ add" onSave={(v) => bracket(p, { tp: v })} /></td>
                      <td><PriceCell value={p.sl} digits={d} placeholder="+ add" onSave={(v) => bracket(p, { sl: v })} /></td>
                      <td className={p.unrealized_pnl >= 0 ? 'up' : 'down'}>{money(p.unrealized_pnl)}</td>
                      <td className="row-btns">
                        <button title="Reverse" onClick={(e) => { e.stopPropagation(); void act(reversePosition(p.symbol), `Reversing ${p.symbol}`) }}>Rev</button>
                        <button onClick={(e) => { e.stopPropagation(); void act(closePosition(p.symbol), `Closing ${p.symbol}`) }}>Close</button>
                      </td>
                    </tr>
                  )
                })}
                {positions.length === 0 && <tr><td colSpan={9} className="muted">No open positions</td></tr>}
              </tbody>
            </table>
          )}
          {tab === 'orders' && (
            <table className="grid-table">
              <thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Brackets</th><th>Placed</th><th /></tr></thead>
              <tbody>
                {working.map((o) => {
                  const d = digitsFor(o.symbol, o.price)
                  return (
                    <tr key={o.id}>
                      <td>{o.id}</td><td>{o.symbol}</td><td className={o.side === 'buy' ? 'up' : 'down'}>{o.side}</td>
                      <td>{orderLabel(o)}{o.reduce_only ? <span className="muted small"> RO</span> : null}</td>
                      <td>{o.qty}</td>
                      <td>
                        {o.type === 'stop_limit' || o.type === 'trailing_stop' ? orderPriceText(o, d) : (
                          <PriceCell value={o.price} digits={d} onSave={(v) => v != null && act(modifyOrder(o.id, { price: v }), `Order ${o.id} modified`)} />
                        )}
                      </td>
                      <td className="small">
                        {o.tp != null || o.sl != null ? `TP ${o.tp ?? '—'} / SL ${o.sl ?? '—'}` : o.oco ? 'OCO' : ''}
                      </td>
                      <td>{new Date(o.created_ms).toLocaleTimeString()}</td>
                      <td><button onClick={() => void act(cancelOrder(o.id), `Order ${o.id} cancelled`)}>Cancel</button></td>
                    </tr>
                  )
                })}
                {working.length === 0 && <tr><td colSpan={9} className="muted">No working orders</td></tr>}
              </tbody>
            </table>
          )}
          {tab === 'history' && (
            <table className="grid-table">
              <thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Fill</th><th>Status</th><th>Time</th></tr></thead>
              <tbody>
                {history.map((o) => (
                  <tr key={o.id}>
                    <td>{o.id}</td><td>{o.symbol}</td><td className={o.side === 'buy' ? 'up' : 'down'}>{o.side}</td><td>{orderLabel(o)}</td><td>{o.qty}</td>
                    <td>{o.price ?? '—'}</td><td>{o.fill_price ?? '—'}</td>
                    <td>{o.status}{o.reason ? <span className="muted small"> · {o.reason}</span> : null}</td>
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

