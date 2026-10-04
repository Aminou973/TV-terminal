import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { stream } from '../chart/stream'

// ---------------------------------------------------------------- ATM -------
// "ATM strategy": default size and bracket distances used by the DOM, the
// chart's Buy/Sell buttons and the order ticket.
export interface Atm {
  qty: number
  brackets: boolean
  tpTicks: number
  slTicks: number
}

const ATM_KEY = 'ot_atm'
const loadAtm = (): Atm => {
  const d: Atm = { qty: 1, brackets: false, tpTicks: 16, slTicks: 8 }
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(ATM_KEY) ?? '{}') }
  } catch {
    return d
  }
}

export const useAtm = create<Atm & { set: (p: Partial<Atm>) => void }>((set, get) => ({
  ...loadAtm(),
  set: (p) => {
    set(p)
    const { qty, brackets, tpTicks, slTicks } = get()
    try {
      localStorage.setItem(ATM_KEY, JSON.stringify({ qty, brackets, tpTicks, slTicks }))
    } catch {
      /* private mode */
    }
  },
}))

// --------------------------------------------------------------- quotes -----
export interface LiveQuote {
  last: number | null
  bid: number | null
  ask: number | null
}

/** Live last / bid / ask for one symbol from the quote stream. */
export function useQuote(symbol: string): LiveQuote {
  const [q, setQ] = useState<LiveQuote>({ last: null, bid: null, ask: null })
  useEffect(() => {
    setQ({ last: null, bid: null, ask: null })
    let pending: LiveQuote | null = null
    const off = stream.subscribeQuotes([symbol], (m) => {
      if (m.symbol !== symbol) return
      pending = { last: m.last ?? null, bid: m.bid || null, ask: m.ask || null }
    })
    // at most ~8 renders/s however busy the feed is
    const timer = setInterval(() => {
      if (pending) {
        setQ(pending)
        pending = null
      }
    }, 125)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [symbol])
  return q
}
