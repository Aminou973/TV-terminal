import { create } from 'zustand'
import {
  getAlerts,
  getPaper,
  getScripts,
  getSymbols,
  type Alert,
  type PaperAccount,
  type PaperOrder,
  type PaperPosition,
  type Script,
  type SymbolInfo,
} from './api/client'
import { stream } from './chart/stream'

// Server-backed collections shared by panels and charts. Each store refreshes
// itself on demand and on the matching live event.

interface SymbolsState {
  list: SymbolInfo[]
  refresh: () => Promise<void>
}
export const useSymbols = create<SymbolsState>((set) => ({
  list: [],
  refresh: async () => set({ list: await getSymbols() }),
}))

interface AlertsState {
  list: Alert[]
  refresh: () => Promise<void>
}
export const useAlerts = create<AlertsState>((set) => ({
  list: [],
  refresh: async () => set({ list: await getAlerts() }),
}))

interface ScriptsState {
  list: Script[]
  loaded: boolean
  refresh: () => Promise<void>
}
export const useScripts = create<ScriptsState>((set) => ({
  list: [],
  loaded: false,
  refresh: async () => set({ list: await getScripts(), loaded: true }),
}))

interface PaperState {
  account: PaperAccount | null
  positions: PaperPosition[]
  orders: PaperOrder[]
  refresh: () => Promise<void>
}
export const usePaper = create<PaperState>((set) => ({
  account: null,
  positions: [],
  orders: [],
  refresh: async () => set(await getPaper()),
}))

// ---------------------------------------------------------------- toasts ----
export interface Toast {
  id: number
  title: string
  body?: string
  tone: 'info' | 'success' | 'warn' | 'error'
}
interface ToastState {
  list: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
}
let toastSeq = 0
export const useToasts = create<ToastState>((set, get) => ({
  list: [],
  push: (t) => {
    const id = ++toastSeq
    set({ list: [...get().list, { ...t, id }].slice(-5) })
    setTimeout(() => get().dismiss(id), t.tone === 'error' ? 8000 : 5000)
  },
  dismiss: (id) => set({ list: get().list.filter((t) => t.id !== id) }),
}))

export const toast = (title: string, body?: string, tone: Toast['tone'] = 'info') =>
  useToasts.getState().push({ title, body, tone })

// ------------------------------------------------------- live user events ---
let wired = false

/** Hook live alert / paper events into the stores (once per session). */
export function wireUserEvents(): () => void {
  if (wired) return () => {}
  wired = true
  const off = stream.onUser((msg) => {
    if (msg.type === 'alert') {
      toast(`Alert: ${msg.symbol}`, msg.message, 'warn')
      notify(`Alert: ${msg.symbol}`, msg.message)
      useAlerts.getState().refresh().catch(() => {})
    } else if (msg.type === 'paper') {
      if (msg.event === 'fill') {
        const m = msg as unknown as { side: string; qty: number; symbol: string; price: number }
        toast('Order filled', `${m.side.toUpperCase()} ${m.qty} ${m.symbol} @ ${m.price}`, 'success')
      }
      usePaper.getState().refresh().catch(() => {})
    } else if (msg.type === 'broker') {
      const bad = msg.state === 'Rejected' || !!msg.error
      toast(`NinjaTrader: ${msg.state}`, msg.error || (msg.filled ? `filled ${msg.filled} @ ${msg.avg_price}` : `order ${msg.ref}`), bad ? 'error' : 'success')
    }
  })
  return () => {
    wired = false
    off()
  }
}

function notify(title: string, body: string) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body })
  } catch {
    /* notifications unavailable */
  }
}

export function requestNotifications() {
  try {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
  } catch {
    /* ignore */
  }
}
