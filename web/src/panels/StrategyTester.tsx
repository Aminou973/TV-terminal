import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { AreaSeries, BaselineSeries, createChart, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import { getHistory } from '../api/client'
import { chartOptions, PALETTES } from '../chart/theme'
import { toast, useScripts } from '../data'
import { pointValue } from '../markets'
import type { ScriptInput, ScriptResult } from '../scripts/engine'
import { scriptRunner } from '../scripts/runtime'
import { useTerminal } from '../store'

interface TesterState {
  scriptName: string | null
  select: (name: string) => void
}
export const useTester = create<TesterState>((set) => ({
  scriptName: null,
  select: (scriptName) => set({ scriptName }),
}))

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`

export default function StrategyTester() {
  const allScripts = useScripts((s) => s.list)
  const scripts = allScripts.filter((s) => s.kind === 'strategy')
  const scriptName = useTester((s) => s.scriptName)
  const select = useTester((s) => s.select)
  const pane = useTerminal((s) => s.panes[s.active])
  const theme = useTerminal((s) => s.theme)
  const [bars, setBars] = useState(5000)
  const [capital, setCapital] = useState(100000)
  const [qty, setQty] = useState(1)
  const [commission, setCommission] = useState(0)
  const [fillOnClose, setFillOnClose] = useState(false)
  const [inputs, setInputs] = useState<Record<string, unknown>>({})
  const [inputSpecs, setInputSpecs] = useState<ScriptInput[]>([])
  const [result, setResult] = useState<ScriptResult | null>(null)
  const [tab, setTab] = useState<'overview' | 'trades'>('overview')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chartHost = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!scriptName && scripts[0]) select(scripts[0].name)
  }, [scriptName, scripts, select])

  useEffect(() => {
    setInputs({})
    setInputSpecs([])
    setResult(null)
  }, [scriptName])

  const script = scripts.find((s) => s.name === scriptName)

  const run = async () => {
    if (!script) return
    setBusy(true)
    setError(null)
    try {
      const { bars: data } = await getHistory(pane.symbol, pane.tf, { limit: bars })
      if (data.length < 2) throw new Error('not enough history for this symbol/timeframe')
      const r = await scriptRunner.run(script.source, data, inputs, pointValue(pane.symbol), {
        initialCapital: capital,
        qty,
        commissionPct: commission,
        fillOnClose,
      })
      if (!r.strategy) throw new Error('this script has no strategy.onBar(...) — it is an indicator')
      setInputSpecs(r.inputs)
      setResult(r)
    } catch (e) {
      setError((e as Error).message)
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  // equity + drawdown chart
  useEffect(() => {
    if (!result?.strategy || tab !== 'overview' || !chartHost.current) return
    const chart = createChart(chartHost.current, {
      ...chartOptions(PALETTES[theme]),
      rightPriceScale: { borderColor: PALETTES[theme].border, scaleMargins: { top: 0.1, bottom: 0.3 } },
    })
    chartRef.current = chart
    const eq = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: capital },
      topLineColor: '#089981', topFillColor1: '#08998155', topFillColor2: '#08998105',
      bottomLineColor: '#f23645', bottomFillColor1: '#f2364505', bottomFillColor2: '#f2364555',
      lineWidth: 2, priceLineVisible: false,
    })
    eq.setData(result.strategy.equity.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))
    const dd = chart.addSeries(AreaSeries, {
      priceScaleId: 'dd', lineColor: '#f2364599', topColor: '#f2364533', bottomColor: '#f2364533', lineWidth: 1, priceLineVisible: false,
    })
    chart.priceScale('dd').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } })
    dd.setData(result.strategy.drawdown.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))
    chart.timeScale().fitContent()
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [result, tab, theme, capital])

  const m = result?.strategy?.metrics
  const trades = result?.strategy?.trades ?? []
  const longs = trades.filter((t) => t.side === 'long')
  const shorts = trades.filter((t) => t.side === 'short')
  const sum = (xs: typeof trades) => xs.reduce((a, t) => a + t.pnl, 0)

  return (
    <div className="tester">
      <div className="tester-bar">
        <select value={scriptName ?? ''} onChange={(e) => select(e.target.value)}>
          {scripts.length === 0 && <option value="">No saved strategies — write one in the editor</option>}
          {scripts.map((s) => (
            <option key={s.id}>{s.name}</option>
          ))}
        </select>
        <span className="muted small">{pane.symbol} · {pane.tf}</span>
        <label>Bars <select value={bars} onChange={(e) => setBars(Number(e.target.value))}>{[1000, 2000, 5000, 10000, 20000].map((n) => <option key={n}>{n}</option>)}</select></label>
        <label>Capital <input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))} /></label>
        <label>Qty <input type="number" value={qty} min={0} step="any" onChange={(e) => setQty(Number(e.target.value))} /></label>
        <label>Comm % <input type="number" value={commission} min={0} step="0.01" onChange={(e) => setCommission(Number(e.target.value))} /></label>
        <label title="Fill on the signal bar's close instead of the next bar's open"><input type="checkbox" checked={fillOnClose} onChange={(e) => setFillOnClose(e.target.checked)} /> on close</label>
        <button className="primary" onClick={run} disabled={!script || busy}>{busy ? 'Running…' : 'Run backtest'}</button>
        {script && (
          <button onClick={() => { useTerminal.getState().addIndicator(`script:${script.name}`, inputs); toast('Added to chart', script.name) }}>
            Show on chart
          </button>
        )}
      </div>
      {inputSpecs.length > 0 && (
        <div className="tester-inputs">
          {inputSpecs.map((i) => (
            <label key={i.id}>
              {i.title}
              {i.type === 'bool' ? (
                <input type="checkbox" checked={Boolean(inputs[i.id] ?? i.defval)} onChange={(e) => setInputs({ ...inputs, [i.id]: e.target.checked })} />
              ) : i.type === 'int' || i.type === 'float' ? (
                <input type="number" step={i.type === 'int' ? 1 : 'any'} value={String(inputs[i.id] ?? i.defval)} onChange={(e) => setInputs({ ...inputs, [i.id]: Number(e.target.value) })} />
              ) : (
                <input value={String(inputs[i.id] ?? i.defval)} onChange={(e) => setInputs({ ...inputs, [i.id]: e.target.value })} />
              )}
            </label>
          ))}
        </div>
      )}
      {error && <div className="tester-error">✗ {error}</div>}
      {!result && !error && <p className="muted pad">Pick a strategy and run it on the active chart's symbol and timeframe.</p>}
      {m && (
        <>
          <div className="seg tester-tabs">
            <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>Overview</button>
            <button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>List of trades ({trades.length})</button>
          </div>
          {tab === 'overview' ? (
            <div className="tester-overview">
              <div className="metrics">
                <Metric label="Net profit" value={money(m.netProfit)} sub={pct(m.netProfitPct)} tone={m.netProfit} />
                <Metric label="Total trades" value={String(m.totalTrades)} sub={`${longs.length} long · ${shorts.length} short`} />
                <Metric label="Win rate" value={`${m.winRate.toFixed(1)}%`} />
                <Metric label="Profit factor" value={m.profitFactor == null ? '—' : m.profitFactor.toFixed(2)} />
                <Metric label="Max drawdown" value={money(-m.maxDrawdown)} sub={`${m.maxDrawdownPct.toFixed(2)}%`} tone={-1} />
                <Metric label="Avg trade" value={money(m.avgTrade)} tone={m.avgTrade} />
                <Metric label="Avg win / loss" value={`${money(m.avgWin)} / ${money(m.avgLoss)}`} />
                <Metric label="Largest win / loss" value={`${money(m.largestWin)} / ${money(m.largestLoss)}`} />
                <Metric label="Sharpe (per bar, ann.)" value={m.sharpe == null ? '—' : m.sharpe.toFixed(2)} />
                <Metric label="Buy & hold" value={pct(m.buyHoldPct)} tone={m.buyHoldPct} />
                <Metric label="Long / short P&L" value={`${money(sum(longs))} / ${money(sum(shorts))}`} />
                <Metric label="Commission · open P&L" value={`${money(m.commissionPaid)} · ${money(m.openPnl)}`} />
              </div>
              <div className="equity" ref={chartHost} />
            </div>
          ) : (
            <div className="table-wrap">
              <table className="grid-table">
                <thead>
                  <tr><th>#</th><th>Side</th><th>Entry</th><th>Entry px</th><th>Exit</th><th>Exit px</th><th>Qty</th><th>P&amp;L</th><th>%</th><th>Bars</th><th>Exit reason</th></tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td className={t.side === 'long' ? 'up' : 'down'}>{t.side}</td>
                      <td>{new Date(t.entryTime * 1000).toLocaleString()}</td>
                      <td>{t.entryPrice.toFixed(2)}</td>
                      <td>{new Date(t.exitTime * 1000).toLocaleString()}</td>
                      <td>{t.exitPrice.toFixed(2)}</td>
                      <td>{t.qty}</td>
                      <td className={t.pnl >= 0 ? 'up' : 'down'}>{money(t.pnl)}</td>
                      <td className={t.pnlPct >= 0 ? 'up' : 'down'}>{pct(t.pnlPct)}</td>
                      <td>{t.bars}</td>
                      <td>{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b className={tone == null ? '' : tone >= 0 ? 'up' : 'down'}>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  )
}
