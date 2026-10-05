import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  LineStyle,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
} from 'lightweight-charts'
import { cancelOrder, closePosition, modifyOrder, placeOrder, setPositionBrackets, type OrderModify, type PaperOrder } from '../api/client'
import { toast, usePaper } from '../data'
import { pointValue, tickSize } from '../markets'
import { useAtm, useQuote } from '../trading/live'
import { bracketPrices, pnl, roundToTick, signedMoney, tickDigits, type Side } from '../trading/math'

const BUY = '#2962ff'
const SELL = '#f23645'
const TP = '#089981'
const SLC = '#f7525f'

interface Item {
  id: string
  price: number
  color: string
  dashed: boolean
  label: string
  /** what dragging this handle changes; absent = not draggable */
  drag?: { order: PaperOrder; field: 'price' | 'tp' | 'sl' }
  /** projected P&L at this price (TP / SL legs, pending bracket legs) */
  projected?: { side: Side; avg: number; qty: number }
  cancel?: () => Promise<unknown>
  position?: { qty: number; pnl: number }
}

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<SeriesType> | null
  symbol: string
  generation: number
  showOrders: boolean
  showExecutions: boolean
  /** bars on screen, for snapping executions to their bar; null on timeless charts */
  getBars: () => { time: number }[] | null
  dataVersion: number
}

const act = (p: Promise<unknown>, ok?: string) =>
  p
    .then(() => { if (ok) toast(ok) })
    .catch((e) => toast('Order rejected', String((e as Error).message), 'error'))
    .finally(() => usePaper.getState().refresh().catch(() => {}))

/** One-click market Buy / Sell at the ATM size (and brackets), shown in the chart legend. */
export function TradeButtons({ symbol, fallback }: { symbol: string; fallback?: number | null }) {
  const atm = useAtm()
  const quote = useQuote(symbol)
  const positions = usePaper((s) => s.positions)
  // symbols without a quote stream (e.g. replayed demo data) price off the chart's last close
  const last = quote.last ?? positions.find((p) => p.symbol === symbol)?.last ?? fallback ?? null
  const tick = tickSize(symbol, last)
  const digits = tickDigits(tick)
  const oneClick = (side: Side) => {
    if (last == null) return toast('No price yet', `Waiting for ${symbol} to trade`, 'warn')
    void act(placeOrder({ symbol, side, type: 'market', qty: atm.qty, ...(atm.brackets ? bracketPrices(side, last, tick, atm.tpTicks, atm.slTicks) : {}) }))
  }
  const spread = quote.bid != null && quote.ask != null ? Math.round((quote.ask - quote.bid) / tick) : null
  return (
    <div className="trade-buttons" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <button className="sell" onClick={() => oneClick('sell')} title={`Sell ${atm.qty} at market${atm.brackets ? ' with ATM brackets' : ''}`}>
        <small>SELL</small>{(quote.bid ?? last)?.toFixed(digits) ?? '—'}
      </button>
      <span className="spread" title="Spread in ticks">{spread ?? ''}</span>
      <input type="number" min={1} value={atm.qty} onChange={(e) => atm.set({ qty: Math.max(1, Number(e.target.value) || 1) })} title="Quantity" />
      <button className="buy" onClick={() => oneClick('buy')} title={`Buy ${atm.qty} at market${atm.brackets ? ' with ATM brackets' : ''}`}>
        <small>BUY</small>{(quote.ask ?? last)?.toFixed(digits) ?? '—'}
      </button>
    </div>
  )
}

/** Draggable paper orders / positions / brackets and execution markers for one chart. */
export default function OrderOverlay({ chart, series, symbol, generation, showOrders, showExecutions, getBars, dataVersion }: Props) {
  const positions = usePaper((s) => s.positions)
  const orders = usePaper((s) => s.orders)
  const atm = useAtm()
  const quote = useQuote(symbol)
  const [drag, setDrag] = useState<{ id: string; price: number } | null>(null)
  const chipRefs = useRef(new Map<string, HTMLDivElement>())
  const linesRef = useRef(new Map<string, IPriceLine>())
  const [scaleWidth, setScaleWidth] = useState(60)

  const position = positions.find((p) => p.symbol === symbol)
  const last = quote.last ?? position?.last ?? null
  const tick = tickSize(symbol, last)
  const digits = tickDigits(tick)
  const pv = pointValue(symbol)

  const items = useMemo<Item[]>(() => {
    if (!showOrders) return []
    const out: Item[] = []
    if (position) {
      out.push({
        id: 'pos',
        price: position.avg_price,
        color: position.qty > 0 ? BUY : SELL,
        dashed: false,
        label: `${position.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(position.qty)}`,
        position: { qty: position.qty, pnl: position.unrealized_pnl },
        cancel: () => closePosition(symbol),
      })
    }
    for (const o of orders) {
      if (o.symbol !== symbol || o.status !== 'working' || o.price == null) continue
      const leg = o.tag === 'tp' || o.tag === 'sl'
      const shown = o.type === 'stop_limit' && !o.triggered ? o.stop_price ?? o.price : o.price
      out.push({
        id: `o${o.id}`,
        price: shown,
        color: leg ? (o.tag === 'tp' ? TP : SLC) : o.side === 'buy' ? BUY : SELL,
        dashed: true,
        label: leg
          ? `${o.tag.toUpperCase()} ${o.qty}`
          : `${o.side.toUpperCase()} ${{ market: 'MKT', limit: 'LMT', stop: 'STP', stop_limit: 'STP LMT', trailing_stop: 'TRAIL' }[o.type]} ${o.qty}`,
        drag: { order: o, field: 'price' },
        projected: leg && position ? { side: position.qty > 0 ? 'buy' : 'sell', avg: position.avg_price, qty: o.qty } : undefined,
        cancel: () => cancelOrder(o.id),
      })
      // brackets that will attach when this entry fills
      for (const f of ['tp', 'sl'] as const) {
        const lvl = o[f]
        if (lvl == null) continue
        out.push({
          id: `o${o.id}${f}`,
          price: lvl,
          color: f === 'tp' ? TP : SLC,
          dashed: true,
          label: `${f.toUpperCase()} ${o.qty} (on fill)`,
          drag: { order: o, field: f },
          projected: { side: o.side, avg: o.price, qty: o.qty },
          cancel: () => modifyOrder(o.id, f === 'tp' ? { clear_tp: true } : { clear_sl: true }),
        })
      }
    }
    return out
  }, [showOrders, position, orders, symbol])

  // ------------------------------------------------------- price lines ----
  useEffect(() => {
    if (!series) return
    const lines = linesRef.current
    for (const l of lines.values()) series.removePriceLine(l)
    lines.clear()
    for (const it of items) {
      lines.set(
        it.id,
        series.createPriceLine({
          price: it.price,
          color: it.color,
          lineWidth: 1,
          lineStyle: it.dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          title: '',
        }),
      )
    }
    return () => {
      for (const l of lines.values()) {
        try {
          series.removePriceLine(l)
        } catch {
          /* chart already torn down */
        }
      }
      lines.clear()
    }
  }, [series, items, generation])

  // ------------------------------------------- keep handles on their line --
  useEffect(() => {
    if (!chart || !series) return
    let raf = 0
    let lastWidth = -1
    const frame = () => {
      const h = chart.paneSize(0).height
      for (const it of items) {
        const el = chipRefs.current.get(it.id)
        if (!el) continue
        const p = drag?.id === it.id ? drag.price : it.price
        const y = series.priceToCoordinate(p)
        if (y == null || y < 0 || y > h) {
          el.style.display = 'none'
        } else {
          el.style.display = ''
          el.style.transform = `translateY(${Math.round(y) - 10}px)`
        }
      }
      const w = chart.priceScale('right').width()
      if (w !== lastWidth) {
        lastWidth = w
        setScaleWidth(w)
      }
      raf = requestAnimationFrame(frame)
    }
    // nothing to track: only the price-scale width matters, so poll slowly
    if (!items.length) {
      const poll = () => {
        const w = chart.priceScale('right').width()
        if (w !== lastWidth) {
          lastWidth = w
          setScaleWidth(w)
        }
      }
      poll()
      const timer = setInterval(poll, 500)
      return () => clearInterval(timer)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [chart, series, items, drag])

  // ------------------------------------------------------------- drag -----
  const priceAt = (e: ReactPointerEvent) => {
    const host = (e.currentTarget as HTMLElement).closest('.order-overlay') as HTMLElement
    const y = e.clientY - host.getBoundingClientRect().top
    const p = series?.coordinateToPrice(y)
    return p == null ? null : roundToTick(p, tick)
  }

  const onDown = (it: Item) => (e: ReactPointerEvent) => {
    if (!it.drag || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ id: it.id, price: it.price })
  }
  const onMove = (it: Item) => (e: ReactPointerEvent) => {
    if (drag?.id !== it.id) return
    const p = priceAt(e)
    if (p == null) return
    setDrag({ id: it.id, price: p })
    linesRef.current.get(it.id)?.applyOptions({ price: p })
  }
  const onUp = (it: Item) => () => {
    if (drag?.id !== it.id || !it.drag) return
    const p = drag.price
    setDrag(null)
    if (p === it.price) return
    const { order, field } = it.drag
    let patch: OrderModify
    if (field !== 'price') patch = { [field]: p }
    else if (order.type === 'stop_limit' && !order.triggered)
      patch = { stop_price: p, price: roundToTick(p + order.price! - (order.stop_price ?? order.price!), tick) }
    else patch = { price: p }
    void act(modifyOrder(order.id, patch)).then(() => linesRef.current.get(it.id)?.applyOptions({ price: it.price }))
  }

  const addBracket = (which: 'tp' | 'sl') => {
    if (!position || last == null) return
    const side: Side = position.qty > 0 ? 'buy' : 'sell'
    const lv = bracketPrices(side, last, tick, which === 'tp' ? atm.tpTicks || 16 : 0, which === 'sl' ? atm.slTicks || 8 : 0)
    void act(setPositionBrackets(symbol, { tp: which === 'tp' ? lv.tp : position.tp, sl: which === 'sl' ? lv.sl : position.sl }))
  }

  // -------------------------------------------------------- executions ----
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  useEffect(() => {
    if (!series) return
    markersRef.current = createSeriesMarkers(series, [])
    return () => {
      try {
        markersRef.current?.detach()
      } catch {
        /* series gone */
      }
      markersRef.current = null
    }
  }, [series, generation])
  useEffect(() => {
    const plugin = markersRef.current
    if (!plugin) return
    const bars = showExecutions ? getBars() : null
    if (!bars?.length) return plugin.setMarkers([])
    const barAt = (t: number) => {
      let lo = 0
      let hi = bars.length - 1
      if (t < bars[0].time) return null
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (bars[mid].time <= t) lo = mid
        else hi = mid - 1
      }
      return bars[lo].time
    }
    const marks: SeriesMarker<Time>[] = []
    for (const o of orders) {
      if (o.symbol !== symbol || o.status !== 'filled' || o.filled_ms == null || o.fill_price == null) continue
      const t = barAt(Math.floor(o.filled_ms / 1000))
      if (t == null) continue
      const buy = o.side === 'buy'
      marks.push({
        time: t as Time,
        position: buy ? 'belowBar' : 'aboveBar',
        shape: buy ? 'arrowUp' : 'arrowDown',
        color: buy ? BUY : SELL,
        text: `${buy ? 'B' : 'S'} ${o.qty} @ ${o.fill_price.toFixed(digits)}`,
      })
    }
    marks.sort((a, b) => (a.time as number) - (b.time as number))
    plugin.setMarkers(marks)
  }, [orders, symbol, showExecutions, dataVersion, generation, digits, getBars])

  return (
    <div className="order-overlay" style={{ right: scaleWidth }}>
      {items.map((it) => {
        const price = drag?.id === it.id ? drag.price : it.price
        const proj = it.projected ? pnl(it.projected.side, it.projected.avg, price, it.projected.qty, pv) : null
        return (
          <div
            key={it.id}
            ref={(el) => { if (el) chipRefs.current.set(it.id, el); else chipRefs.current.delete(it.id) }}
            className={`order-chip ${it.drag ? 'draggable' : ''} ${drag?.id === it.id ? 'dragging' : ''}`}
            style={{ borderColor: it.color, display: 'none' }}
            onPointerDown={onDown(it)}
            onPointerMove={onMove(it)}
            onPointerUp={onUp(it)}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
            title={it.drag ? 'Drag to move' : undefined}
          >
            <span className="chip-label" style={{ background: it.color }}>{it.label}</span>
            {it.position && <span className={`chip-pnl ${it.position.pnl >= 0 ? 'up' : 'down'}`}>{signedMoney(it.position.pnl)}</span>}
            {proj != null && <span className={`chip-pnl ${proj >= 0 ? 'up' : 'down'}`}>{signedMoney(proj)}</span>}
            {drag?.id === it.id && <span className="chip-price">{price.toFixed(digits)}</span>}
            {it.position && position && (
              <>
                {position.tp == null && <button className="chip-btn" title="Add take profit" onClick={() => addBracket('tp')}>TP</button>}
                {position.sl == null && <button className="chip-btn" title="Add stop loss" onClick={() => addBracket('sl')}>SL</button>}
              </>
            )}
            {it.cancel && (
              <button className="chip-btn x" title={it.position ? 'Close position' : 'Cancel'} onPointerDown={(e) => e.stopPropagation()} onClick={() => act(it.cancel!())}>
                ✕
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
