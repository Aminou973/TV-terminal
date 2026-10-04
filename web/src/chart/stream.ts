import { useAuth } from '../store'
import type { BarData } from '../api/client'

// ---------------------------------------------------------------------------
// Single WebSocket connection with ref-counted (symbol, tf) subscriptions.
// Reconnects with backoff; on reconnect resubscribes everything.
// ---------------------------------------------------------------------------

export interface BarMessage {
  type: 'bar'
  symbol: string
  tf: string
  bar: BarData
  closed: boolean
}

export interface QuoteMessage {
  type: 'quote'
  symbol: string
  last: number
  bid: number
  ask: number
  ts_ms: number
}

type BarListener = (msg: BarMessage) => void
type QuoteListener = (msg: QuoteMessage) => void

class StreamManager {
  private ws: WebSocket | null = null
  private barListeners = new Map<string, Set<BarListener>>() // "symbol|tf" -> listeners
  private quoteListeners = new Map<string, Set<QuoteListener>>() // symbol -> listeners
  private retryMs = 1000
  private closing = false

  private connect(): void {
    if (this.closing) return
    const token = useAuth.getState().token
    if (!token) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/stream?token=${encodeURIComponent(token)}`)
    this.ws = ws

    ws.onopen = () => {
      this.retryMs = 1000
      this.send({ action: 'subscribe_quotes', symbols: [...this.quoteListeners.keys()] })
      for (const key of this.barListeners.keys()) {
        const [symbol, tf] = key.split('|')
        this.send({ action: 'subscribe', symbol, tf })
      }
    }
    ws.onmessage = (e) => this.dispatch(JSON.parse(e.data))
    ws.onclose = () => {
      if (this.closing) return
      setTimeout(() => this.connect(), this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, 15000)
    }
    ws.onerror = () => ws.close()
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private dispatch(msg: BarMessage | QuoteMessage): void {
    if (msg.type === 'bar') {
      this.barListeners.get(`${msg.symbol}|${msg.tf}`)?.forEach((cb) => cb(msg))
    } else if (msg.type === 'quote') {
      this.quoteListeners.get(msg.symbol)?.forEach((cb) => cb(msg))
    }
  }

  // -- public API ------------------------------------------------------------
  ensureConnected(): void {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connect()
  }

  subscribeBars(symbol: string, tf: string, cb: BarListener): () => void {
    const key = `${symbol}|${tf}`
    let set = this.barListeners.get(key)
    const first = !set || set.size === 0
    if (!set) {
      set = new Set()
      this.barListeners.set(key, set)
    }
    set.add(cb)
    this.ensureConnected()
    if (first) this.send({ action: 'subscribe', symbol, tf })
    return () => {
      const s = this.barListeners.get(key)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) {
        this.barListeners.delete(key)
        this.send({ action: 'unsubscribe', symbol, tf })
      }
    }
  }

  subscribeQuotes(symbols: string[], cb: QuoteListener): () => void {
    let added = false
    for (const sym of symbols) {
      let set = this.quoteListeners.get(sym)
      if (!set) {
        set = new Set()
        this.quoteListeners.set(sym, set)
        added = true
      }
      set.add(cb)
    }
    this.ensureConnected()
    if (added) this.send({ action: 'subscribe_quotes', symbols })
    return () => {
      for (const sym of symbols) {
        const s = this.quoteListeners.get(sym)
        if (!s) continue
        s.delete(cb)
        if (s.size === 0) this.quoteListeners.delete(sym)
      }
    }
  }

  disconnect(): void {
    this.closing = true
    this.ws?.close()
  }
}

export const stream = new StreamManager()

// re-export the Quote type for convenience
export type { Quote } from '../api/client'