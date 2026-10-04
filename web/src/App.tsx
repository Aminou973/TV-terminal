import { useEffect, useState } from 'react'
import { getSymbols, type SymbolInfo } from './api/client'
import { stream } from './chart/stream'
import ChartView from './chart/ChartView'
import LoginView from './auth/LoginView'
import { useAuth, useTerminal, type Tf } from './store'

const TFS: Tf[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1D']

function Terminal() {
  const username = useAuth((s) => s.username)
  const logout = useAuth((s) => s.logout)
  const symbol = useTerminal((s) => s.symbol)
  const tf = useTerminal((s) => s.tf)
  const setSymbol = useTerminal((s) => s.setSymbol)
  const setTf = useTerminal((s) => s.setTf)

  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [prices, setPrices] = useState<Record<string, number>>({})

  useEffect(() => {
    getSymbols().then(setSymbols).catch(() => {})
  }, [])

  useEffect(() => {
    if (symbols.length === 0) return
    const off = stream.subscribeQuotes(
      symbols.map((s) => s.symbol),
      (q) => setPrices((p) => ({ ...p, [q.symbol]: q.last })),
    )
    return off
  }, [symbols])

  return (
    <div className="terminal">
      <header className="topbar">
        <span className="logo">OpenTerminal</span>
        <span className="symbol-p">{symbol}</span>
        <nav className="tfs">
          {TFS.map((t) => (
            <button key={t} className={t === tf ? 'active' : ''} onClick={() => setTf(t)}>
              {t}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="user">{username}</span>
        <button className="link" onClick={logout}>
          Sign out
        </button>
      </header>
      <div className="body">
        <aside className="watchlist">
          <h3>Symbols</h3>
          {symbols.map((s) => (
            <button
              key={s.symbol}
              className={`sym ${s.symbol === symbol ? 'active' : ''}`}
              onClick={() => setSymbol(s.symbol)}
            >
              <span>{s.symbol}</span>
              <span className="px">{prices[s.symbol] != null ? prices[s.symbol].toFixed(2) : '—'}</span>
            </button>
          ))}
          {symbols.length === 0 && <p className="muted">waiting for data…</p>}
        </aside>
        <main className="chart-area">
          <ChartView />
        </main>
      </div>
    </div>
  )
}

export default function App() {
  const token = useAuth((s) => s.token)
  return token ? <Terminal /> : <LoginView />
}