import { getHistory, type BarData } from '../api/client'
import { stream } from './stream'

// ---------------------------------------------------------------------------
// Where a chart's bars come from: a plain symbol (REST history + WS bars), or
// a two-leg spread/ratio like "ES - NQ", "GC / SI", "2 * ES - NQ" computed
// client-side from both legs (operator needs spaces: symbols may contain '-').
// ---------------------------------------------------------------------------

export interface DataSource {
  history: (opts: { limit: number; to?: number }) => Promise<BarData[]>
  subscribe: (cb: (bar: BarData) => void) => () => void
  /** true for computed series (no server-side quotes/alerts/trading) */
  synthetic: boolean
}

interface Leg {
  symbol: string
  k: number
}

export interface Spread {
  a: Leg
  b: Leg
  op: '+' | '-' | '*' | '/'
}

/** Tokens are space-separated: [k *] SYMBOL op [k *] SYMBOL. */
export function parseSpread(expr: string): Spread | null {
  const t = expr.trim().split(/\s+/)
  let i = 0
  const leg = (): Leg | null => {
    let k = 1
    if (/^\d*\.?\d+$/.test(t[i] ?? '') && t[i + 1] === '*') {
      k = Number(t[i])
      i += 2
    }
    const symbol = t[i++]
    return symbol && !/^[-+*/]$/.test(symbol) ? { symbol, k } : null
  }
  const a = leg()
  const op = t[i++]
  const b = leg()
  if (!a || !b || i !== t.length || !op || !/^[-+*/]$/.test(op)) return null
  return { a, b, op: op as Spread['op'] }
}

const apply = (op: Spread['op'], x: number, y: number) =>
  op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : y === 0 ? NaN : x / y

export function combine(s: Spread, a: BarData, b: BarData, time = Math.max(a.time, b.time)): BarData {
  const f = (k: 'open' | 'high' | 'low' | 'close') => apply(s.op, a[k] * s.a.k, b[k] * s.b.k)
  const vals = [f('open'), f('high'), f('low'), f('close')].filter(Number.isFinite)
  const open = f('open')
  const close = f('close')
  return { time, open, close, high: Math.max(...vals), low: Math.min(...vals), volume: 0 }
}

/** Inner join on bar time. */
export function joinBars(s: Spread, as: BarData[], bs: BarData[]): BarData[] {
  const byTime = new Map(bs.map((b) => [b.time, b]))
  const out: BarData[] = []
  for (const a of as) {
    const b = byTime.get(a.time)
    if (b) {
      const c = combine(s, a, b, a.time)
      if (Number.isFinite(c.open) && Number.isFinite(c.close)) out.push(c)
    }
  }
  return out
}

export function sourceFor(symbol: string, tf: string): DataSource {
  const spread = parseSpread(symbol)
  if (!spread) {
    return {
      synthetic: false,
      history: async (opts) => (await getHistory(symbol, tf, opts)).bars,
      subscribe: (cb) => stream.subscribeBars(symbol, tf, (m) => cb(m.bar)),
    }
  }
  return {
    synthetic: true,
    history: async (opts) => {
      const [a, b] = await Promise.all([getHistory(spread.a.symbol, tf, opts), getHistory(spread.b.symbol, tf, opts)])
      return joinBars(spread, a.bars, b.bars)
    },
    subscribe: (cb) => {
      let la: BarData | null = null
      let lb: BarData | null = null
      const emit = () => {
        if (la && lb) {
          const c = combine(spread, la, lb)
          if (Number.isFinite(c.close)) cb(c)
        }
      }
      const offA = stream.subscribeBars(spread.a.symbol, tf, (m) => ((la = m.bar), emit()))
      const offB = stream.subscribeBars(spread.b.symbol, tf, (m) => ((lb = m.bar), emit()))
      return () => {
        offA()
        offB()
      }
    },
  }
}
