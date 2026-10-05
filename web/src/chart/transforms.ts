import type { BarData } from '../api/client'

// ---------------------------------------------------------------------------
// Non-time-based chart types, built client-side from the stored bars.
// Every output keeps strictly increasing times (the chart requires it): when
// several bricks/columns come out of one bar they get +1s offsets.
// ---------------------------------------------------------------------------

export interface TransformParams {
  /** box size in price units; 0/undefined = ATR(14) of the source */
  box?: number
  /** reversal in boxes (P&F) — default 3 */
  reversal?: number
  /** lines for a line-break reversal — default 3 */
  lines?: number
}

/** Mean true range over the last 200 bars (a stable box-size basis). */
function atr(bars: BarData[]): number {
  if (bars.length < 2) return bars[0] ? Math.max(bars[0].high - bars[0].low, Math.abs(bars[0].close) * 0.001) : 1
  let sum = 0
  let k = 0
  for (let i = Math.max(1, bars.length - 200); i < bars.length; i++) {
    const b = bars[i]
    const p = bars[i - 1].close
    sum += Math.max(b.high - b.low, Math.abs(b.high - p), Math.abs(b.low - p))
    k++
  }
  return sum / Math.max(1, k) || Math.abs(bars[bars.length - 1].close) * 0.001 || 1
}

/** Round to 1/2/2.5/5 × 10^n so boxes are readable numbers. */
export function niceStep(v: number): number {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  const step = m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10
  return step * p
}

export const autoBox = (bars: BarData[]) => niceStep(atr(bars))

function stamp(out: BarData[], t: number): number {
  const last = out.length ? out[out.length - 1].time : -Infinity
  return t > last ? t : last + 1
}

export function heikinAshi(bars: BarData[]): BarData[] {
  const out: BarData[] = []
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const close = (b.open + b.high + b.low + b.close) / 4
    const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2
    out.push({ ...b, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) })
  }
  return out
}

/**
 * Traditional Renko on closes. Tracking the last brick's high/low makes a
 * continuation need 1 box and a reversal 2 boxes from the last brick close.
 */
export function renko(bars: BarData[], p: TransformParams = {}): BarData[] {
  const box = p.box || autoBox(bars)
  const out: BarData[] = []
  if (!bars.length) return out
  let hi = Math.floor(bars[0].close / box) * box
  let lo = hi
  for (const b of bars) {
    while (true) {
      if (b.close >= hi + box) {
        out.push({ time: stamp(out, b.time), open: hi, high: hi + box, low: hi, close: hi + box, volume: 0 })
        lo = hi
        hi += box
      } else if (b.close <= lo - box) {
        out.push({ time: stamp(out, b.time), open: lo, high: lo, low: lo - box, close: lo - box, volume: 0 })
        hi = lo
        lo -= box
      } else break
    }
    // volume accrues to the brick in progress (the latest one)
    if (out.length) out[out.length - 1].volume += b.volume
  }
  return out
}

/**
 * Range bars of a fixed high-low span. The path inside each source bar is
 * approximated as open → nearer extreme → farther extreme → close.
 */
export function rangeBars(bars: BarData[], p: TransformParams = {}): BarData[] {
  const range = p.box || autoBox(bars)
  const out: BarData[] = []
  let cur: BarData | null = null
  const feed = (price: number, t: number, vol: number) => {
    if (!cur) {
      cur = { time: stamp(out, t), open: price, high: price, low: price, close: price, volume: 0 }
    }
    let px = price
    // split long moves into full-range bars
    while (true) {
      const c: BarData = cur
      if (px > c.high && px - c.low >= range) {
        c.high = c.low + range
        c.close = c.high
        out.push(c)
        cur = { time: stamp(out, t), open: c.close, high: c.close, low: c.close, close: c.close, volume: 0 }
      } else if (px < c.low && c.high - px >= range) {
        c.low = c.high - range
        c.close = c.low
        out.push(c)
        cur = { time: stamp(out, t), open: c.close, high: c.close, low: c.close, close: c.close, volume: 0 }
      } else {
        c.high = Math.max(c.high, px)
        c.low = Math.min(c.low, px)
        c.close = px
        c.volume += vol
        break
      }
      px = price
    }
  }
  for (const b of bars) {
    const upFirst = Math.abs(b.high - b.open) < Math.abs(b.open - b.low)
    const path = upFirst ? [b.open, b.high, b.low, b.close] : [b.open, b.low, b.high, b.close]
    path.forEach((px, i) => feed(px, b.time, i === 3 ? b.volume : 0))
  }
  if (cur) out.push(cur)
  return out
}

/** N-line break: a new line only when the close breaks the last N lines' extreme. */
export function lineBreak(bars: BarData[], p: TransformParams = {}): BarData[] {
  const n = p.lines || 3
  const out: BarData[] = []
  for (const b of bars) {
    if (!out.length) {
      out.push({ time: b.time, open: b.open, high: Math.max(b.open, b.close), low: Math.min(b.open, b.close), close: b.close, volume: b.volume })
      continue
    }
    const last = out[out.length - 1]
    const recent = out.slice(-n)
    const hi = Math.max(...recent.map((l) => Math.max(l.open, l.close)))
    const lo = Math.min(...recent.map((l) => Math.min(l.open, l.close)))
    const up = last.close >= last.open
    let open: number | null = null
    if (b.close > (up ? Math.max(last.open, last.close) : hi)) open = up ? last.close : last.open
    else if (b.close < (up ? lo : Math.min(last.open, last.close))) open = up ? last.open : last.close
    if (open === null) {
      last.volume += b.volume
      continue
    }
    out.push({ time: stamp(out, b.time), open, high: Math.max(open, b.close), low: Math.min(open, b.close), close: b.close, volume: b.volume })
  }
  return out
}

/** Kagi turning points (reversal = box); drawn as a stepped line. */
export function kagi(bars: BarData[], p: TransformParams = {}): BarData[] {
  const rev = p.box || autoBox(bars) * 2
  const out: BarData[] = []
  if (!bars.length) return out
  const pt = (t: number, v: number): BarData => ({ time: stamp(out, t), open: v, high: v, low: v, close: v, volume: 0 })
  const first = bars[0].close
  out.push(pt(bars[0].time, first))
  let dir = 0 // set once price has moved a full reversal from the start
  let ext = first
  let extTime = bars[0].time
  for (const b of bars) {
    const c = b.close
    if (dir === 0) {
      if (Math.abs(c - first) >= rev) {
        dir = c > first ? 1 : -1
        ext = c
        extTime = b.time
      }
      continue
    }
    if ((dir > 0 && c > ext) || (dir < 0 && c < ext)) {
      ext = c
      extTime = b.time
    } else if ((dir > 0 && c <= ext - rev) || (dir < 0 && c >= ext + rev)) {
      out.push(pt(extTime, ext))
      dir = -dir
      ext = c
      extTime = b.time
    }
  }
  if (dir !== 0) out.push(pt(extTime, ext))
  return out
}

/** Point & Figure columns (close method) as boxes: X column up, O column down. */
export function pointFigure(bars: BarData[], p: TransformParams = {}): BarData[] {
  const box = p.box || autoBox(bars)
  const reversal = p.reversal || 3
  const out: BarData[] = []
  if (!bars.length) return out
  let dir = 0
  let top = Math.floor(bars[0].close / box) * box
  let bottom = top
  let start = bars[0].time
  const flush = () => {
    if (dir === 0) return
    const up = dir > 0
    out.push({ time: stamp(out, start), open: up ? bottom : top, high: top, low: bottom, close: up ? top : bottom, volume: 0 })
  }
  for (const b of bars) {
    const c = b.close
    if (dir >= 0 && c >= top + box) {
      if (dir === 0) start = b.time
      dir = 1
      top = Math.floor(c / box) * box
    } else if (dir <= 0 && c <= bottom - box) {
      if (dir === 0) start = b.time
      dir = -1
      bottom = Math.ceil(c / box) * box
    } else if (dir > 0 && c <= top - reversal * box) {
      flush()
      start = b.time
      dir = -1
      bottom = Math.ceil(c / box) * box
      top = top - box
    } else if (dir < 0 && c >= bottom + reversal * box) {
      flush()
      start = b.time
      dir = 1
      top = Math.floor(c / box) * box
      bottom = bottom + box
    }
  }
  flush()
  return out
}
