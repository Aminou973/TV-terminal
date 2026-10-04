import { describe, expect, it } from 'vitest'
import { runScript, ta, type Bar } from './engine'
import { TEMPLATES } from './templates'

const bars = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({ time: 1_700_000_000 + i * 60, open: c, high: c + 1, low: c - 1, close: c, volume: 10 }))

describe('ta', () => {
  it('sma / ema / rsi basics', () => {
    expect(ta.sma([1, 2, 3, 4], 2).slice(1)).toEqual([1.5, 2.5, 3.5])
    const e = ta.ema([1, 1, 1, 1, 1], 3)
    expect(e.slice(2)).toEqual([1, 1, 1])
    const up = ta.rsi(Array.from({ length: 30 }, (_, i) => i), 14)
    expect(up[29]).toBe(100)
  })
  it('crossovers', () => {
    expect(ta.crossover([1, 3], [2, 2])).toEqual([false, true])
    expect(ta.crossedDown([3, 1], 2, 1)).toBe(true)
  })
})

describe('runScript', () => {
  it('collects inputs, plots and overlay flag', () => {
    const r = runScript(`// @name T\n// @overlay false\nconst n = input('Len', 3)\nplot(ta.sma(close, n), 'MA')\nhline(1)`, bars([1, 2, 3, 4, 5]), { Len: 2 })
    expect(r.name).toBe('T')
    expect(r.overlay).toBe(false)
    expect(r.inputs).toEqual([expect.objectContaining({ id: 'Len', type: 'int', defval: 3 })])
    expect(r.plotData.plot0.map((p) => p.value)).toEqual([null, 1.5, 2.5, 3.5, 4.5])
    expect(r.hlines).toHaveLength(1)
    expect(r.strategy).toBeNull()
  })

  it('shadows host globals', () => {
    const r = runScript(`plot(close, typeof fetch + ',' + typeof self)`, bars([1]))
    expect(r.plots[0].title).toBe('undefined,undefined')
  })

  it('fills strategy orders on the next bar open and books P&L with point value', () => {
    // enter long on bar 1 → fills at bar 2 open (12); close on bar 3 → fills at bar 4 open (15)
    const src = `strategy({ initialCapital: 1000, qty: 2 })
strategy.onBar(i => { if (i === 1) strategy.entry('L', 'long'); if (i === 3) strategy.close('L') })`
    const r = runScript(src, bars([10, 11, 12, 13, 15]), {}, { pointValue: 50 })
    const s = r.strategy!
    expect(s.trades).toHaveLength(1)
    expect(s.trades[0]).toMatchObject({ entryPrice: 12, exitPrice: 15, qty: 2, pnl: (15 - 12) * 2 * 50 })
    expect(s.metrics.netProfit).toBe(300)
    expect(s.equity.at(-1)!.value).toBe(1300)
  })

  it('honours stop loss inside the bar', () => {
    const src = `strategy.onBar(i => { if (i === 0) strategy.entry('L', 'long', { sl: 9 }) })`
    const data = bars([10, 10, 10])
    data[2] = { ...data[2], low: 8 }
    const r = runScript(src, data)
    expect(r.strategy!.trades[0]).toMatchObject({ exitPrice: 9, exitReason: 'stop loss' })
  })

  it('every template runs', () => {
    const data = bars(Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 9) * 8 + i * 0.02))
    for (const t of TEMPLATES) {
      const r = runScript(t.source, data)
      expect(r.kind, t.name).toBe(t.kind)
      expect(r.plots.length + (r.strategy ? 1 : 0), t.name).toBeGreaterThan(0)
    }
  })
})
