import { useEffect, useMemo, useState } from 'react'
import { getStats, getWatchlists, saveWatchlist, type Stats, type Watchlist as WL } from '../api/client'
import { stream } from '../chart/stream'
import { toast, useSymbols } from '../data'
import { Icon } from '../icons'
import { useTerminal } from '../store'

const fmt = (v: number | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d))
const digits = (v: number) => (Math.abs(v) < 1 ? 5 : Math.abs(v) < 10 ? 4 : 2)

export default function Watchlist() {
  const symbols = useSymbols((s) => s.list)
  const activeSymbol = useTerminal((s) => s.panes[s.active].symbol)
  const setSymbol = useTerminal((s) => s.setSymbol)
  const [lists, setLists] = useState<WL[]>([])
  const [current, setCurrent] = useState<string>('Main')
  const [last, setLast] = useState<Record<string, number>>({})
  const [stats, setStats] = useState<Record<string, Stats>>({})
  const [adding, setAdding] = useState('')
  const [sort, setSort] = useState<'none' | 'chg' | 'sym'>('none')

  // load lists; seed "Main" with everything the server streams
  useEffect(() => {
    getWatchlists()
      .then(async (ls) => {
        if (ls.length === 0) {
          const seed = useSymbols.getState().list.map((s) => s.symbol)
          ls = [await saveWatchlist('Main', seed)]
        }
        setLists(ls)
        setCurrent((c) => (ls.some((l) => l.name === c) ? c : ls[0].name))
      })
      .catch(() => {})
  }, [symbols.length > 0])

  const list = lists.find((l) => l.name === current)
  const syms = list?.symbols ?? []
  const key = syms.join(',')

  useEffect(() => {
    if (!syms.length) return
    const off = stream.subscribeQuotes(syms, (q) => setLast((m) => ({ ...m, [q.symbol]: q.last })))
    const load = () =>
      getStats(syms)
        .then(({ stats }) => setStats(Object.fromEntries(stats.map((s) => [s.symbol, s]))))
        .catch(() => {})
    load()
    const timer = setInterval(load, 30_000)
    return () => {
      off()
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const persist = async (name: string, next: string[]) => {
    const saved = await saveWatchlist(name, next)
    setLists((ls) => (ls.some((l) => l.name === name) ? ls.map((l) => (l.name === name ? saved : l)) : [...ls, saved]))
  }

  const add = async (sym: string) => {
    const s = sym.trim()
    if (!s || syms.includes(s)) return
    await persist(current, [...syms, s]).catch((e) => toast('Could not add', String(e.message), 'error'))
    setAdding('')
  }

  const rows = useMemo(() => {
    const r = syms.map((s) => {
      const st = stats[s]
      const px = last[s] ?? st?.last
      const chg = px != null && st ? px - st.prev_close : undefined
      const pct = chg != null && st?.prev_close ? (chg / st.prev_close) * 100 : undefined
      return { s, px, chg, pct }
    })
    if (sort === 'chg') r.sort((a, b) => (b.pct ?? -1e9) - (a.pct ?? -1e9))
    if (sort === 'sym') r.sort((a, b) => a.s.localeCompare(b.s))
    return r
  }, [syms, stats, last, sort])

  return (
    <div className="panel watchlist">
      <div className="panel-head">
        <select value={current} onChange={(e) => setCurrent(e.target.value)}>
          {lists.map((l) => (
            <option key={l.id}>{l.name}</option>
          ))}
        </select>
        <button
          className="icon-btn"
          title="New list"
          onClick={() => {
            const name = window.prompt('New watchlist name')
            if (name) persist(name, []).then(() => setCurrent(name)).catch((e) => toast('Failed', String(e.message), 'error'))
          }}
        >
          <Icon.plus />
        </button>
      </div>
      <div className="wl-row wl-head">
        <span onClick={() => setSort(sort === 'sym' ? 'none' : 'sym')}>Symbol</span>
        <span>Last</span>
        <span onClick={() => setSort(sort === 'chg' ? 'none' : 'chg')}>Chg%</span>
      </div>
      <div className="wl-body">
        {rows.map(({ s, px, chg, pct }) => (
          <div key={s} className={`wl-row ${s === activeSymbol ? 'on' : ''}`} onClick={() => setSymbol(s)}>
            <span className="wl-sym">{s}</span>
            <span className="num">{px != null ? fmt(px, digits(px)) : '—'}</span>
            <span className={`num ${(chg ?? 0) >= 0 ? 'up' : 'down'}`}>
              {pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
            </span>
            <button
              className="wl-del"
              title="Remove"
              onClick={(e) => {
                e.stopPropagation()
                persist(current, syms.filter((x) => x !== s)).catch(() => {})
              }}
            >
              ×
            </button>
          </div>
        ))}
        {rows.length === 0 && <p className="muted pad">Empty list — add a symbol below.</p>}
      </div>
      <form
        className="wl-add"
        onSubmit={(e) => {
          e.preventDefault()
          void add(adding)
        }}
      >
        <input list="ot-symbols" placeholder="Add symbol…" value={adding} onChange={(e) => setAdding(e.target.value)} />
        <datalist id="ot-symbols">
          {symbols.map((s) => (
            <option key={s.symbol} value={s.symbol} />
          ))}
        </datalist>
      </form>
    </div>
  )
}
