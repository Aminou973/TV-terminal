// ---------------------------------------------------------------------------
// OpenScript — a small Pine-flavoured scripting layer in plain JavaScript.
//
// Series are arrays aligned with the bars (index 0 = oldest). Indicators are
// written vectorised (ta.* return whole series); strategies add a per-bar
// callback where orders are placed. Runs inside a Web Worker (worker.ts);
// this module has no DOM dependencies so it can also be unit-tested.
//
//   // @name EMA Cross
//   const fast = input('Fast', 9), slow = input('Slow', 21)
//   const f = ta.ema(close, fast), s = ta.ema(close, slow)
//   plot(f, 'Fast', '#2962FF'); plot(s, 'Slow', '#FF6D00')
//   strategy.onBar(i => {
//     if (ta.crossedUp(f, s, i)) strategy.entry('L', 'long')
//     if (ta.crossedDown(f, s, i)) strategy.entry('S', 'short')
//   })
// ---------------------------------------------------------------------------

export interface Bar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type Series = number[]

export interface ScriptPlot {
  id: string
  title: string
  color: string
  lineWidth: number
  style: 'line' | 'histogram' | 'area' | 'circles' | 'stepline'
}

export interface ScriptInput {
  id: string
  title: string
  type: 'int' | 'float' | 'bool' | 'string' | 'source'
  defval: unknown
  options?: string[]
  min?: number
  max?: number
}

export interface Trade {
  id: string
  side: 'long' | 'short'
  qty: number
  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number
  pnl: number
  pnlPct: number
  exitReason: string
  bars: number
}

export interface StrategyReport {
  trades: Trade[]
  equity: { time: number; value: number }[]
  drawdown: { time: number; value: number }[]
  metrics: {
    netProfit: number
    netProfitPct: number
    grossProfit: number
    grossLoss: number
    totalTrades: number
    winRate: number
    profitFactor: number | null
    maxDrawdown: number
    maxDrawdownPct: number
    avgTrade: number
    avgWin: number
    avgLoss: number
    largestWin: number
    largestLoss: number
    sharpe: number | null
    buyHoldPct: number
    commissionPaid: number
    openPnl: number
  }
}

export interface ScriptResult {
  name: string
  overlay: boolean
  kind: 'indicator' | 'strategy'
  inputs: ScriptInput[]
  plots: ScriptPlot[]
  plotData: Record<string, { time: number; value: number | null; color?: string }[]>
  hlines: { id: string; price: number; title: string; color: string }[]
  markers: { time: number; position: 'aboveBar' | 'belowBar'; shape: string; color: string; text?: string }[]
  strategy: StrategyReport | null
  logs: string[]
}

// ------------------------------------------------------------------ ta ----
const nan = Number.NaN
const isNum = (v: number) => typeof v === 'number' && Number.isFinite(v)

function src(x: Series | number, n: number): Series {
  return Array.isArray(x) ? x : new Array(n).fill(x)
}

export const ta = {
  sma(s: Series, len: number): Series {
    const out = new Array(s.length).fill(nan)
    let sum = 0
    let count = 0
    for (let i = 0; i < s.length; i++) {
      if (isNum(s[i])) {
        sum += s[i]
        count++
      }
      if (i >= len && isNum(s[i - len])) {
        sum -= s[i - len]
        count--
      }
      if (i >= len - 1 && count === len) out[i] = sum / len
    }
    return out
  },
  ema(s: Series, len: number): Series {
    const out = new Array(s.length).fill(nan)
    const a = 2 / (len + 1)
    let prev = nan
    let seed = 0
    let seen = 0
    for (let i = 0; i < s.length; i++) {
      const v = s[i]
      if (!isNum(v)) continue
      if (!isNum(prev)) {
        seed += v
        seen++
        if (seen === len) {
          prev = seed / len
          out[i] = prev
        }
      } else {
        prev = a * v + (1 - a) * prev
        out[i] = prev
      }
    }
    return out
  },
  rma(s: Series, len: number): Series {
    const out = new Array(s.length).fill(nan)
    let prev = nan
    let seed = 0
    let seen = 0
    for (let i = 0; i < s.length; i++) {
      const v = s[i]
      if (!isNum(v)) continue
      if (!isNum(prev)) {
        seed += v
        seen++
        if (seen === len) out[i] = prev = seed / len
      } else {
        out[i] = prev = (prev * (len - 1) + v) / len
      }
    }
    return out
  },
  wma(s: Series, len: number): Series {
    const out = new Array(s.length).fill(nan)
    const denom = (len * (len + 1)) / 2
    for (let i = len - 1; i < s.length; i++) {
      let acc = 0
      let ok = true
      for (let k = 0; k < len; k++) {
        const v = s[i - k]
        if (!isNum(v)) {
          ok = false
          break
        }
        acc += v * (len - k)
      }
      if (ok) out[i] = acc / denom
    }
    return out
  },
  stdev(s: Series, len: number): Series {
    const mean = ta.sma(s, len)
    return s.map((_, i) => {
      if (!isNum(mean[i])) return nan
      let acc = 0
      for (let k = 0; k < len; k++) acc += (s[i - k] - mean[i]) ** 2
      return Math.sqrt(acc / len)
    })
  },
  highest(s: Series, len: number): Series {
    return s.map((_, i) => (i < len - 1 ? nan : Math.max(...s.slice(i - len + 1, i + 1))))
  },
  lowest(s: Series, len: number): Series {
    return s.map((_, i) => (i < len - 1 ? nan : Math.min(...s.slice(i - len + 1, i + 1))))
  },
  change(s: Series, len = 1): Series {
    return s.map((v, i) => (i < len ? nan : v - s[i - len]))
  },
  mom(s: Series, len: number): Series {
    return ta.change(s, len)
  },
  roc(s: Series, len: number): Series {
    return s.map((v, i) => (i < len || !s[i - len] ? nan : ((v - s[i - len]) / s[i - len]) * 100))
  },
  sum(s: Series, len: number): Series {
    return ta.sma(s, len).map((v) => v * len)
  },
  rsi(s: Series, len = 14): Series {
    const up = s.map((v, i) => (i === 0 ? nan : Math.max(v - s[i - 1], 0)))
    const dn = s.map((v, i) => (i === 0 ? nan : Math.max(s[i - 1] - v, 0)))
    const ru = ta.rma(up, len)
    const rd = ta.rma(dn, len)
    return ru.map((u, i) => (!isNum(u) || !isNum(rd[i]) ? nan : rd[i] === 0 ? 100 : 100 - 100 / (1 + u / rd[i])))
  },
  macd(s: Series, fast = 12, slow = 26, signal = 9) {
    const f = ta.ema(s, fast)
    const sl = ta.ema(s, slow)
    const macd = f.map((v, i) => v - sl[i])
    const sig = ta.ema(macd, signal)
    return { macd, signal: sig, hist: macd.map((v, i) => v - sig[i]) }
  },
  bb(s: Series, len = 20, mult = 2) {
    const basis = ta.sma(s, len)
    const dev = ta.stdev(s, len)
    return { basis, upper: basis.map((b, i) => b + mult * dev[i]), lower: basis.map((b, i) => b - mult * dev[i]) }
  },
  tr(high: Series, low: Series, close: Series): Series {
    return high.map((h, i) =>
      i === 0 ? h - low[i] : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1])),
    )
  },
  atr(high: Series, low: Series, close: Series, len = 14): Series {
    return ta.rma(ta.tr(high, low, close), len)
  },
  stoch(close: Series, high: Series, low: Series, len = 14): Series {
    const hh = ta.highest(high, len)
    const ll = ta.lowest(low, len)
    return close.map((c, i) => (hh[i] === ll[i] ? nan : ((c - ll[i]) / (hh[i] - ll[i])) * 100))
  },
  cci(s: Series, len = 20): Series {
    const ma = ta.sma(s, len)
    return s.map((v, i) => {
      if (!isNum(ma[i])) return nan
      let md = 0
      for (let k = 0; k < len; k++) md += Math.abs(s[i - k] - ma[i])
      md /= len
      return md === 0 ? 0 : (v - ma[i]) / (0.015 * md)
    })
  },
  vwap(high: Series, low: Series, close: Series, volume: Series): Series {
    let pv = 0
    let vv = 0
    return close.map((c, i) => {
      pv += ((high[i] + low[i] + c) / 3) * volume[i]
      vv += volume[i]
      return vv ? pv / vv : nan
    })
  },
  obv(close: Series, volume: Series): Series {
    let acc = 0
    return close.map((c, i) => {
      if (i > 0) acc += c > close[i - 1] ? volume[i] : c < close[i - 1] ? -volume[i] : 0
      return acc
    })
  },
  crossover(a: Series | number, b: Series | number): boolean[] {
    const n = Array.isArray(a) ? a.length : (b as Series).length
    const x = src(a, n)
    const y = src(b, n)
    return x.map((v, i) => i > 0 && v > y[i] && x[i - 1] <= y[i - 1])
  },
  crossunder(a: Series | number, b: Series | number): boolean[] {
    const n = Array.isArray(a) ? a.length : (b as Series).length
    const x = src(a, n)
    const y = src(b, n)
    return x.map((v, i) => i > 0 && v < y[i] && x[i - 1] >= y[i - 1])
  },
  /** Per-bar helpers for strategy callbacks. */
  crossedUp(a: Series | number, b: Series | number, i: number): boolean {
    const av = (j: number) => (Array.isArray(a) ? a[j] : a)
    const bv = (j: number) => (Array.isArray(b) ? b[j] : b)
    return i > 0 && av(i) > bv(i) && av(i - 1) <= bv(i - 1)
  },
  crossedDown(a: Series | number, b: Series | number, i: number): boolean {
    const av = (j: number) => (Array.isArray(a) ? a[j] : a)
    const bv = (j: number) => (Array.isArray(b) ? b[j] : b)
    return i > 0 && av(i) < bv(i) && av(i - 1) >= bv(i - 1)
  },
}

// ------------------------------------------------------------ strategy ----
interface StrategyOptions {
  initialCapital: number
  qty: number
  /** commission per side, percent of notional */
  commissionPct: number
  /** $ per point (futures); 1 for stocks/crypto */
  pointValue: number
  /** fill market orders on the next bar's open (TV default) or this bar's close */
  fillOnClose: boolean
}

interface PendingOrder {
  kind: 'entry' | 'close'
  id: string
  side?: 'long' | 'short'
  qty?: number
  sl?: number
  tp?: number
  reason: string
}

interface Position {
  id: string
  side: 'long' | 'short'
  qty: number
  entryPrice: number
  entryTime: number
  entryIndex: number
  sl?: number
  tp?: number
}

function runStrategy(bars: Bar[], onBar: (i: number) => void, ctl: StrategyControl, opts: StrategyOptions): StrategyReport {
  const trades: Trade[] = []
  const equity: { time: number; value: number }[] = []
  const drawdown: { time: number; value: number }[] = []
  let realized = 0
  let commission = 0
  let pos: Position | null = null
  let pending: PendingOrder[] = []
  let peak = opts.initialCapital
  let maxDd = 0
  let maxDdPct = 0

  const fee = (price: number, qty: number) => (price * qty * opts.pointValue * opts.commissionPct) / 100

  const closePos = (price: number, time: number, i: number, reason: string) => {
    if (!pos) return
    const dir = pos.side === 'long' ? 1 : -1
    const gross = (price - pos.entryPrice) * dir * pos.qty * opts.pointValue
    const c = fee(price, pos.qty)
    commission += c
    realized += gross - c
    trades.push({
      id: pos.id,
      side: pos.side,
      qty: pos.qty,
      entryTime: pos.entryTime,
      entryPrice: pos.entryPrice,
      exitTime: time,
      exitPrice: price,
      pnl: gross - c - fee(pos.entryPrice, pos.qty),
      pnlPct: ((price - pos.entryPrice) / pos.entryPrice) * 100 * dir,
      exitReason: reason,
      bars: i - pos.entryIndex,
    })
    pos = null
  }

  const openPos = (o: PendingOrder, price: number, time: number, i: number) => {
    const qty = o.qty ?? opts.qty
    const c = fee(price, qty)
    commission += c
    realized -= c
    pos = { id: o.id, side: o.side!, qty, entryPrice: price, entryTime: time, entryIndex: i, sl: o.sl, tp: o.tp }
  }

  const execute = (orders: PendingOrder[], price: number, time: number, i: number) => {
    for (const o of orders) {
      if (o.kind === 'close') {
        if (pos && (o.id === '*' || o.id === pos.id)) closePos(price, time, i, o.reason)
      } else {
        if (pos && pos.side === o.side) continue // already in that direction (pyramiding off)
        if (pos) closePos(price, time, i, `reverse to ${o.id}`)
        openPos(o, price, time, i)
      }
    }
  }

  ctl.bind({
    entry: (id, side, o = {}) => pending.push({ kind: 'entry', id, side, qty: o.qty, sl: o.sl, tp: o.tp, reason: id }),
    close: (id = '*', reason = 'close') => pending.push({ kind: 'close', id, reason }),
    position: () => (pos ? { side: pos.side, qty: pos.qty, entryPrice: pos.entryPrice, id: pos.id } : null),
  })

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    // 1) orders placed on the previous bar fill at this bar's open
    if (!opts.fillOnClose && pending.length) {
      const orders = pending
      pending = []
      execute(orders, b.open, b.time, i)
    }
    // 2) protective exits inside this bar (stop checked first: conservative)
    if (pos) {
      const p = pos as Position
      const long = p.side === 'long'
      if (p.sl != null && (long ? b.low <= p.sl : b.high >= p.sl)) {
        closePos(long ? Math.min(b.open, p.sl) : Math.max(b.open, p.sl), b.time, i, 'stop loss')
      } else if (p.tp != null && (long ? b.high >= p.tp : b.low <= p.tp)) {
        closePos(long ? Math.max(b.open, p.tp) : Math.min(b.open, p.tp), b.time, i, 'take profit')
      }
    }
    // 3) the script decides on this bar's close
    onBar(i)
    if (opts.fillOnClose && pending.length) {
      const orders = pending
      pending = []
      execute(orders, b.close, b.time, i)
    }
    // 4) mark to market
    const cur = pos as Position | null // mutated inside closures; TS can't see it
    const open = cur ? (b.close - cur.entryPrice) * (cur.side === 'long' ? 1 : -1) * cur.qty * opts.pointValue : 0
    const eq = opts.initialCapital + realized + open
    equity.push({ time: b.time, value: eq })
    peak = Math.max(peak, eq)
    const dd = peak - eq
    drawdown.push({ time: b.time, value: -dd })
    if (dd > maxDd) maxDd = dd
    if (peak > 0) maxDdPct = Math.max(maxDdPct, (dd / peak) * 100)
  }

  const last = bars[bars.length - 1]
  const openPnl = pos && last ? (last.close - (pos as Position).entryPrice) * ((pos as Position).side === 'long' ? 1 : -1) * (pos as Position).qty * opts.pointValue : 0
  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl <= 0)
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0)
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0)
  const rets = equity.map((e, i) => (i === 0 ? 0 : equity[i - 1].value ? e.value / equity[i - 1].value - 1 : 0)).slice(1)
  const mean = rets.reduce((a, r) => a + r, 0) / (rets.length || 1)
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1))
  const first = bars[0]

  return {
    trades,
    equity,
    drawdown,
    metrics: {
      netProfit: realized,
      netProfitPct: (realized / opts.initialCapital) * 100,
      grossProfit,
      grossLoss,
      totalTrades: trades.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      maxDrawdown: maxDd,
      maxDrawdownPct: maxDdPct,
      avgTrade: trades.length ? trades.reduce((a, t) => a + t.pnl, 0) / trades.length : 0,
      avgWin: wins.length ? grossProfit / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
      largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
      sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : null,
      buyHoldPct: first && last ? (last.close / first.open - 1) * 100 : 0,
      commissionPaid: commission,
      openPnl,
    },
  }
}

interface StrategyApi {
  entry: (id: string, side: 'long' | 'short', o?: { qty?: number; sl?: number; tp?: number }) => void
  close: (id?: string, reason?: string) => void
  position: () => { side: 'long' | 'short'; qty: number; entryPrice: number; id: string } | null
}

class StrategyControl {
  private api: StrategyApi | null = null
  bind(api: StrategyApi) {
    this.api = api
  }
  get(): StrategyApi {
    if (!this.api) throw new Error('strategy.entry/close can only be called inside strategy.onBar')
    return this.api
  }
}

// ---------------------------------------------------------------- runner ----
const PALETTE = ['#2962FF', '#FF6D00', '#AB47BC', '#26A69A', '#F23645', '#FDD835', '#7E57C2', '#00BCD4']

/**
 * Worker globals shadowed as undefined parameters. This is hygiene, not a
 * security boundary — the boundary is the dedicated Worker (no DOM, no
 * token: auth lives in the page's storage) that the host kills on timeout.
 */
const BLOCKED = [
  'self', 'globalThis', 'window', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'importScripts', 'postMessage', 'indexedDB', 'caches', 'localStorage', 'sessionStorage',
  'navigator', 'location', 'setTimeout', 'setInterval',
]

export function runScript(
  source: string,
  bars: Bar[],
  inputValues: Record<string, unknown> = {},
  opts: { pointValue?: number; strategy?: Partial<StrategyOptions> } = {},
): ScriptResult {
  const n = bars.length
  const col = (k: keyof Bar) => bars.map((b) => b[k] as number)
  const open = col('open')
  const high = col('high')
  const low = col('low')
  const close = col('close')
  const volume = col('volume')
  const time = col('time')
  const hl2 = high.map((h, i) => (h + low[i]) / 2)
  const hlc3 = high.map((h, i) => (h + low[i] + close[i]) / 3)
  const ohlc4 = open.map((o, i) => (o + high[i] + low[i] + close[i]) / 4)
  const sources: Record<string, Series> = { open, high, low, close, hl2, hlc3, ohlc4, volume }

  const meta = {
    name: /\/\/\s*@name\s+(.+)/.exec(source)?.[1]?.trim() ?? 'Script',
    overlay: !/\/\/\s*@overlay\s+false/.test(source),
  }
  const inputs: ScriptInput[] = []
  const plots: ScriptPlot[] = []
  const plotData: ScriptResult['plotData'] = {}
  const hlines: ScriptResult['hlines'] = []
  const markers: ScriptResult['markers'] = []
  const logs: string[] = []
  let onBar: ((i: number) => void) | null = null
  const strategyOpts: StrategyOptions = {
    initialCapital: 100_000,
    qty: 1,
    commissionPct: 0,
    pointValue: opts.pointValue ?? 1,
    fillOnClose: false,
    ...opts.strategy,
  }
  const ctl = new StrategyControl()

  const toPoints = (s: Series | boolean[], colors?: (string | null)[]) =>
    s.map((v, i) => {
      const value = typeof v === 'boolean' ? (v ? 1 : 0) : v
      const p: { time: number; value: number | null; color?: string } = { time: time[i], value: isNum(value) ? value : null }
      if (colors?.[i]) p.color = colors[i]!
      return p
    })

  const api = {
    open, high, low, close, volume, time, hl2, hlc3, ohlc4, bar_count: n,
    na: nan,
    nz: (v: number, d = 0) => (isNum(v) ? v : d),
    ta,
    math: Math,
    indicator(o: { name?: string; overlay?: boolean }) {
      if (o.name) meta.name = o.name
      if (o.overlay != null) meta.overlay = o.overlay
    },
    input(title: string, defval: unknown, o: { options?: string[]; min?: number; max?: number; type?: ScriptInput['type'] } = {}) {
      const id = title
      let type: ScriptInput['type'] = o.type ?? (typeof defval === 'boolean' ? 'bool' : typeof defval === 'string' ? 'string' : Number.isInteger(defval) ? 'int' : 'float')
      if (typeof defval === 'string' && defval in sources && !o.options) type = 'source'
      if (!inputs.some((x) => x.id === id)) inputs.push({ id, title, type, defval, options: o.options, min: o.min, max: o.max })
      const v = id in inputValues ? inputValues[id] : defval
      return type === 'source' ? sources[String(v)] ?? close : v
    },
    plot(series: Series | boolean[], title?: string, color?: string, o: { style?: ScriptPlot['style']; width?: number; colors?: (string | null)[] } = {}) {
      const id = `plot${plots.length}`
      plots.push({
        id,
        title: title ?? id,
        color: color ?? PALETTE[plots.length % PALETTE.length],
        lineWidth: o.width ?? (o.style === 'histogram' ? 1 : 2),
        style: o.style ?? 'line',
      })
      plotData[id] = toPoints(series, o.colors)
    },
    hline(price: number, title = '', color = '#787B86') {
      hlines.push({ id: `hline${hlines.length}`, price, title, color })
    },
    plotshape(cond: boolean[], o: { location?: 'above' | 'below'; color?: string; text?: string; shape?: string } = {}) {
      cond.forEach((c, i) => {
        if (c)
          markers.push({
            time: time[i],
            position: o.location === 'below' ? 'belowBar' : 'aboveBar',
            shape: o.shape ?? (o.location === 'below' ? 'arrowUp' : 'arrowDown'),
            color: o.color ?? '#2962FF',
            text: o.text,
          })
      })
    },
    log: (...a: unknown[]) => logs.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')),
    strategy: Object.assign(
      (o: Partial<StrategyOptions>) => Object.assign(strategyOpts, o),
      {
        onBar: (fn: (i: number) => void) => {
          onBar = fn
        },
        entry: (id: string, side: 'long' | 'short', o?: { qty?: number; sl?: number; tp?: number }) => ctl.get().entry(id, side, o),
        close: (id?: string, reason?: string) => ctl.get().close(id, reason),
        closeAll: (reason = 'close all') => ctl.get().close('*', reason),
        position: () => ctl.get().position(),
      },
    ),
  }

  const names = [...Object.keys(api), ...BLOCKED]
  const values = [...Object.values(api), ...BLOCKED.map(() => undefined)]
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `"use strict";\n${source}`)
  fn(...values)

  let report: StrategyReport | null = null
  if (onBar) {
    report = runStrategy(bars, onBar, ctl, strategyOpts)
    for (const t of report.trades) {
      const long = t.side === 'long'
      markers.push({ time: t.entryTime, position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: long ? '#2962FF' : '#F23645', text: t.id })
      markers.push({ time: t.exitTime, position: long ? 'aboveBar' : 'belowBar', shape: 'circle', color: '#787B86', text: t.pnl >= 0 ? `+${t.pnl.toFixed(0)}` : t.pnl.toFixed(0) })
    }
  }

  return {
    name: meta.name,
    overlay: meta.overlay,
    kind: onBar ? 'strategy' : 'indicator',
    inputs,
    plots,
    plotData,
    hlines,
    markers: markers.sort((a, b) => a.time - b.time),
    strategy: report,
    logs,
  }
}
