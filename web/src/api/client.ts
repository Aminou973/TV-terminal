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
    const body = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new ApiError(res.status, body.detail ?? res.statusText)
  }
  return (await res.json()) as T
}

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

export const getHistory = (symbol: string, tf: string) =>
  api<HistoryResponse>(
    `/history?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`,
  )

export const getSymbols = () => api<SymbolInfo[]>('/symbols')

export const getQuote = (symbols: string[]) =>
  api<{ quotes: Quote[] }>(`/quote?symbols=${symbols.map(encodeURIComponent).join(',')}`)

// ------------------------------------------------------------------- auth ----
export interface AuthResponse {
  access_token: string
  username: string
  role: string
}

export const postRegister = (username: string, password: string) =>
  api<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })

export const postLogin = (username: string, password: string) => {
  const body = new URLSearchParams({ username, password })
  return fetch(`${API}/auth/login`, { method: 'POST', body })
    .then(async (res) => {
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new ApiError(res.status, err.detail ?? 'Invalid credentials')
      }
      return (await res.json()) as AuthResponse
    })
}