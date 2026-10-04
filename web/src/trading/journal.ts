import type { PaperTrade } from '../api/client'

export interface JournalStats {
  trades: number
  wins: number
  losses: number
  winRate: number
  net: number
  grossProfit: number
  grossLoss: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  payoff: number
  expectancy: number
  largestWin: number
  largestLoss: number
  maxDrawdown: number
  maxConsecWins: number
  maxConsecLosses: number
  avgHoldMs: number
  commission: number
  /** cumulative net P&L after each closed trade, oldest first */
  equity: { t: number; v: number }[]
}

export function journalStats(all: PaperTrade[]): JournalStats {
  const closed = all.filter((t) => t.status === 'closed').sort((a, b) => (a.exit_ms ?? 0) - (b.exit_ms ?? 0))
  const wins = closed.filter((t) => t.pnl > 0)
  const losses = closed.filter((t) => t.pnl < 0)
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0)
  let cum = 0
  let peak = 0
  let maxDrawdown = 0
  let run = 0
  let maxConsecWins = 0
  let maxConsecLosses = 0
  const equity: { t: number; v: number }[] = []
  for (const t of closed) {
    cum += t.pnl
    peak = Math.max(peak, cum)
    maxDrawdown = Math.max(maxDrawdown, peak - cum)
    equity.push({ t: t.exit_ms ?? t.entry_ms, v: cum })
    if (t.pnl > 0) run = run > 0 ? run + 1 : 1
    else if (t.pnl < 0) run = run < 0 ? run - 1 : -1
    else run = 0
    maxConsecWins = Math.max(maxConsecWins, run)
    maxConsecLosses = Math.max(maxConsecLosses, -run)
  }
  const n = closed.length
  const avgWin = wins.length ? grossProfit / wins.length : 0
  const avgLoss = losses.length ? grossLoss / losses.length : 0
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? wins.length / n : 0,
    net: cum,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0,
    avgWin,
    avgLoss,
    payoff: avgLoss ? avgWin / avgLoss : 0,
    expectancy: n ? cum / n : 0,
    largestWin: wins.reduce((m, t) => Math.max(m, t.pnl), 0),
    largestLoss: losses.reduce((m, t) => Math.min(m, t.pnl), 0),
    maxDrawdown,
    maxConsecWins,
    maxConsecLosses,
    avgHoldMs: n ? closed.reduce((s, t) => s + ((t.exit_ms ?? t.entry_ms) - t.entry_ms), 0) / n : 0,
    commission: all.reduce((s, t) => s + t.commission, 0),
    equity,
  }
}

/** Net P&L and count per key (symbol, tag, weekday …) over closed trades. */
export function groupPnl(trades: PaperTrade[], key: (t: PaperTrade) => string[]): { key: string; trades: number; net: number; winRate: number }[] {
  const by = new Map<string, { trades: number; net: number; wins: number }>()
  for (const t of trades) {
    if (t.status !== 'closed') continue
    for (const k of key(t)) {
      const g = by.get(k) ?? { trades: 0, net: 0, wins: 0 }
      g.trades++
      g.net += t.pnl
      if (t.pnl > 0) g.wins++
      by.set(k, g)
    }
  }
  return [...by.entries()]
    .map(([k, g]) => ({ key: k, trades: g.trades, net: g.net, winRate: g.wins / g.trades }))
    .sort((a, b) => b.net - a.net)
}

export const tagList = (t: PaperTrade) => t.tags.split(',').map((s) => s.trim()).filter(Boolean)

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function tradesToCsv(trades: PaperTrade[]): string {
  const cols = ['id', 'symbol', 'side', 'qty', 'entry_time', 'entry_price', 'exit_time', 'exit_price', 'pnl', 'commission', 'mae', 'mfe', 'tags', 'notes'] as const
  const rows = trades.map((t) => [
    t.id, t.symbol, t.side, t.qty, new Date(t.entry_ms).toISOString(), t.entry_price,
    t.exit_ms ? new Date(t.exit_ms).toISOString() : '', t.exit_price ?? '', t.pnl.toFixed(2), t.commission.toFixed(2),
    t.mae.toFixed(2), t.mfe.toFixed(2), t.tags, t.notes,
  ])
  return [cols.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n')
}
