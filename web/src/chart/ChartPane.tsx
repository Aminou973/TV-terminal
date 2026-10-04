import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { DrawingManager, type Drawing, type DrawingKind } from 'lightweight-charts-drawing'
import { getDrawings, getHistory, saveDrawings, type BarData } from '../api/client'
import { toast, useAlerts, usePaper } from '../data'
import { useTerminal, useUi, type ChartType, type PaneState } from '../store'
import { resolveIndicator } from './catalog'
import { IndicatorLayer, indicatorLabel } from './indicators'
import { stream } from './stream'
import { PALETTES, chartOptions, type ChartPalette } from './theme'

const PAGE = 1500

// ------------------------------------------------------------ helpers ------
function heikinAshi(bars: BarData[]): BarData[] {
  const out: BarData[] = []
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const close = (b.open + b.high + b.low + b.close) / 4
    const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2
    out.push({ ...b, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) })
  }
  return out
}

const isOhlc = (t: ChartType) => t === 'candles' || t === 'hollow' || t === 'bars' || t === 'heikin'

function seriesPoint(t: ChartType, b: BarData) {
  const time = b.time as UTCTimestamp
  return isOhlc(t) ? { time, open: b.open, high: b.high, low: b.low, close: b.close } : { time, value: b.close }
}

function priceFormat(bars: BarData[]) {
  const px = bars.length ? Math.abs(bars[bars.length - 1].close) : 100
  const precision = px < 1 ? 6 : px < 10 ? 4 : px < 1000 ? 2 : 2
  return { type: 'price' as const, precision, minMove: 1 / 10 ** precision }
}

function createMain(chart: IChartApi, t: ChartType, p: ChartPalette): ISeriesApi<SeriesType> {
  const candle = {
    upColor: p.up, downColor: p.down, borderUpColor: p.up, borderDownColor: p.down, wickUpColor: p.up, wickDownColor: p.down,
  }
  switch (t) {
    case 'hollow':
      return chart.addSeries(CandlestickSeries, { ...candle, upColor: 'rgba(0,0,0,0)' })
    case 'bars':
      return chart.addSeries(BarSeries, { upColor: p.up, downColor: p.down, thinBars: false })
    case 'line':
      return chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 2 })
    case 'area':
      return chart.addSeries(AreaSeries, { lineColor: '#2962ff', topColor: '#2962ff55', bottomColor: '#2962ff05', lineWidth: 2 })
    case 'baseline':
      return chart.addSeries(BaselineSeries, {
        topLineColor: p.up, topFillColor1: `${p.up}44`, topFillColor2: `${p.up}05`,
        bottomLineColor: p.down, bottomFillColor1: `${p.down}05`, bottomFillColor2: `${p.down}44`,
      })
    default:
      return chart.addSeries(CandlestickSeries, candle)
  }
}

function lowerBound(bars: BarData[], t: number): number {
  let lo = 0
  let hi = bars.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ------------------------------------------------- crosshair sync bus ------
type SyncListener = (from: string, time: number | null) => void
const syncListeners = new Set<SyncListener>()
const broadcast = (from: string, time: number | null) => syncListeners.forEach((l) => l(from, time))

// ---------------------------------------------------------------- legend ---
interface LegendState {
  bar: BarData | null
  prevClose: number | null
  values: Record<string, (number | null)[]> // layer uid -> values per plot
}

const fmt = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e4 ? v.toFixed(Math.min(d, 2)) : v.toFixed(d)

// -----------------------------------------------------------------------------
export default function ChartPane({ index }: { index: number }) {
  const pane = useTerminal((s) => s.panes[index]) as PaneState
  const active = useTerminal((s) => s.active === index)
  const theme = useTerminal((s) => s.theme)
  const drawingTool = useTerminal((s) => s.drawingTool)
  const magnet = useTerminal((s) => s.magnet)
  const stayInDrawing = useTerminal((s) => s.stayInDrawing)
  const drawingsHidden = useTerminal((s) => s.drawingsHidden)
  const syncCrosshair = useTerminal((s) => s.syncCrosshair)
  const replay = useTerminal((s) => (s.replay?.paneId === pane.id ? s.replay : null))
  const alerts = useAlerts((s) => s.list)
  const paperPositions = usePaper((s) => s.positions)
  const paperOrders = usePaper((s) => s.orders)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const drawRef = useRef<DrawingManager | null>(null)
  const layersRef = useRef<{ uid: string; layer: IndicatorLayer }[]>([])
  const barsRef = useRef<BarData[]>([])
  const replayIdx = useRef<number | null>(null)
  const linesRef = useRef<IPriceLine[]>([])
  const [generation, setGeneration] = useState(0) // bumps when the main series is recreated
  const [dataVersion, setDataVersion] = useState(0) // bumps when history (re)loads
  const [legend, setLegend] = useState<LegendState>({ bar: null, prevClose: null, values: {} })
  const [loading, setLoading] = useState(false)
  const [empty, setEmpty] = useState(false)
  const [defs, setDefs] = useState<Record<string, string>>({}) // uid -> label

  const palette = PALETTES[theme]
  const chartType = pane.chartType

  // ------------------------------------------------------------ rendering --
  const visibleBars = (): BarData[] => {
    const all = barsRef.current
    return replayIdx.current == null ? all : all.slice(0, replayIdx.current + 1)
  }

  const renderAll = () => {
    const main = mainRef.current
    const vol = volRef.current
    if (!main || !vol) return
    const bars = visibleBars()
    const shown = chartType === 'heikin' ? heikinAshi(bars) : bars
    main.applyOptions({ priceFormat: priceFormat(bars) })
    main.setData(shown.map((b) => seriesPoint(chartType, b)) as never)
    if (chartType === 'baseline' && bars.length)
      main.applyOptions({ baseValue: { type: 'price', price: bars[Math.max(0, bars.length - 200)].close } } as never)
    vol.setData(
      bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? palette.volUp : palette.volDown })),
    )
    updateLegend(null)
  }

  const indicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recomputeIndicators = (now = false) => {
    if (indicatorTimer.current) {
      if (!now) return
      clearTimeout(indicatorTimer.current)
    }
    const run = () => {
      indicatorTimer.current = null
      const bars = visibleBars()
      for (const { layer } of layersRef.current) void layer.update(bars)
    }
    if (now) run()
    else indicatorTimer.current = setTimeout(run, 1000)
  }

  const updateLegend = (param: MouseEventParams<Time> | null) => {
    const bars = visibleBars()
    let i = bars.length - 1
    if (param?.time != null) i = lowerBound(bars, param.time as number)
    const bar = bars[i] ?? null
    const values: LegendState['values'] = {}
    for (const { uid, layer } of layersRef.current) {
      values[uid] = layer.series.map(({ api }) => {
        const d = param?.seriesData.get(api) as { value?: number } | undefined
        if (d) return d.value ?? null
        const last = api.data()
        const p = last[last.length - 1] as { value?: number } | undefined
        return p?.value ?? null
      })
    }
    setLegend({ bar, prevClose: i > 0 ? bars[i - 1].close : null, values })
  }

  // ------------------------------------------------------- chart lifecycle --
  useEffect(() => {
    const chart = createChart(containerRef.current!, chartOptions(palette))
    chartRef.current = chart
    volRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    return () => {
      drawRef.current?.destroy()
      drawRef.current = null
      layersRef.current = []
      chart.remove()
      chartRef.current = null
      mainRef.current = null
      volRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    chartRef.current?.applyOptions(chartOptions(palette))
    renderAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  // main series per chart type (+ the drawing layer that hangs off it)
  useEffect(() => {
    const chart = chartRef.current!
    for (const { layer } of layersRef.current) layer.destroy()
    layersRef.current = []
    drawRef.current?.destroy()
    if (mainRef.current) chart.removeSeries(mainRef.current)
    const main = createMain(chart, chartType, palette)
    mainRef.current = main
    drawRef.current = new DrawingManager(chart, main, {
      magnet: useTerminal.getState().magnet,
      bars: () => visibleBars().map((b) => ({ ...b, time: b.time as UTCTimestamp })),
    })
    renderAll()
    setGeneration((g) => g + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType])

  // ---------------------------------------------------- history + live -----
  useEffect(() => {
    const chart = chartRef.current!
    let stale = false
    let loaded = false
    let noMore = false
    let loadingOlder = false
    const pending: BarData[] = []
    barsRef.current = []
    replayIdx.current = null
    renderAll()
    setLoading(true)

    const applyLive = (b: BarData) => {
      const bars = barsRef.current
      const last = bars[bars.length - 1]
      if (last && b.time < last.time) return
      const closedPrev = !!last && b.time > last.time
      if (last && b.time === last.time) bars[bars.length - 1] = b
      else bars.push(b)
      if (bars.length === 1) setEmpty(false)
      if (replayIdx.current != null) return // replay shows history only
      const main = mainRef.current
      const vol = volRef.current
      if (!main || !vol) return
      let shown = b
      if (chartType === 'heikin') {
        const tail = heikinAshi(bars.slice(-300))
        shown = tail[tail.length - 1]
      }
      main.update(seriesPoint(chartType, shown) as never)
      vol.update({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? palette.volUp : palette.volDown })
      recomputeIndicators(closedPrev)
    }

    getHistory(pane.symbol, pane.tf, { limit: PAGE })
      .then(({ bars }) => {
        if (stale) return
        barsRef.current = bars
        setEmpty(bars.length === 0)
        noMore = bars.length < PAGE / 2
        renderAll()
        chart.timeScale().scrollToRealTime()
        setDataVersion((v) => v + 1)
      })
      .catch((err) => toast('History failed', String(err.message ?? err), 'error'))
      .finally(() => {
        if (stale) return
        setLoading(false)
        loaded = true
        pending.splice(0).forEach(applyLive)
      })

    const off = stream.subscribeBars(pane.symbol, pane.tf, (msg) => {
      if (loaded) applyLive(msg.bar)
      else pending.push(msg.bar)
    })

    // infinite scroll: page older history in as the user scrolls left
    const onRange = (range: { from: number; to: number } | null) => {
      if (!range || range.from > 30 || noMore || loadingOlder || !loaded || replayIdx.current != null) return
      const first = barsRef.current[0]
      if (!first) return
      loadingOlder = true
      getHistory(pane.symbol, pane.tf, { limit: PAGE, to: first.time - 1 })
        .then(({ bars }) => {
          if (stale) return
          const older = bars.filter((b) => b.time < first.time)
          if (older.length === 0) {
            noMore = true
            return
          }
          const vr = chart.timeScale().getVisibleLogicalRange()
          barsRef.current = [...older, ...barsRef.current]
          renderAll()
          if (vr) chart.timeScale().setVisibleLogicalRange({ from: vr.from + older.length, to: vr.to + older.length })
          recomputeIndicators(true)
        })
        .catch(() => {})
        .finally(() => {
          loadingOlder = false
        })
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    return () => {
      stale = true
      off()
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.symbol, pane.tf, generation])

  // ------------------------------------------------------------ indicators --
  const indicatorKey = JSON.stringify(pane.indicators)
  useEffect(() => {
    const chart = chartRef.current
    const main = mainRef.current
    if (!chart || !main) return
    let cancelled = false
    for (const { layer } of layersRef.current) layer.destroy()
    layersRef.current = []
    ;(async () => {
      const sample = barsRef.current
      let paneIndex = 1
      const labels: Record<string, string> = {}
      for (const inst of pane.indicators) {
        let def = null
        try {
          def = await resolveIndicator(inst.id, sample)
        } catch (err) {
          toast(`Indicator ${inst.id} failed`, String((err as Error).message), 'error')
        }
        if (cancelled) return
        if (!def) continue
        const inputs = { ...def.defaults, ...inst.inputs }
        const layer = new IndicatorLayer(chart, main, def, inputs, def.overlay ? 0 : paneIndex++, !inst.hidden)
        layersRef.current.push({ uid: inst.uid, layer })
        labels[inst.uid] = indicatorLabel(def, inputs)
      }
      setDefs(labels)
      // give oscillator panes a sensible height relative to the price pane
      const panes = chart.panes()
      if (panes.length > 1) {
        panes[0].setStretchFactor(Math.max(2, panes.length))
        for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1)
      }
      recomputeIndicators(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorKey, generation, dataVersion])

  // -------------------------------------------------------------- drawings --
  useEffect(() => {
    const dm = drawRef.current
    if (!dm) return
    let importing = true
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    dm.importJSON('[]')
    getDrawings(pane.symbol)
      .then(({ data }) => {
        if (drawRef.current === dm) dm.importJSON(data)
      })
      .catch(() => {})
      .finally(() => {
        importing = false
      })
    const offChange = dm.on('change', () => {
      if (importing) return
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveDrawings(pane.symbol, JSON.parse(dm.exportJSON())).catch((e) => toast('Saving drawings failed', String(e.message), 'error'))
      }, 800)
    })
    const offTool = dm.on('tool', (kind) => {
      const st = useTerminal.getState()
      if (kind === null && st.drawingTool !== null && st.active === index) st.setDrawingTool(null)
    })
    const offText = dm.on('textEdit', (d) => {
      const current = (d as Drawing & { text?: string }).text ?? ''
      const text = window.prompt('Text', current)
      if (text != null) dm.update({ ...d, text } as Drawing)
    })
    return () => {
      offChange()
      offTool()
      offText()
      if (saveTimer) {
        clearTimeout(saveTimer)
        if (!importing) saveDrawings(pane.symbol, JSON.parse(dm.exportJSON())).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.symbol, generation])

  useEffect(() => {
    drawRef.current?.setTool(active && drawingTool ? (drawingTool as DrawingKind) : null)
  }, [drawingTool, active, generation])
  useEffect(() => drawRef.current?.setMagnet(magnet), [magnet, generation])
  useEffect(() => drawRef.current?.setStayInDrawingMode(stayInDrawing), [stayInDrawing, generation])
  useEffect(() => {
    const dm = drawRef.current
    if (!dm) return
    for (const d of dm.drawings()) if (!!d.hidden !== drawingsHidden) dm.update({ ...d, hidden: drawingsHidden })
  }, [drawingsHidden, generation])

  // "remove all drawings" from the toolbar targets the active pane
  useEffect(() => {
    if (!active) return
    const onClear = () => drawRef.current?.clear()
    window.addEventListener('ot:clear-drawings', onClear)
    return () => window.removeEventListener('ot:clear-drawings', onClear)
  }, [active])

  // -------------------------------------------- alert + order price lines ---
  useEffect(() => {
    const main = mainRef.current
    if (!main) return
    for (const l of linesRef.current) main.removePriceLine(l)
    linesRef.current = []
    for (const a of alerts) {
      if (a.symbol !== pane.symbol || !a.active) continue
      linesRef.current.push(
        main.createPriceLine({ price: a.price, color: '#ff9800', lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true, title: '⏰' }),
      )
    }
    for (const p of paperPositions) {
      if (p.symbol !== pane.symbol) continue
      const up = p.unrealized_pnl >= 0
      linesRef.current.push(
        main.createPriceLine({
          price: p.avg_price,
          color: p.qty > 0 ? '#2962ff' : '#f23645',
          lineStyle: LineStyle.Solid,
          lineWidth: 1,
          axisLabelVisible: true,
          title: `${p.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.qty)} ${up ? '+' : ''}${p.unrealized_pnl.toFixed(2)}`,
        }),
      )
    }
    for (const o of paperOrders) {
      if (o.symbol !== pane.symbol || o.status !== 'working' || o.price == null) continue
      linesRef.current.push(
        main.createPriceLine({
          price: o.price,
          color: o.side === 'buy' ? '#2962ff' : '#f23645',
          lineStyle: LineStyle.Dashed,
          lineWidth: 1,
          axisLabelVisible: true,
          title: `${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.qty}`,
        }),
      )
    }
  }, [alerts, paperPositions, paperOrders, pane.symbol, generation])

  // -------------------------------------------- crosshair: legend + sync ----
  useEffect(() => {
    const chart = chartRef.current!
    let raf = 0
    const onMove = (param: MouseEventParams<Time>) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => updateLegend(param.time != null ? param : null))
      if (param.sourceEvent && useTerminal.getState().syncCrosshair) broadcast(pane.id, (param.time as number) ?? null)
    }
    chart.subscribeCrosshairMove(onMove)
    const onSync: SyncListener = (from, time) => {
      if (from === pane.id || !mainRef.current) return
      if (time == null) return chart.clearCrosshairPosition()
      const bars = visibleBars()
      const i = Math.min(lowerBound(bars, time), bars.length - 1)
      if (i >= 0) chart.setCrosshairPosition(bars[i].close, bars[i].time as UTCTimestamp, mainRef.current)
    }
    if (syncCrosshair) syncListeners.add(onSync)
    return () => {
      cancelAnimationFrame(raf)
      chart.unsubscribeCrosshairMove(onMove)
      syncListeners.delete(onSync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, syncCrosshair, pane.id])

  // ---------------------------------------------------------------- replay --
  useEffect(() => {
    const chart = chartRef.current!
    if (!replay) {
      if (replayIdx.current != null) {
        replayIdx.current = null
        renderAll()
        recomputeIndicators(true)
        chart.timeScale().scrollToRealTime()
      }
      return
    }
    if (replay.start == null) {
      if (replayIdx.current != null) {
        replayIdx.current = null
        renderAll()
        recomputeIndicators(true)
      }
      // pick the starting bar with a click
      const onClick = (param: MouseEventParams<Time>) => {
        if (param.time == null) return
        useTerminal.getState().setReplay({ ...replay, start: param.time as number })
      }
      chart.subscribeClick(onClick)
      return () => chart.unsubscribeClick(onClick)
    }
    const bars = barsRef.current
    if (replayIdx.current == null) {
      replayIdx.current = Math.max(0, Math.min(lowerBound(bars, replay.start), bars.length - 1))
      renderAll()
      recomputeIndicators(true)
    }
    if (!replay.playing) return
    const timer = setInterval(() => stepReplay(), replay.speedMs)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.start, replay?.playing, replay?.speedMs, !!replay])

  const stepReplay = () => {
    const bars = barsRef.current
    if (replayIdx.current == null) return
    if (replayIdx.current >= bars.length - 1) {
      const r = useTerminal.getState().replay
      if (r) useTerminal.getState().setReplay({ ...r, playing: false })
      return
    }
    replayIdx.current += 1
    const b = bars[replayIdx.current]
    const shown = chartType === 'heikin' ? heikinAshi(bars.slice(Math.max(0, replayIdx.current - 300), replayIdx.current + 1)).pop()! : b
    mainRef.current?.update(seriesPoint(chartType, shown) as never)
    volRef.current?.update({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? palette.volUp : palette.volDown })
    recomputeIndicators(true)
    updateLegend(null)
  }

  // ---------------------------------------------------------------- legend --
  const bar = legend.bar
  const chg = bar && legend.prevClose != null ? bar.close - legend.prevClose : null
  const chgPct = chg != null && legend.prevClose ? (chg / legend.prevClose) * 100 : null
  const up = (chg ?? 0) >= 0
  const digits = useMemo(() => priceFormat(barsRef.current).precision, [dataVersion])
  const updateIndicator = useTerminal((s) => s.updateIndicator)
  const removeIndicator = useTerminal((s) => s.removeIndicator)
  const openDialog = useUi((s) => s.open)

  return (
    <div
      className={`chart-pane ${active ? 'active' : ''}`}
      onMouseDown={() => useTerminal.getState().active !== index && useTerminal.getState().setActive(index)}
    >
      <div ref={containerRef} className="chart-canvas" />
      <div className="legend">
        <div className="legend-row main">
          <span className="legend-sym">{pane.symbol}</span>
          <span className="legend-tf">· {pane.tf}</span>
          {bar && (
            <span className={`legend-ohlc ${up ? 'up' : 'down'}`}>
              <i>O</i>{fmt(bar.open, digits)} <i>H</i>{fmt(bar.high, digits)} <i>L</i>{fmt(bar.low, digits)} <i>C</i>{fmt(bar.close, digits)}
              {chg != null && (
                <b>
                  {' '}{up ? '+' : ''}{fmt(chg, digits)} ({up ? '+' : ''}{fmt(chgPct, 2)}%)
                </b>
              )}
              <i> Vol</i>{fmt(bar.volume, 0)}
            </span>
          )}
          {loading && <span className="legend-loading">loading…</span>}
        </div>
        {pane.indicators.map((inst) => {
          const layer = layersRef.current.find((l) => l.uid === inst.uid)?.layer
          const vals = legend.values[inst.uid] ?? []
          return (
            <div key={inst.uid} className={`legend-row ind ${inst.hidden ? 'muted' : ''}`}>
              <span className="legend-name">{defs[inst.uid] ?? inst.id}</span>
              {layer?.series.map(({ plot }, k) => (
                <span key={plot.id} style={{ color: plot.color }}>
                  {fmt(vals[k], digits)}
                </span>
              ))}
              <span className="legend-actions">
                <button title={inst.hidden ? 'Show' : 'Hide'} onClick={() => { useTerminal.getState().setActive(index); updateIndicator(inst.uid, { hidden: !inst.hidden }) }}>
                  {inst.hidden ? '◌' : '◉'}
                </button>
                <button title="Settings" onClick={() => { useTerminal.getState().setActive(index); openDialog({ kind: 'indicatorSettings', uid: inst.uid }) }}>⚙</button>
                <button title="Remove" onClick={() => { useTerminal.getState().setActive(index); removeIndicator(inst.uid) }}>✕</button>
              </span>
            </div>
          )
        })}
      </div>
      {empty && !loading && (
        <div className="chart-empty">
          <b>No data for {pane.symbol} yet</b>
          <span>Bars appear as soon as a provider streams this symbol (NinjaTrader, yfinance, ccxt or the simulator).</span>
        </div>
      )}
      {replay && (
        <div className="replay-bar">
          {replay.start == null ? (
            <span>Click a bar to start the replay</span>
          ) : (
            <>
              <button onClick={() => useTerminal.getState().setReplay({ ...replay, playing: !replay.playing })}>
                {replay.playing ? '❚❚' : '▶'}
              </button>
              <button onClick={stepReplay} title="Step forward">⏭</button>
              <select
                value={replay.speedMs}
                onChange={(e) => useTerminal.getState().setReplay({ ...replay, speedMs: Number(e.target.value) })}
              >
                <option value={1000}>1x</option>
                <option value={500}>2x</option>
                <option value={200}>5x</option>
                <option value={100}>10x</option>
              </select>
              <button onClick={() => useTerminal.getState().setReplay({ ...replay, start: null, playing: false })} title="Pick a new start">
                ⟲
              </button>
            </>
          )}
          <button className="replay-exit" onClick={() => useTerminal.getState().setReplay(null)}>
            Exit replay
          </button>
        </div>
      )}
    </div>
  )
}
