// Order-entry arithmetic shared by the ticket, the DOM and the chart overlay.

export type Side = 'buy' | 'sell'

/** Snap a price to the instrument's tick grid (and kill float noise). */
export function roundToTick(price: number, tick: number): number {
  const n = Math.round(price / tick)
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)) + 2)
  return Number((n * tick).toFixed(decimals))
}

/** Digits needed to show prices on a tick grid (0.25 → 2, 1/64 → 6). */
export function tickDigits(tick: number): number {
  for (let d = 0; d <= 8; d++) if (Math.abs(Math.round(tick * 10 ** d) - tick * 10 ** d) < 1e-9) return d
  return 8
}

/** Take-profit / stop-loss prices `ticks` away from an entry, on the right side for the order's direction. */
export function bracketPrices(side: Side, entry: number, tick: number, tpTicks?: number | null, slTicks?: number | null) {
  const d = side === 'buy' ? 1 : -1
  return {
    tp: tpTicks ? roundToTick(entry + d * tpTicks * tick, tick) : undefined,
    sl: slTicks ? roundToTick(entry - d * slTicks * tick, tick) : undefined,
  }
}

/** $ P&L of moving from `entry` to `exit` with `qty` (positive) contracts. */
export const pnl = (side: Side, entry: number, exit: number, qty: number, pointValue: number) =>
  (exit - entry) * (side === 'buy' ? 1 : -1) * qty * pointValue

/** Largest whole size whose loss at the stop stays within `riskPct` of equity. */
export function riskQty(equity: number, riskPct: number, entry: number, stop: number, pointValue: number): number {
  const perContract = Math.abs(entry - stop) * pointValue
  if (!(perContract > 0) || !(equity > 0) || !(riskPct > 0)) return 0
  return Math.floor((equity * riskPct) / 100 / perContract)
}

/** Which resting order a click at `price` means on a ladder: limits below/above market, stops beyond it. */
export function ladderOrderType(side: Side, price: number, last: number): 'limit' | 'stop' {
  if (side === 'buy') return price < last ? 'limit' : 'stop'
  return price > last ? 'limit' : 'stop'
}

export const money = (v: number) =>
  `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const signedMoney = (v: number) => `${v > 0 ? '+' : ''}${money(v)}`
