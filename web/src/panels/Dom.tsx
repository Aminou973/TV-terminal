import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelAllOrders,
  cancelOrder,
  closePosition,
  modifyOrder,
  placeOrder,
  reversePosition,
  type OrderIn,
  type PaperOrder,
} from '../api/client'
import { stream, type BookMessage } from '../chart/stream'
import { parseSpread } from '../chart/datasource'
import { toast, usePaper } from '../data'
import { pointValue, tickSize } from '../markets'
import { useTerminal } from '../store'
import { useAtm, useQuote } from '../trading/live'
import { bracketPrices, ladderOrderType, money, roundToTick, tickDigits, type Side } from '../trading/math'

const ROW_H = 18

const key = (price: number, tick: number) => Math.round(price / tick)

/** Where an order sits on the ladder: an untriggered stop limit shows at its trigger. */
const ladderPrice = (o: PaperOrder) => (o.type === 'stop_limit' && !o.triggered ? o.stop_price ?? o.price! : o.price!)

/**
 * DOM / price ladder: one row per tick around the market. Click the bid
 * column to buy, the ask column to sell (limit on the passive side of the
 * market, stop beyond it); click an order's size to cancel it, or drag it to
 * another row to move it. ATM brackets ride on every ladder entry.
 */
export default function Dom() {
  const symbol = useTerminal((s) => s.panes[s.active].symbol)
  const { positions, orders, refresh } = usePaper()
  const atm = useAtm()
  const quote = useQuote(symbol)
  const [book, setBook] = useState<BookMessage | null>(null)
  const [volume, setVolume] = useState<Map<number, { buy: number; sell: number }>>(new Map())
  const [center, setCenter] = useState<number | null>(null)
  const [auto, setAuto] = useState(true)
  const [rows, setRows] = useState(30)
  const [drag, setDrag] = useState<{ order: PaperOrder; over: number | null } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const tradable = !parseSpread(symbol)
  const last = quote.last ?? positions.find((p) => p.symbol === symbol)?.last ?? null
  const tick = tickSize(symbol, last)
  const digits = tickDigits(tick)
  const pv = pointValue(symbol)

  useEffect(() => {
    setBook(null)
    setVolume(new Map())
    setCenter(null)
    setAuto(true)
    const offBook = stream.subscribeBook(symbol, setBook)
    let buf: { price: number; size: number; side: string }[] = []
    const offTrades = stream.subscribeTrades(symbol, (t) => buf.push(t))
    const timer = setInterval(() => {
      if (!buf.length) return
      const add = buf
      buf = []
      setVolume((v) => {
        const next = new Map(v)
        const tk = tickSize(symbol, add[0].price)
        for (const t of add) {
          const k = key(t.price, tk)
          const cell = next.get(k) ?? { buy: 0, sell: 0 }
          if (t.side === 'sell') cell.sell += t.size
          else cell.buy += t.size
          next.set(k, cell)
        }
        return next
      })
    }, 300)
    return () => {
      offBook()
      offTrades()
      clearInterval(timer)
    }
  }, [symbol])

  // fit as many rows as the panel is tall
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setRows(Math.max(10, Math.floor(el.clientHeight / ROW_H))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // auto-centre when the market walks near the edge of the ladder
  useEffect(() => {
    if (last == null || !auto) return
    const c = key(last, tick)
    setCenter((cur) => (cur == null || Math.abs(c - cur) > rows / 4 ? c : cur))
  }, [last, tick, rows, auto])

  const bookAt = useMemo(() => {
    const m = new Map<number, { bid?: number; ask?: number }>()
    for (const [p, s] of book?.bids ?? []) m.set(key(p, tick), { ...m.get(key(p, tick)), bid: s })
    for (const [p, s] of book?.asks ?? []) m.set(key(p, tick), { ...m.get(key(p, tick)), ask: s })
    return m
  }, [book, tick])

  const working = orders.filter((o) => o.symbol === symbol && o.status === 'working' && o.price != null)
  const ordersAt = useMemo(() => {
    const m = new Map<number, PaperOrder[]>()
    for (const o of working) {
      const k = key(ladderPrice(o), tick)
      m.set(k, [...(m.get(k) ?? []), o])
    }
    return m
  }, [working, tick])
  const position = positions.find((p) => p.symbol === symbol)
  const maxVol = Math.max(1, ...[...volume.values()].map((v) => v.buy + v.sell))
  const maxBook = Math.max(1, ...[...bookAt.values()].map((v) => Math.max(v.bid ?? 0, v.ask ?? 0)))

  const act = useCallback(
    (p: Promise<unknown>, ok?: string) => p.then(() => { if (ok) toast(ok); return refresh() }).catch((e) => toast('Order rejected', String(e.message), 'error')),
    [refresh],
  )

  const enter = (side: Side, price: number | null) => {
    if (!tradable) return
    const ref = price ?? last
    if (ref == null) return toast('No price yet', `Waiting for ${symbol} to trade`, 'warn')
    const body: OrderIn = { symbol, side, qty: atm.qty, type: 'market' }
    if (price != null) {
      body.type = ladderOrderType(side, price, last ?? price)
      body.price = roundToTick(price, tick)
    }
    if (atm.brackets) Object.assign(body, bracketPrices(side, ref, tick, atm.tpTicks, atm.slTicks))
    void act(placeOrder(body))
  }

  const endDrag = (target: number | null) => {
    if (!drag) return
    const { order } = drag
    setDrag(null)
    if (target == null) return
    const price = roundToTick(target * tick, tick)
    if (key(ladderPrice(order), tick) === target) return void act(cancelOrder(order.id), `Order ${order.id} cancelled`)
    // an untriggered stop limit moves as a unit, keeping its stop → limit offset
    const patch =
      order.type === 'stop_limit' && !order.triggered
        ? { stop_price: price, price: roundToTick(price + order.price! - (order.stop_price ?? order.price!), tick) }
        : { price }
    void act(modifyOrder(order.id, patch))
  }

  const c = center ?? (last != null ? key(last, tick) : null)
  const ladder = c == null ? [] : Array.from({ length: rows }, (_, i) => c + Math.floor(rows / 2) - i)
  const lastK = last != null ? key(last, tick) : null
  const avgK = position ? key(position.avg_price, tick) : null
  const openTicks = position && last != null ? ((last - position.avg_price) / tick) * Math.sign(position.qty) : 0

  return (
    <div className="panel dom">
      <div className="panel-title plain">DOM · {symbol}</div>
      <div className="dom-head">
        <div className="dom-pos">
          {position ? (
            <>
              <b className={position.qty > 0 ? 'up' : 'down'}>{position.qty > 0 ? '+' : ''}{position.qty}</b>
              <span>@ {position.avg_price.toFixed(digits)}</span>
              <b className={position.unrealized_pnl >= 0 ? 'up' : 'down'}>{money(position.unrealized_pnl)}</b>
              <span className="muted">{openTicks >= 0 ? '+' : ''}{openTicks.toFixed(0)}t</span>
            </>
          ) : (
            <span className="muted">Flat</span>
          )}
        </div>
        <div className="dom-qty">
          <span>Qty</span>
          <input type="number" min={1} value={atm.qty} onChange={(e) => atm.set({ qty: Math.max(1, Number(e.target.value) || 1) })} />
          {[1, 2, 5, 10].map((n) => (
            <button key={n} className={atm.qty === n ? 'on' : ''} onClick={() => atm.set({ qty: n })}>{n}</button>
          ))}
        </div>
        <div className="dom-atm">
          <label className="inline">
            <input type="checkbox" checked={atm.brackets} onChange={(e) => atm.set({ brackets: e.target.checked })} /> ATM
          </label>
          <label>TP <input type="number" min={0} value={atm.tpTicks} disabled={!atm.brackets} onChange={(e) => atm.set({ tpTicks: Math.max(0, Number(e.target.value)) })} />t</label>
          <label>SL <input type="number" min={0} value={atm.slTicks} disabled={!atm.brackets} onChange={(e) => atm.set({ slTicks: Math.max(0, Number(e.target.value)) })} />t</label>
          {atm.brackets && atm.slTicks > 0 && <span className="muted small">risk {money(atm.slTicks * tick * pv * atm.qty)}</span>}
        </div>
        <div className="dom-btns">
          <button className="buy" disabled={!tradable} onClick={() => enter('buy', null)}>Buy MKT</button>
          <button className="sell" disabled={!tradable} onClick={() => enter('sell', null)}>Sell MKT</button>
          <button disabled={!position} onClick={() => act(Promise.all([cancelAllOrders(symbol), closePosition(symbol)]), `${symbol} flattened`)}>Flatten</button>
          <button disabled={!position} onClick={() => act(reversePosition(symbol), `Reversing ${symbol}`)}>Reverse</button>
          <button disabled={!working.length} onClick={() => act(cancelAllOrders(symbol), 'Orders cancelled')}>Cancel all</button>
          <button title="Centre on the market" className={auto ? 'on' : ''} onClick={() => { setAuto(true); setCenter(lastK) }}>⊙</button>
        </div>
      </div>
      <div className="dom-cols"><span>Buy</span><span>Bid</span><span>Price</span><span>Ask</span><span>Sell</span><span>Vol</span></div>
      <div
        ref={bodyRef}
        className={`dom-body ${drag ? 'dragging' : ''}`}
        onWheel={(e) => {
          if (c == null) return
          setAuto(false)
          setCenter(c + (e.deltaY > 0 ? -2 : 2))
        }}
        onMouseLeave={() => drag && setDrag({ ...drag, over: null })}
        onMouseUp={() => endDrag(null)}
      >
        {!tradable && <p className="muted pad">Spreads can't be traded from the DOM.</p>}
        {tradable && c == null && <p className="muted pad">Waiting for {symbol} to trade…</p>}
        {ladder.map((k) => {
          const price = k * tick
          const b = bookAt.get(k)
          const v = volume.get(k)
          const os = ordersAt.get(k) ?? []
          const buys = os.filter((o) => o.side === 'buy')
          const sells = os.filter((o) => o.side === 'sell')
          const cell = (list: PaperOrder[]) =>
            list.map((o) => (
              <span
                key={o.id}
                className={`dom-order ${o.side} ${o.tag}`}
                title={`${o.tag ? o.tag.toUpperCase() + ' · ' : ''}${o.type.replace('_', ' ')} #${o.id} — click to cancel, drag to move`}
                onMouseDown={(e) => { e.stopPropagation(); setDrag({ order: o, over: k }) }}
              >
                {o.tag === 'tp' ? 'TP ' : o.tag === 'sl' ? 'SL ' : o.type === 'stop' || o.type === 'stop_limit' ? 'S ' : ''}{o.qty}
              </span>
            ))
          return (
            <div
              key={k}
              className={`dom-row ${k === lastK ? 'last' : ''} ${k === avgK ? (position!.qty > 0 ? 'avg long' : 'avg short') : ''} ${drag?.over === k ? 'drop' : ''}`}
              onMouseEnter={() => drag && setDrag({ ...drag, over: k })}
              onMouseUp={(e) => { e.stopPropagation(); endDrag(drag ? k : null) }}
            >
              <span className="dom-mine">{cell(buys)}</span>
              <span className="dom-bid" onClick={() => !drag && enter('buy', price)} title={`Buy ${atm.qty} ${ladderOrderType('buy', price, last ?? price)} @ ${price.toFixed(digits)}`}>
                {b?.bid ? <><i style={{ width: `${(b.bid / maxBook) * 100}%` }} />{b.bid}</> : ''}
              </span>
              <span className="dom-price">{price.toFixed(digits)}</span>
              <span className="dom-ask" onClick={() => !drag && enter('sell', price)} title={`Sell ${atm.qty} ${ladderOrderType('sell', price, last ?? price)} @ ${price.toFixed(digits)}`}>
                {b?.ask ? <><i style={{ width: `${(b.ask / maxBook) * 100}%` }} />{b.ask}</> : ''}
              </span>
              <span className="dom-mine">{cell(sells)}</span>
              <span className="dom-vol">
                {v ? <><i className="b" style={{ width: `${(v.buy / maxVol) * 100}%` }} /><i className="s" style={{ width: `${(v.sell / maxVol) * 100}%` }} />{v.buy + v.sell}</> : ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
