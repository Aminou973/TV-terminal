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
export type AlertKind = 'price' | 'line' | 'indicator' | 'script'
export type AlertFrequency = 'once' | 'once_per_bar' | 'once_per_bar_close' | 'once_per_minute' | 'every_time'

/** {"ind": "rsi", "length": 14, "output": "value"} or {"value": 70} */
export type SeriesSpec = Record<string, string | number>

export interface AlertNotify {
  webhook?: string | boolean
  telegram?: boolean
  email?: boolean
}

export interface Alert {
  id: number
  symbol: string
  kind: AlertKind
  condition: AlertCondition
  price: number
  params: Record<string, unknown>
  tf: string
  frequency: AlertFrequency
  expires_ms: number | null
  notify: AlertNotify
  message: string
  once: number
  active: number
  created_at: string
  triggered_at: string | null
  error: string | null
}

export interface AlertIn {
  symbol: string
  kind?: AlertKind
  condition: AlertCondition
  price?: number
  params?: Record<string, unknown>
  tf?: string
  frequency?: AlertFrequency
  expires_ms?: number | null
  message?: string
  notify?: AlertNotify
}

export interface AlertCatalog {
  indicators: { id: string; label: string; outputs: string[]; params: Record<string, string | number> }[]
  email_available: boolean
  telegram_default_bot: boolean
}

export interface NotifySettings {
  webhook_url: string
  telegram_bot_token: string
  telegram_chat_id: string
  email: string
}

export interface AlertLogEntry {
  id: number
  alert_id: number
  symbol: string
  price: number
  message: string
  ts_ms: number
  delivery: string
}

export interface PaperAccount {
  starting_balance: number
  realized_pnl: number
  commission: number
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
  tp: number | null
  sl: number | null
}

export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop'

export interface PaperOrder {
  id: number
  symbol: string
  side: 'buy' | 'sell'
  type: OrderType
  qty: number
  price: number | null
  stop_price: number | null
  trail: number | null
  trail_ref: number | null
  triggered: number
  parent_id: number | null
  oco: string | null
  reduce_only: number
  tag: '' | 'entry' | 'tp' | 'sl' | 'close' | 'reverse'
  tp: number | null
  sl: number | null
  reason: string | null
  status: 'working' | 'filled' | 'cancelled' | 'rejected'
  fill_price: number | null
  created_ms: number
  filled_ms: number | null
}

export interface OrderIn {
  symbol: string
  side: 'buy' | 'sell'
  type: OrderType
  qty: number
  price?: number
  stop_price?: number
  trail?: number
  tp?: number
  sl?: number
  reduce_only?: boolean
}

export interface OrderModify {
  price?: number
  qty?: number
  stop_price?: number
  trail?: number
  tp?: number
  sl?: number
  clear_tp?: boolean
  clear_sl?: boolean
}

export interface PaperTrade {
  id: number
  symbol: string
  side: 'long' | 'short'
  qty: number
  entry_price: number
  exit_price: number | null
  exit_qty: number
  entry_ms: number
  exit_ms: number | null
  pnl: number
  commission: number
  high: number
  low: number
  mfe: number
  mae: number
  point_value: number
  status: 'open' | 'closed'
  notes: string
  tags: string
}

export interface Instrument {
  symbol: string
  point_value: number
  tick_size: number
  last: number | null
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

export interface Template<S = unknown> {
  id: number
  kind: 'indicators' | 'chart' | 'drawing'
  name: string
  spec: S
}
export const getTemplates = <S>(kind: Template['kind']) => api<Template<S>[]>(`/templates?kind=${kind}`)
export const saveTemplate = <S>(kind: Template['kind'], name: string, spec: S) =>
  api<Template<S>>('/templates', json('PUT', { kind, name, spec }))
export const deleteTemplate = (id: number) => api(`/templates/${id}`, json('DELETE'))

// ---------------------------------------------------------------- alerts ----
export const getAlerts = () => api<Alert[]>('/alerts')
export const createAlert = (a: AlertIn) => api<Alert>('/alerts', json('POST', a))
export const updateAlert = (id: number, a: AlertIn) => api<Alert>(`/alerts/${id}`, json('PUT', a))
export const getAlertCatalog = () => api<AlertCatalog>('/alerts/catalog')
export const getNotifySettings = () => api<NotifySettings>('/alerts/settings')
export const saveNotifySettings = (s: NotifySettings) => api<NotifySettings>('/alerts/settings', json('PUT', s))
export const testNotify = (n: AlertNotify) => api<{ status: string }>('/alerts/test', json('POST', n))
export const setAlertActive = (id: number, active: boolean) => api<Alert>(`/alerts/${id}?active=${active}`, json('PATCH'))
export const deleteAlert = (id: number) => api(`/alerts/${id}`, json('DELETE'))
export const getAlertLog = () => api<AlertLogEntry[]>('/alerts/log')

// ----------------------------------------------------------------- paper ----
export const getPaper = () =>
  api<{ account: PaperAccount; positions: PaperPosition[]; orders: PaperOrder[] }>('/paper/account')
export const placeOrder = (o: OrderIn) => api<PaperOrder>('/paper/orders', json('POST', o))
export const modifyOrder = (id: number, m: OrderModify) => api<PaperOrder>(`/paper/orders/${id}`, json('PATCH', m))
export const cancelOrder = (id: number) => api(`/paper/orders/${id}`, json('DELETE'))
export const cancelAllOrders = (symbol?: string) =>
  api<{ cancelled: number }>(`/paper/orders${symbol ? `?symbol=${enc(symbol)}` : ''}`, json('DELETE'))
export const closePosition = (symbol: string) => api<PaperOrder>(`/paper/positions/${enc(symbol)}/close`, json('POST'))
export const reversePosition = (symbol: string) => api<PaperOrder>(`/paper/positions/${enc(symbol)}/reverse`, json('POST'))
export const setPositionBrackets = (symbol: string, b: { tp?: number | null; sl?: number | null }) =>
  api<PaperOrder[]>(`/paper/positions/${enc(symbol)}/brackets`, json('PUT', b))
export const flattenAll = () => api<{ cancelled: number; closed: number }>('/paper/flatten', json('POST'))
export const savePaperSettings = (s: { starting_balance?: number; commission?: number }) =>
  api<PaperAccount>('/paper/settings', json('PUT', s))
export const getInstrument = (symbol: string) => api<Instrument>(`/paper/instrument?symbol=${enc(symbol)}`)
export const getTrades = (symbol?: string) => api<PaperTrade[]>(`/paper/trades${symbol ? `?symbol=${enc(symbol)}` : ''}`)
export const annotateTrade = (id: number, n: { notes?: string; tags?: string }) => api<PaperTrade>(`/paper/trades/${id}`, json('PATCH', n))
export const resetPaper = () => api<PaperAccount>('/paper/reset', json('POST'))

// ---------------------------------------------------- NinjaTrader route ----
export interface NinjaStatus {
  enabled: boolean
  connected: boolean
  account: string
  contracts: Record<string, string>
  can_trade: boolean
}
export const getNinjaStatus = () => api<NinjaStatus>('/broker/ninja/status')
export const placeNinjaOrder = (o: { symbol: string; side: 'buy' | 'sell'; type: 'market' | 'limit' | 'stop'; qty: number; price?: number }) =>
  api<{ ref: string; status: string; contract: string; account: string }>('/broker/ninja/orders', json('POST', o))

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
