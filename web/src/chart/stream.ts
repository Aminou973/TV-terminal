import { useAuth } from '../store'
import type { BarData } from '../api/client'

// ---------------------------------------------------------------------------
// Single WebSocket connection with ref-counted subscriptions (bars per
// symbol|tf, quotes, trades and books per symbol) plus per-user events.
// Reconnects with backoff and resubscribes everything; an auth rejection
// (4401, e.g. an expired token) signs the user out instead of looping.
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

export interface TradeMessage {
  type: 'trade'
  symbol: string
  price: number
  size: number
  side: 'buy' | 'sell' | ''
  ts_ms: number
}

export interface BookMessage {
  type: 'book'
  symbol: string
  bids: [number, number][]
  asks: [number, number][]
  ts_ms: number
}

export interface AlertMessage {
  type: 'alert'
  id: number
  symbol: string
  price: number
  message: string
  ts_ms: number
}

export interface PaperMessage {
  type: 'paper'
  event: 'order' | 'fill' | 'cancel' | 'reset'
  [k: string]: unknown
}

export interface BrokerMessage {
  type: 'broker'
  broker: 'ninja'
  ref: string
  order_id?: string
  state: string
  filled?: number
  avg_price?: number
  error?: string
}

export type UserMessage = AlertMessage | PaperMessage | BrokerMessage
type Message = BarMessage | QuoteMessage | TradeMessage | BookMessage | UserMessage

type Listener<T> = (msg: T) => void

class Channel<T> {
  // key -> listeners
  readonly map = new Map<string, Set<Listener<T>>>()

  /** Returns true when this is the first listener for the key. */
  add(key: string, cb: Listener<T>): boolean {
    let set = this.map.get(key)
    const first = !set || set.size === 0
    if (!set) {
      set = new Set()
      this.map.set(key, set)
    }
    set.add(cb)
    return first
  }

  /** Returns true when the key has no listeners left. */
  remove(key: string, cb: Listener<T>): boolean {
    const set = this.map.get(key)
    if (!set) return false
    set.delete(cb)
    if (set.size === 0) {
      this.map.delete(key)
      return true
    }
    return false
  }

  emit(key: string, msg: T): void {
    this.map.get(key)?.forEach((cb) => cb(msg))
  }
}

class StreamManager {
  private ws: WebSocket | null = null
  private token: string | null = null
  private retryMs = 1000
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private bars = new Channel<BarMessage>()
  private quotes = new Channel<QuoteMessage>()
  private trades = new Channel<TradeMessage>()
  private books = new Channel<BookMessage>()
  private user = new Set<Listener<UserMessage>>()
  private status = new Set<Listener<boolean>>()
  connected = false

  private connect(): void {
    this.retryTimer = null
    const token = useAuth.getState().token
    if (!token) return
    this.token = token
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/stream?token=${encodeURIComponent(token)}`)
    this.ws = ws

    ws.onopen = () => {
      this.retryMs = 1000
      this.setConnected(true)
      if (this.quotes.map.size) this.send({ action: 'subscribe_quotes', symbols: [...this.quotes.map.keys()] })
      for (const key of this.bars.map.keys()) {
        const [symbol, tf] = splitKey(key)
        this.send({ action: 'subscribe', symbol, tf })
      }
      for (const s of this.trades.map.keys()) this.send({ action: 'subscribe_trades', symbol: s })
      for (const s of this.books.map.keys()) this.send({ action: 'subscribe_book', symbol: s })
    }
    ws.onmessage = (e) => {
      try {
        this.dispatch(JSON.parse(e.data) as Message)
      } catch (err) {
        console.error('bad stream message', err)
      }
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return // superseded by a reconnect
      this.ws = null
      this.setConnected(false)
      if (e.code === 4401) {
        useAuth.getState().logout()
        return
      }
      if (!useAuth.getState().token) return
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, 15000)
    }
    ws.onerror = () => ws.close()
  }

  private setConnected(v: boolean) {
    this.connected = v
    this.status.forEach((cb) => cb(v))
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private dispatch(msg: Message): void {
    switch (msg.type) {
      case 'bar':
        this.bars.emit(`${msg.symbol}|${msg.tf}`, msg)
        break
      case 'quote':
        this.quotes.emit(msg.symbol, msg)
        break
      case 'trade':
        this.trades.emit(msg.symbol, msg)
        break
      case 'book':
        this.books.emit(msg.symbol, msg)
        break
      case 'alert':
      case 'paper':
      case 'broker':
        this.user.forEach((cb) => cb(msg))
        break
    }
  }

  // -- public API ------------------------------------------------------------
  ensureConnected(): void {
    const token = useAuth.getState().token
    if (this.ws && token !== this.token) this.disconnect() // signed in as someone else
    if (!this.ws && !this.retryTimer) this.connect()
  }

  disconnect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const ws = this.ws
    this.ws = null
    ws?.close()
    this.setConnected(false)
  }

  subscribeBars(symbol: string, tf: string, cb: Listener<BarMessage>): () => void {
    const key = `${symbol}|${tf}`
    this.ensureConnected()
    if (this.bars.add(key, cb)) this.send({ action: 'subscribe', symbol, tf })
    return () => {
      if (this.bars.remove(key, cb)) this.send({ action: 'unsubscribe', symbol, tf })
    }
  }

  subscribeQuotes(symbols: string[], cb: Listener<QuoteMessage>): () => void {
    this.ensureConnected()
    const added = symbols.filter((s) => this.quotes.add(s, cb))
    if (added.length) this.send({ action: 'subscribe_quotes', symbols: added })
    return () => {
      const gone = symbols.filter((s) => this.quotes.remove(s, cb))
      if (gone.length) this.send({ action: 'unsubscribe_quotes', symbols: gone })
    }
  }

  subscribeTrades(symbol: string, cb: Listener<TradeMessage>): () => void {
    this.ensureConnected()
    if (this.trades.add(symbol, cb)) this.send({ action: 'subscribe_trades', symbol })
    return () => {
      if (this.trades.remove(symbol, cb)) this.send({ action: 'unsubscribe_trades', symbol })
    }
  }

  subscribeBook(symbol: string, cb: Listener<BookMessage>): () => void {
    this.ensureConnected()
    if (this.books.add(symbol, cb)) this.send({ action: 'subscribe_book', symbol })
    return () => {
      if (this.books.remove(symbol, cb)) this.send({ action: 'unsubscribe_book', symbol })
    }
  }

  onUser(cb: Listener<UserMessage>): () => void {
    this.ensureConnected()
    this.user.add(cb)
    return () => this.user.delete(cb)
  }

  onStatus(cb: Listener<boolean>): () => void {
    this.status.add(cb)
    cb(this.connected)
    return () => this.status.delete(cb)
  }
}

// symbols may contain '|'-free names only; tf never contains '|'
function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf('|')
  return [key.slice(0, i), key.slice(i + 1)]
}

export const stream = new StreamManager()

// sign-out tears the socket down so the next user gets a fresh connection
useAuth.subscribe((s, prev) => {
  if (!s.token && prev.token) stream.disconnect()
})

export type { Quote } from '../api/client'
