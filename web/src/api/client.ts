import { useAuth } from '../store'

const API = '/api'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const token = useAuth.getState().token
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  if (res.status === 401) {
    useAuth.getState().logout()
    throw new ApiError(401, 'Not authenticated')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown }
    const detail = typeof body.detail === 'string' ? body.detail : res.statusText
    throw new ApiError(res.status, detail)
  }
  return (await res.json()) as T
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
})
const enc = encodeURIComponent

// ------------------------------------------------------------------ types ----
export interface BarData {
  time: number // unix seconds (bucket start)
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface HistoryResponse {
  symbol: string
  tf: string
  bars: BarData[]
}

export interface SymbolInfo {
  symbol: string
  market: string
}

export interface Quote {
  symbol: string
  last: number
  bid?: number
  ask?: number
  ts_ms?: number
}

export interface Stats {
  symbol: string
  last: number
  open: number
  high: number
  low: number
  volume: number
  prev_close: number
  change: number
  change_pct: number
}

export interface ScreenerRow {
  symbol: string
  market: string
  last: number
  change: number
  change_pct: number
  volume: number
  high: number
  low: number
  rsi14: number | null
  sma20: number | null
  sma50: number | null
  above_sma20: boolean
  above_sma50: boolean
  atr_pct: number | null
  bars: number
}

export interface Watchlist {
  id: number
  name: string
  symbols: string[]
}

export interface Layout<S = unknown> {
  id: number
  name: string
  spec: S
}

export interface Script {
  id: number
  name: string
  kind: 'indicator' | 'strategy'
  source: string
  updated_at: string
}

export type AlertCondition = 'crossing' | 'crossing_up' | 'crossing_down' | 'greater' | 'less'

export interface Alert {
  id: number
  symbol: string
  condition: AlertCondition
  price: number
  message: string
  once: number
  active: number
  created_at: string
  triggered_at: string | null
}

export interface AlertLogEntry {
  id: number
  alert_id: number
  symbol: string
  price: number
  message: string
  ts_ms: number
}

export interface PaperAccount {
  starting_balance: number
  realized_pnl: number
  balance: number
  unrealized_pnl: number
  equity: number
}

export interface PaperPosition {
  symbol: string
  qty: number
  avg_price: number
  last: number
  point_value: number
  unrealized_pnl: number
}

export interface PaperOrder {
  id: number
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'stop'
  qty: number
  price: number | null
  status: 'working' | 'filled' | 'cancelled' | 'rejected'
  fill_price: number | null
  created_ms: number
  filled_ms: number | null
}

// ---------------------------------------------------------------- market ----
export const getHistory = (symbol: string, tf: string, opts: { limit?: number; to?: number } = {}) => {
  const q = new URLSearchParams({ symbol, tf })
  if (opts.limit) q.set('limit', String(opts.limit))
  if (opts.to != null) q.set('to', String(opts.to))
  return api<HistoryResponse>(`/history?${q}`)
}

export const getSymbols = () => api<SymbolInfo[]>('/symbols')

export const getQuote = (symbols: string[]) =>
  api<{ quotes: Quote[] }>(`/quote?symbols=${symbols.map(enc).join(',')}`)

export const getStats = (symbols: string[]) =>
  api<{ stats: Stats[] }>(`/stats?symbols=${symbols.map(enc).join(',')}`)

export const getScreener = (tf: string) => api<{ tf: string; rows: ScreenerRow[] }>(`/screener?tf=${enc(tf)}`)

export const getHealth = () =>
  api<{ status: string; providers?: Record<string, string>; symbols?: number }>('/health')

// ------------------------------------------------------------- workspace ----
export const getWatchlists = () => api<Watchlist[]>('/watchlists')
export const saveWatchlist = (name: string, symbols: string[]) =>
  api<Watchlist>('/watchlists', json('PUT', { name, symbols }))

export const getLayouts = <S>() => api<Layout<S>[]>('/layouts')
export const saveLayout = <S>(name: string, spec: S) => api<Layout<S>>('/layouts', json('PUT', { name, spec }))
export const deleteLayout = (id: number) => api(`/layouts/${id}`, json('DELETE'))

export const getDrawings = (symbol: string) => api<{ data: unknown[] }>(`/drawings/${enc(symbol)}`)
export const saveDrawings = (symbol: string, data: unknown[]) =>
  api(`/drawings/${enc(symbol)}`, json('PUT', { data }))

export const getScripts = () => api<Script[]>('/scripts')
export const saveScript = (name: string, kind: Script['kind'], source: string) =>
  api<Script>('/scripts', json('PUT', { name, kind, source }))
export const deleteScript = (id: number) => api(`/scripts/${id}`, json('DELETE'))

// ---------------------------------------------------------------- alerts ----
export const getAlerts = () => api<Alert[]>('/alerts')
export const createAlert = (a: { symbol: string; condition: AlertCondition; price: number; message?: string; once?: boolean }) =>
  api<Alert>('/alerts', json('POST', a))
export const setAlertActive = (id: number, active: boolean) => api<Alert>(`/alerts/${id}?active=${active}`, json('PATCH'))
export const deleteAlert = (id: number) => api(`/alerts/${id}`, json('DELETE'))
export const getAlertLog = () => api<AlertLogEntry[]>('/alerts/log')

// ----------------------------------------------------------------- paper ----
export const getPaper = () =>
  api<{ account: PaperAccount; positions: PaperPosition[]; orders: PaperOrder[] }>('/paper/account')
export const placeOrder = (o: { symbol: string; side: 'buy' | 'sell'; type: PaperOrder['type']; qty: number; price?: number }) =>
  api<PaperOrder>('/paper/orders', json('POST', o))
export const cancelOrder = (id: number) => api(`/paper/orders/${id}`, json('DELETE'))
export const closePosition = (symbol: string) => api<PaperOrder>(`/paper/positions/${enc(symbol)}/close`, json('POST'))
export const resetPaper = () => api<PaperAccount>('/paper/reset', json('POST'))

// ------------------------------------------------------------------- auth ----
export interface AuthResponse {
  access_token: string
  username: string
  role: string
}

export const postRegister = (username: string, password: string) =>
  api<AuthResponse>('/auth/register', json('POST', { username, password }))

export const postLogin = (username: string, password: string) => {
  const body = new URLSearchParams({ username, password })
  return fetch(`${API}/auth/login`, { method: 'POST', body }).then(async (res) => {
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { detail?: string }
      throw new ApiError(res.status, err.detail ?? 'Invalid credentials')
    }
    return (await res.json()) as AuthResponse
  })
}
