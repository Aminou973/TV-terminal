import { describe, expect, it } from 'vitest'
import { joinBars, parseSpread } from './datasource'

const bar = (time: number, c: number) => ({ time, open: c, high: c + 1, low: c - 1, close: c, volume: 5 })

describe('spreads', () => {
  it('parses legs with coefficients; plain symbols are not spreads', () => {
    expect(parseSpread('2 * ES - NQ')).toEqual({ a: { symbol: 'ES', k: 2 }, b: { symbol: 'NQ', k: 1 }, op: '-' })
    expect(parseSpread('GC / SI')?.op).toBe('/')
    expect(parseSpread('BINANCE-BTCUSDT')).toBeNull()
    expect(parseSpread('ES')).toBeNull()
  })

  it('joins on time and combines OHLC', () => {
    const s = parseSpread('ES - NQ')!
    const out = joinBars(s, [bar(1, 10), bar(2, 12), bar(3, 13)], [bar(2, 4), bar(3, 5)])
    expect(out.map((b) => [b.time, b.close])).toEqual([[2, 8], [3, 8]])
    expect(out[0].high).toBeGreaterThanOrEqual(out[0].low)
  })
})
