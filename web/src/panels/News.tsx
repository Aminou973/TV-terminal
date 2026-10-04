import { useEffect, useState } from 'react'
import { getNews, type MarketSource, type NewsItem } from '../api/client'
import { timeAgo } from '../market/format'
import { useTerminal } from '../store'

export function SourceBadge({ source }: { source: MarketSource | null | undefined }) {
  if (source !== 'demo') return null
  return (
    <span className="source-badge" title="Live sources (Yahoo Finance / Forex Factory) are off or unreachable from the server, so demo data is shown.">
      demo data
    </span>
  )
}

export default function News() {
  const symbol = useTerminal((s) => s.panes[s.active].symbol)
  const [scope, setScope] = useState<'symbol' | 'market'>('symbol')
  const [items, setItems] = useState<NewsItem[] | null>(null)
  const [source, setSource] = useState<MarketSource | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setItems(null)
    setError(null)
    const load = () =>
      getNews(scope === 'symbol' ? symbol : undefined)
        .then((r) => { if (alive) { setItems(r.items); setSource(r.source) } })
        .catch((e) => alive && setError(String(e.message)))
    load()
    const timer = setInterval(load, 5 * 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [symbol, scope])

  return (
    <div className="panel news">
      <div className="panel-head">
        <div className="seg">
          <button className={scope === 'symbol' ? 'on' : ''} onClick={() => setScope('symbol')}>{symbol}</button>
          <button className={scope === 'market' ? 'on' : ''} onClick={() => setScope('market')}>Market</button>
        </div>
        <span className="spacer" />
        <SourceBadge source={source} />
      </div>
      <div className="list">
        {error && <p className="muted pad">Couldn't load news: {error}</p>}
        {!error && items == null && <p className="muted pad">Loading…</p>}
        {items?.length === 0 && <p className="muted pad">No recent headlines.</p>}
        {items?.map((n) => (
          <a key={n.id} className="news-item" href={n.url} target="_blank" rel="noopener noreferrer">
            {n.thumbnail && <img src={n.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />}
            <div>
              <div className="news-title">{n.title}</div>
              {n.summary && <div className="news-summary">{n.summary}</div>}
              <div className="small muted">
                {n.publisher}{n.publisher && n.time ? ' · ' : ''}{timeAgo(n.time)}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}
