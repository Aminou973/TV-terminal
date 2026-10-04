import { create } from 'zustand'

// ------------------------------------------------------------------ auth -----
interface AuthState {
  token: string | null
  username: string | null
  login: (token: string, username: string) => void
  logout: () => void
}

export const useAuth = create<AuthState>((set) => ({
  token: localStorage.getItem('ot_token'),
  username: localStorage.getItem('ot_username'),
  login: (token, username) => {
    localStorage.setItem('ot_token', token)
    localStorage.setItem('ot_username', username)
    set({ token, username })
  },
  logout: () => {
    localStorage.removeItem('ot_token')
    localStorage.removeItem('ot_username')
    set({ token: null, username: null })
  },
}))

// ---------------------------------------------------------------- terminal ---
export type Tf = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D'

interface TerminalState {
  symbol: string
  tf: Tf
  setSymbol: (symbol: string) => void
  setTf: (tf: Tf) => void
}

export const useTerminal = create<TerminalState>((set) => ({
  symbol: 'SIM:ES',
  tf: '1m',
  setSymbol: (symbol) => set({ symbol }),
  setTf: (tf) => set({ tf }),
}))