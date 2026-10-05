import { describe, expect, it } from 'vitest'
import type { BarData } from '../api/client'
import { heikinAshi, kagi, lineBreak, niceStep, pointFigure, rangeBars, renko } from './transforms'

const closes = (xs: number[]): BarData[] =>
  xs.map((c, i) => ({ time: 1000 + i * 60, open: c, high: c, low: c, close: c, volume: 1 }))

const increasing = (bars: BarData[]) => bars.every((b, i) => i === 0 || b.time > bars[i - 1].time)

describe('transforms', () => {
  it('niceStep rounds to readable boxes', () => {
    expect(niceStep(0.37)).toBe(0.5)
    expect(niceStep(13)).toBe(10)
    expect(niceStep(2.1)).toBe(2)
  })

  it('renko: continuation 1 box, reversal 2 boxes', () => {
    const out = renko(closes([100, 101, 103, 102, 100.5, 99]), { box: 1 })
    expect(out.map((b) => [b.open, b.close])).toEqual([
      [100, 101], [101, 102], [102, 103], // up 3
      [102, 101], [101, 100], [100, 99], // reversal needs close ≤ 101 (2 boxes below 103)
    ])
    expect(increasing(out)).toBe(true)
  })

  it('line break needs to exceed the last 3 lines', () => {
    const out = lineBreak(closes([10, 11, 12, 13, 12.5, 9]), { lines: 3 })
    expect(out.map((b) => b.close)).toEqual([10, 11, 12, 13, 9])
  })

  it('range bars have a fixed span', () => {
    const out = rangeBars(closes([10, 12, 15]), { box: 2 })
    for (const b of out.slice(0, -1)) expect(b.high - b.low).toBeCloseTo(2)
    expect(increasing(out)).toBe(true)
  })

  it('kagi and point & figure produce turning points / columns', () => {
    expect(kagi(closes([10, 14, 11, 9, 13]), { box: 2 }).map((b) => b.close)).toEqual([10, 14, 9, 13])
    const pf = pointFigure(closes([10, 13, 14, 10, 9, 13]), { box: 1, reversal: 3 })
    expect(pf.map((b) => (b.close > b.open ? 'X' : 'O'))).toEqual(['X', 'O', 'X'])
    expect(increasing(pf)).toBe(true)
  })

  it('heikin ashi averages', () => {
    const ha = heikinAshi([{ time: 1, open: 1, high: 3, low: 1, close: 3, volume: 0 }])
    expect(ha[0].close).toBe(2)
  })
})
