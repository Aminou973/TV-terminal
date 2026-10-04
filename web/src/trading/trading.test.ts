import { describe, expect, it } from 'vitest'
import type { PaperTrade } from '../api/client'
import { tickSize } from '../markets'
import { formatDuration, groupPnl, journalStats, tradesToCsv } from './journal'
import { bracketPrices, ladderOrderType, pnl, riskQty, roundToTick, tickDigits } from './math'

describe('order math', () => {
  it('snaps to the tick grid', () => {
    expect(roundToTick(5000.13, 0.25)).toBe(5000.25)
    expect(roundToTick(1.08437, 0.0001)).toBe(1.0844)
    expect(roundToTick(110.1, 1 / 64)).toBeCloseTo(110.09375)
    expect(tickDigits(0.25)).toBe(2)
    expect(tickDigits(1 / 64)).toBe(6)
    expect(tickDigits(1)).toBe(0)
  })
  it('knows tick sizes', () => {
    expect(tickSize('SIM:ES')).toBe(0.25)
    expect(tickSize('NQ=F')).toBe(0.25)
    expect(tickSize('AAPL', 190)).toBe(0.01)
    expect(tickSize('EURUSD=X', 1.08)).toBe(0.0001)
  })
  it('puts brackets on the right side', () => {
    expect(bracketPrices('buy', 5000, 0.25, 8, 4)).toEqual({ tp: 5002, sl: 4999 })
    expect(bracketPrices('sell', 5000, 0.25, 8, 0)).toEqual({ tp: 4998, sl: undefined })
  })
  it('computes P&L and risk-based size', () => {
    expect(pnl('buy', 5000, 5010, 2, 50)).toBe(1000)
    expect(pnl('sell', 5000, 5010, 1, 50)).toBe(-500)
    // 1% of 100k = 1000 risk; 4 pts × $50 = 200 per contract → 5
    expect(riskQty(100_000, 1, 5000, 4996, 50)).toBe(5)
    expect(riskQty(100_000, 1, 5000, 5000, 50)).toBe(0)
  })
  it('picks limit vs stop on a ladder', () => {
    expect(ladderOrderType('buy', 4999, 5000)).toBe('limit')
    expect(ladderOrderType('buy', 5001, 5000)).toBe('stop')
    expect(ladderOrderType('sell', 5001, 5000)).toBe('limit')
    expect(ladderOrderType('sell', 4999, 5000)).toBe('stop')
  })
})

const trade = (id: number, pnl: number, exitMin: number, extra: Partial<PaperTrade> = {}): PaperTrade => ({
  id, symbol: 'ES', side: 'long', qty: 1, entry_price: 5000, exit_price: 5000 + pnl / 50, exit_qty: 1,
  entry_ms: (exitMin - 1) * 60_000, exit_ms: exitMin * 60_000, pnl, commission: 2, high: 5010, low: 4990,
  mfe: 0, mae: 0, point_value: 50, status: 'closed', notes: '', tags: '', ...extra,
})

describe('journal stats', () => {
  const ts = [trade(1, 100, 1), trade(2, 200, 2), trade(3, -150, 3), trade(4, -50, 4), trade(5, 300, 5), trade(6, 0, 6, { status: 'open', exit_ms: null })]
  const s = journalStats(ts)
  it('summarises closed trades only', () => {
    expect(s.trades).toBe(5)
    expect(s.wins).toBe(3)
    expect(s.losses).toBe(2)
    expect(s.winRate).toBeCloseTo(0.6)
    expect(s.net).toBe(400)
    expect(s.profitFactor).toBeCloseTo(600 / 200)
    expect(s.avgWin).toBe(200)
    expect(s.avgLoss).toBe(100)
    expect(s.payoff).toBe(2)
    expect(s.expectancy).toBe(80)
    expect(s.largestWin).toBe(300)
    expect(s.largestLoss).toBe(-150)
    expect(s.commission).toBe(12)
    expect(s.avgHoldMs).toBe(60_000)
  })
  it('tracks drawdown, streaks and the equity curve', () => {
    expect(s.maxDrawdown).toBe(200) // peak 300 → 100
    expect(s.maxConsecWins).toBe(2)
    expect(s.maxConsecLosses).toBe(2)
    expect(s.equity.map((p) => p.v)).toEqual([100, 300, 150, 100, 400])
  })
  it('groups by key and exports CSV', () => {
    const tagged = [trade(1, 100, 1, { tags: 'a, b' }), trade(2, -40, 2, { tags: 'b' })]
    expect(groupPnl(tagged, (t) => t.tags.split(',').map((x) => x.trim()))).toEqual([
      { key: 'a', trades: 1, net: 100, winRate: 1 },
      { key: 'b', trades: 2, net: 60, winRate: 0.5 },
    ])
    const csv = tradesToCsv([trade(1, 100, 1, { notes: 'said "hi", left' })])
    expect(csv.split('\n')[0]).toMatch(/^id,symbol,side/)
    expect(csv).toContain('"said ""hi"", left"')
  })
  it('handles empty input and durations', () => {
    expect(journalStats([]).profitFactor).toBe(0)
    expect(formatDuration(59_000)).toBe('59s')
    expect(formatDuration(3_725_000)).toBe('1h 2m')
  })
})
