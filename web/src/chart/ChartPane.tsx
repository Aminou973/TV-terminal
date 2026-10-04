import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  PriceScaleMode,
  TickMarkType,
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
import { getDrawings, getStats, saveDrawings, type BarData } from '../api/client'
import { toast, useAlerts, usePaper, useSymbols } from '../data'
import { formatTime, resolveTz, sessionKey } from '../markets'
import {
  paneSettings,
  tfSeconds,
  useCrosshair,
  useTerminal,
  useUi,
  type ChartSettings,
  type ChartType,
  type PaneState,
} from '../store'
import { resolveIndicator } from './catalog'
import ChartMenu, { type MenuState } from './ChartMenu'
import { sourceFor } from './datasource'
import { IndicatorLayer, indicatorLabel } from './indicators'
import { registerPane, useRegistry } from './registry'
import { SessionBreaks } from './sessionBreaks'
import { PALETTES, chartOptions } from './theme'
import { heikinAshi, kagi, lineBreak, pointFigure, rangeBars, renko } from './transforms'

const PAGE = 1500
const COMPARE_COLORS = ['#ff9800', '#ab47bc', '#26c6da', '#ec407a', '#9ccc65', '#ffca28']

// ------------------------------------------------------------ helpers ------
/** Chart types whose x-axis isn't wall-clock time (bricks/columns). */
export const TIMELESS: ChartType[] = ['renko', 'range', 'linebreak', 'kagi', 'pnf']
const isOhlc = (t: ChartType) => !['line', 'area', 'baseline', 'columns', 'kagi'].includes(t)

function transform(t: ChartType, bars: BarData[], s: ChartSettings): BarData[] {
  switch (t) {
    case 'heikin':
      return heikinAshi(bars)
    case 'renko':
      return renko(bars, { box: s.box })
    case 'range':
      return rangeBars(bars, { box: s.box })
    case 'linebreak':
      return lineBreak(bars, { lines: s.lineBreak })
    case 'kagi':
      return kagi(bars, { box: s.box })
    case 'pnf':
      return pointFigure(bars, { box: s.box, reversal: s.reversal })
    default:
      return bars
  }
}

function seriesPoint(t: ChartType, b: BarData, s: ChartSettings) {
  const time = b.time as UTCTimestamp
  if (isOhlc(t)) return { time, open: b.open, high: b.high, low: b.low, close: b.close }
  if (t === 'columns') return { time, value: b.close, color: b.close >= b.open ? s.upColor : s.downColor }
  return { time, value: b.close }
}

function priceFormat(bars: BarData[]) {
  const px = bars.length ? Math.abs(bars[bars.length - 1].close) : 100
  const precision = px < 1 ? 6 : px < 10 ? 4 : 2
  return { type: 'price' as const, precision, minMove: 1 / 10 ** precision }
}

function candleColors(t: ChartType, s: ChartSettings) {
  const up = s.upColor
  const down = s.downColor
  return {
    upColor: t === 'hollow' ? 'rgba(0,0,0,0)' : up,
    downColor: down,
    borderUpColor: up,
    borderDownColor: down,
    wickUpColor: up,
    wickDownColor: down,
  }
}

function createMain(chart: IChartApi, t: ChartType, s: ChartSettings): ISeriesApi<SeriesType> {
  switch (t) {
    case 'bars':
      return chart.addSeries(BarSeries, { upColor: s.upColor, downColor: s.downColor, thinBars: false })
    case 'line':
      return chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 2 })
    case 'kagi':
      return chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 2, lineType: LineType.WithSteps })
    case 'columns':
      return chart.addSeries(HistogramSeries, { color: s.upColor })
    case 'area':
      return chart.addSeries(AreaSeries, { lineColor: '#2962ff', topColor: '#2962ff55', bottomColor: '#2962ff05', lineWidth: 2 })
    case 'baseline':
      return chart.addSeries(BaselineSeries, {
        topLineColor: s.upColor, topFillColor1: `${s.upColor}44`, topFillColor2: `${s.upColor}05`,
        bottomLineColor: s.downColor, bottomFillColor1: `${s.downColor}05`, bottomFillColor2: `${s.downColor}44`,
      })
    default:
      return chart.addSeries(CandlestickSeries, candleColors(t, s))
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

const pad = (n: number) => String(n).padStart(2, '0')
function countdownText(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
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
  const market = useSymbols((s) => s.list.find((x) => x.symbol === pane.symbol)?.market)
  const alerts = useAlerts((s) => s.list)
  const paperPositions = usePaper((s) => s.positions)
  const paperOrders = usePaper((s) => s.orders)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const drawRef = useRef<DrawingManager | null>(null)
  const breaksRef = useRef<SessionBreaks | null>(null)
  const layersRef = useRef<{ uid: string; layer: IndicatorLayer }[]>([])
  const compareRef = useRef<{ symbol: string; color: string; api: ISeriesApi<'Line'> }[]>([])
  const barsRef = useRef<BarData[]>([])
  const replayIdx = useRef<number | null>(null)
  const linesRef = useRef<IPriceLine[]>([])
  const undoRef = useRef<{ undo: () => void; redo: () => void }>({ undo: () => {}, redo: () => {} })
  const [generation, setGeneration] = useState(0) // bumps when the main series is recreated
  const [dataVersion, setDataVersion] = useState(0) // bumps when history (re)loads
  const [legend, setLegend] = useState<LegendState>({ bar: null, prevClose: null, values: {} })
  const [loading, setLoading] = useState(false)
  const [empty, setEmpty] = useState(false)
  const [defs, setDefs] = useState<Record<string, string>>({}) // uid -> label
  const [menu, setMenu] = useState<MenuState | null>(null)

  const palette = PALETTES[theme]
  const chartType = pane.chartType
  const settings = paneSettings(pane)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // long-lived chart callbacks read the current symbol/tf through this
  const paneRef = useRef(pane)
  paneRef.current = pane
  const settingsKey = JSON.stringify(settings)
  const timeless = TIMELESS.includes(chartType)
  const source = useMemo(() => sourceFor(pane.symbol, pane.tf), [pane.symbol, pane.tf])

  // ------------------------------------------------------------ rendering --
  const visibleBars = (): BarData[] => {
    const all = barsRef.current
    return replayIdx.current == null ? all : all.slice(0, replayIdx.current + 1)
  }

  /** Indicators follow what's drawn: on Renko & co they run on the bricks (as TradingView does). */
  const indicatorBars = (): BarData[] =>
    TIMELESS.includes(chartType) ? transform(chartType, visibleBars(), settingsRef.current) : visibleBars()

  /** Price-based types: frame the latest ~150 bricks (fitting thousands makes them hairlines). */
  const frameBricks = () => {
    const chart = chartRef.current
    const n = mainRef.current?.data().length ?? 0
    if (chart && n) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 150), to: n + 5 })
  }

  const renderAll = () => {
    const main = mainRef.current
    const vol = volRef.current
    if (!main || !vol) return
    const s = settingsRef.current
    const bars = visibleBars()
    const shown = transform(chartType, bars, s)
    main.applyOptions({ priceFormat: priceFormat(bars) })
    main.setData(shown.map((b) => seriesPoint(chartType, b, s)) as never)
    if (chartType === 'baseline' && bars.length)
      main.applyOptions({ baseValue: { type: 'price', price: bars[Math.max(0, bars.length - 200)].close } } as never)
    vol.setData(
      shown.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? palette.volUp : palette.volDown })),
    )
    updateBreaks(shown)
    updateLegend(null)
  }

  const updateBreaks = (shown: BarData[]) => {
    const sb = breaksRef.current
    if (!sb) return
    const secs = tfSeconds(pane.tf) ?? 86400
    if (!settingsRef.current.sessionBreaks || timeless || secs >= 86400) return sb.set([], palette.border)
    const times: number[] = []
    let prev = ''
    for (const b of shown) {
      const k = sessionKey(b.time, market)
      if (prev && k !== prev) times.push(b.time)
      prev = k
    }
    sb.set(times, theme === 'dark' ? 'rgba(120,123,134,0.45)' : 'rgba(120,123,134,0.35)')
  }

  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleRender = () => {
    if (renderTimer.current) return
    renderTimer.current = setTimeout(() => {
      renderTimer.current = null
      renderAll()
    }, 300)
  }

  /** Scale mode/invert are for the price pane only; oscillator panes stay regular. */
  const keepIndicatorScalesNormal = () => {
    const chart = chartRef.current
    if (!chart) return
    const n = chart.panes().length
    for (let i = 1; i < n; i++) chart.priceScale('right', i).applyOptions({ mode: PriceScaleMode.Normal, invertScale: false })
  }

  const indicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recomputeIndicators = (now = false) => {
    if (indicatorTimer.current) {
      if (!now) return
      clearTimeout(indicatorTimer.current)
    }
    const run = () => {
      indicatorTimer.current = null
      const bars = indicatorBars()
      for (const { layer } of layersRef.current) void layer.update(bars)
    }
    if (now) run()
    else indicatorTimer.current = setTimeout(run, 1000)
  }

  const updateLegend = (param: MouseEventParams<Time> | null) => {
    const bars = indicatorBars() // bricks on price-based types, bars otherwise
    let i = bars.length - 1
    if (param?.time != null) i = Math.min(lowerBound(bars, param.time as number), bars.length - 1)
    const bar = bars[i] ?? null
    const values: LegendState['values'] = {}
    const read = (api: ISeriesApi<SeriesType>) => {
      const d = param?.seriesData.get(api) as { value?: number } | undefined
      if (d) return d.value ?? null
      const all = api.data()
      const p = all[all.length - 1] as { value?: number } | undefined
      return p?.value ?? null
    }
    for (const { uid, layer } of layersRef.current) values[uid] = layer.series.map(({ api }) => read(api))
    const prevClose = i > 0 ? bars[i - 1].close : null
    setLegend({ bar, prevClose, values })
    if (useTerminal.getState().active === index) {
      const change = bar && prevClose != null ? bar.close - prevClose : null
      useCrosshair.getState().set({
        symbol: paneRef.current.symbol,
        tf: paneRef.current.tf,
        bar,
        change,
        changePct: change != null && prevClose ? (change / prevClose) * 100 : null,
        rows: [
          ...layersRef.current.flatMap(({ uid, layer }) =>
            layer.series.map(({ plot }, k) => ({ label: `${layer.def.shortName} · ${plot.title}`, color: plot.color, value: values[uid]?.[k] ?? null })),
          ),
          ...compareRef.current.map((c) => ({ label: c.symbol, color: c.color, value: read(c.api) })),
        ],
      })
    }
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
      compareRef.current = []
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
    const main = createMain(chart, chartType, settingsRef.current)
    mainRef.current = main
    breaksRef.current = new SessionBreaks()
    main.attachPrimitive(breaksRef.current)
    drawRef.current = new DrawingManager(chart, main, {
      magnet: useTerminal.getState().magnet,
      bars: () => visibleBars().map((b) => ({ ...b, time: b.time as UTCTimestamp })),
    })
    renderAll()
    // bricks/columns have their own x-axis: show them all rather than the old time window
    if (TIMELESS.includes(chartType)) frameBricks()
    setGeneration((g) => g + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType])

  // ------------------------------------------------- settings → the chart --
  useEffect(() => {
    const chart = chartRef.current
    const main = mainRef.current
    if (!chart || !main) return
    const s = settings
    const hasCompares = (pane.compares?.length ?? 0) > 0 && !timeless
    const mode = hasCompares
      ? PriceScaleMode.Percentage
      : { normal: PriceScaleMode.Normal, log: PriceScaleMode.Logarithmic, percent: PriceScaleMode.Percentage, indexed: PriceScaleMode.IndexedTo100 }[s.scale]
    chart.priceScale('right', 0).applyOptions({ mode, invertScale: s.invert })
    keepIndicatorScalesNormal()
    chart.applyOptions({ grid: { vertLines: { visible: s.grid }, horzLines: { visible: s.grid } } })
    volRef.current?.applyOptions({ visible: s.volume })
    if (['candles', 'hollow', 'heikin', 'renko', 'range', 'linebreak', 'pnf'].includes(chartType)) main.applyOptions(candleColors(chartType, s))
    if (chartType === 'bars') main.applyOptions({ upColor: s.upColor, downColor: s.downColor })
    const tz = resolveTz(s.timezone, market)
    chart.applyOptions({
      localization: {
        timeFormatter: (t: Time) =>
          formatTime(t as number, tz, { weekday: 'short', day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }),
      },
      timeScale: {
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          const sec = t as number
          if (type === TickMarkType.Year) return formatTime(sec, tz, { year: 'numeric' })
          if (type === TickMarkType.Month) return formatTime(sec, tz, { month: 'short' })
          if (type === TickMarkType.DayOfMonth) return formatTime(sec, tz, { day: 'numeric' })
          return formatTime(sec, tz, { hour: '2-digit', minute: '2-digit', hour12: false })
        },
      },
    })
    renderAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey, generation, market, pane.compares?.join('|')])

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
      if (timeless) {
        scheduleRender() // bricks/columns depend on the whole series
        recomputeIndicators(closedPrev)
        return
      }
      const main = mainRef.current
      const vol = volRef.current
      if (!main || !vol) return
      let shown = b
      if (chartType === 'heikin') {
        const tail = heikinAshi(bars.slice(-300))
        shown = tail[tail.length - 1]
      }
      main.update(seriesPoint(chartType, shown, settingsRef.current) as never)
      vol.update({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? palette.volUp : palette.volDown })
      if (closedPrev) updateBreaks(bars)
      recomputeIndicators(closedPrev)
    }

    source
      .history({ limit: PAGE })
      .then((bars) => {
        if (stale) return
        barsRef.current = bars
        setEmpty(bars.length === 0)
        noMore = bars.length < PAGE / 2
        renderAll()
        if (timeless) frameBricks()
        else chart.timeScale().scrollToRealTime()
        setDataVersion((v) => v + 1)
      })
      .catch((err) => toast('History failed', String(err.message ?? err), 'error'))
      .finally(() => {
        if (stale) return
        setLoading(false)
        loaded = true
        pending.splice(0).forEach(applyLive)
      })

    const off = source.subscribe((bar) => {
      if (loaded) applyLive(bar)
      else pending.push(bar)
    })

    // infinite scroll: page older history in as the user scrolls left
    const onRange = (range: { from: number; to: number } | null) => {
      if (!range || range.from > 30 || noMore || loadingOlder || !loaded || replayIdx.current != null || timeless) return
      const first = barsRef.current[0]
      if (!first) return
      loadingOlder = true
      source
        .history({ limit: PAGE, to: first.time - 1 })
        .then((bars) => {
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
      if (renderTimer.current) clearTimeout(renderTimer.current)
      renderTimer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, generation])

  // ------------------------------------------------------------- compares --
  const compareKey = (pane.compares ?? []).join('|')
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !mainRef.current) return
    const offs: (() => void)[] = []
    let cancelled = false
    for (const c of compareRef.current) chart.removeSeries(c.api)
    compareRef.current = []
    if (timeless) return // a %-overlay needs a shared time axis
    ;(pane.compares ?? []).forEach((symbol, i) => {
      const color = COMPARE_COLORS[i % COMPARE_COLORS.length]
      const api = chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, title: symbol })
      compareRef.current.push({ symbol, color, api })
      const src = sourceFor(symbol, pane.tf)
      src
        .history({ limit: PAGE })
        .then((bars) => {
          if (!cancelled) api.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.close })))
        })
        .catch(() => toast('Compare failed', symbol, 'error'))
      offs.push(
        src.subscribe((b) => {
          try {
            api.update({ time: b.time as UTCTimestamp, value: b.close })
          } catch {
            /* out-of-order update before history arrives */
          }
        }),
      )
    })
    return () => {
      cancelled = true
      offs.forEach((o) => o())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareKey, pane.tf, generation, timeless])

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
      const sample = indicatorBars()
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
      keepIndicatorScalesNormal()
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

  // ----------------------------------------------- drawings + undo/redo ----
  useEffect(() => {
    const dm = drawRef.current
    if (!dm) return
    let importing = true
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let recordTimer: ReturnType<typeof setTimeout> | null = null
    const undoStack: string[] = []
    const redoStack: string[] = []
    let current = '[]'

    const save = () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = null
        saveDrawings(pane.symbol, JSON.parse(dm.exportJSON())).catch((e) => toast('Saving drawings failed', String(e.message), 'error'))
      }, 800)
    }
    const load = (json: string) => {
      importing = true
      dm.importJSON(json)
      importing = false
      useRegistry.getState().bump()
    }

    dm.importJSON('[]')
    getDrawings(pane.symbol)
      .then(({ data }) => {
        if (drawRef.current === dm) dm.importJSON(data)
      })
      .catch(() => {})
      .finally(() => {
        importing = false
        current = dm.exportJSON()
        useRegistry.getState().bump()
      })

    const offChange = dm.on('change', () => {
      if (importing) return
      useRegistry.getState().bump()
      save()
      // coalesce a drag into one undo step
      if (recordTimer) clearTimeout(recordTimer)
      recordTimer = setTimeout(() => {
        const j = dm.exportJSON()
        if (j === current) return
        undoStack.push(current)
        if (undoStack.length > 100) undoStack.shift()
        current = j
        redoStack.length = 0
      }, 350)
    })
    undoRef.current = {
      undo: () => {
        const prev = undoStack.pop()
        if (prev === undefined) return
        redoStack.push(current)
        current = prev
        load(prev)
        save()
      },
      redo: () => {
        const next = redoStack.pop()
        if (next === undefined) return
        undoStack.push(current)
        current = next
        load(next)
        save()
      },
    }
    const offTool = dm.on('tool', (kind) => {
      const st = useTerminal.getState()
      if (kind === null && st.drawingTool !== null && st.active === index) st.setDrawingTool(null)
    })
    const offText = dm.on('textEdit', (d) => {
      const cur = (d as Drawing & { text?: string }).text ?? ''
      const text = window.prompt('Text', cur)
      if (text != null) dm.update({ ...d, text } as Drawing)
    })
    const offSel = dm.on('selection', () => useRegistry.getState().bump())
    return () => {
      offChange()
      offTool()
      offText()
      offSel()
      if (recordTimer) clearTimeout(recordTimer)
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

  // ---------------------------------------------- registry (outside access) --
  const resetView = () => {
    const chart = chartRef.current
    if (!chart) return
    chart.timeScale().resetTimeScale()
    chart.priceScale('right').applyOptions({ autoScale: true })
    chart.timeScale().scrollToRealTime()
  }

  const snapshot = async () => {
    const chart = chartRef.current
    if (!chart) return
    const shot = chart.takeScreenshot(true)
    const head = 30
    const out = document.createElement('canvas')
    out.width = shot.width
    out.height = shot.height + head
    const ctx = out.getContext('2d')!
    ctx.fillStyle = palette.bg
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(shot, 0, head)
    ctx.fillStyle = palette.text
    ctx.font = '600 14px -apple-system, Segoe UI, Roboto, sans-serif'
    const b = barsRef.current[barsRef.current.length - 1]
    ctx.fillText(`${pane.symbol} · ${pane.tf}${b ? ` · C ${b.close}` : ''}`, 10, 20)
    ctx.font = '12px -apple-system, Segoe UI, Roboto, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`OpenTerminal · ${new Date().toLocaleString()}`, out.width - 10, 20)
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'))
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `OpenTerminal_${pane.symbol.replace(/[^\w.-]+/g, '_')}_${pane.tf}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      toast('Snapshot saved', 'Downloaded and copied to the clipboard', 'success')
    } catch {
      toast('Snapshot saved', 'Downloaded as PNG', 'success')
    }
  }

  useEffect(() => {
    const chart = chartRef.current
    const main = mainRef.current
    const dm = drawRef.current
    if (!chart || !main || !dm) return
    return registerPane({
      paneId: pane.id,
      chart,
      main,
      drawings: dm,
      resetView,
      snapshot,
      undo: () => undoRef.current.undo(),
      redo: () => undoRef.current.redo(),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, pane.id, pane.symbol, pane.tf, theme])

  // -------------------------------- alert / order / prev-close price lines --
  const [prevClose, setPrevClose] = useState<number | null>(null)
  useEffect(() => {
    setPrevClose(null)
    if (!settings.prevClose || source.synthetic) return
    getStats([pane.symbol])
      .then(({ stats }) => setPrevClose(stats[0]?.prev_close ?? null))
      .catch(() => {})
  }, [pane.symbol, settings.prevClose, source])

  useEffect(() => {
    const main = mainRef.current
    if (!main) return
    for (const l of linesRef.current) main.removePriceLine(l)
    linesRef.current = []
    if (prevClose != null && settings.prevClose)
      linesRef.current.push(
        main.createPriceLine({ price: prevClose, color: '#787b86', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: 'Prev close' }),
      )
    for (const a of alerts) {
      if (a.symbol !== pane.symbol || !a.active || (a.kind ?? 'price') !== 'price') continue
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
  }, [alerts, paperPositions, paperOrders, pane.symbol, generation, prevClose, settings.prevClose])

  // --------------------------------------------- countdown to bar close ----
  useEffect(() => {
    const main = mainRef.current
    if (!main) return
    const secs = tfSeconds(pane.tf)
    if (!settings.countdown || timeless || !secs || secs > 86400) {
      main.applyOptions({ title: '' })
      return
    }
    const tick = () => {
      const last = barsRef.current[barsRef.current.length - 1]
      const left = last ? last.time + secs - Math.floor(Date.now() / 1000) : -1
      main.applyOptions({ title: replayIdx.current == null && left > 0 && left <= secs ? countdownText(left) : '' })
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [settings.countdown, timeless, pane.tf, generation])

  // -------------------------------------------- crosshair: legend + sync ----
  useEffect(() => {
    const chart = chartRef.current!
    let raf = 0
    const onMove = (param: MouseEventParams<Time>) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => updateLegend(param.time != null ? param : null))
      if (param.sourceEvent && useTerminal.getState().syncCrosshair && !timeless) broadcast(pane.id, (param.time as number) ?? null)
    }
    chart.subscribeCrosshairMove(onMove)
    const onSync: SyncListener = (from, time) => {
      if (from === pane.id || !mainRef.current || timeless) return
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
  }, [generation, syncCrosshair, pane.id, timeless])

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
    if (timeless || chartType === 'heikin') renderAll()
    else {
      const b = bars[replayIdx.current]
      mainRef.current?.update(seriesPoint(chartType, b, settingsRef.current) as never)
      volRef.current?.update({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? palette.volUp : palette.volDown })
      updateLegend(null)
    }
    recomputeIndicators(true)
  }

  // ---------------------------------------------------------- context menu --
  const onContextMenu = (e: React.MouseEvent) => {
    const chart = chartRef.current
    const main = mainRef.current
    const dm = drawRef.current
    if (!chart || !main || !dm) return
    e.preventDefault()
    const rect = containerRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const price = main.coordinateToPrice(y)
    const time = chart.timeScale().coordinateToTime(x)
    const drawingId = dm.hoveredId()
    if (useTerminal.getState().active !== index) useTerminal.getState().setActive(index)
    setMenu({ x, y, price: price == null ? null : Number(price), time: time == null ? null : (time as number), drawingId })
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
  const focus = () => useTerminal.getState().setActive(index)

  return (
    <div
      className={`chart-pane ${active ? 'active' : ''}`}
      onMouseDown={() => useTerminal.getState().active !== index && focus()}
      onContextMenu={onContextMenu}
    >
      <div ref={containerRef} className="chart-canvas" />
      <div className="legend">
        <div className="legend-row main">
          <span className="legend-sym">{pane.symbol}</span>
          <span className="legend-tf">· {pane.tf}{timeless ? ` · ${chartType}` : ''}</span>
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
        {(pane.compares ?? []).map((sym, i) => (
            <div key={sym} className="legend-row ind">
              <span className="legend-name" style={{ color: COMPARE_COLORS[i % COMPARE_COLORS.length] }}>{sym}</span>
              <span className="legend-actions">
                <button title="Remove compare" onClick={() => { focus(); useTerminal.getState().removeCompare(sym) }}>✕</button>
              </span>
            </div>
        ))}
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
                <button title={inst.hidden ? 'Show' : 'Hide'} onClick={() => { focus(); updateIndicator(inst.uid, { hidden: !inst.hidden }) }}>
                  {inst.hidden ? '◌' : '◉'}
                </button>
                <button title="Settings" onClick={() => { focus(); openDialog({ kind: 'indicatorSettings', uid: inst.uid }) }}>⚙</button>
                <button title="Remove" onClick={() => { focus(); removeIndicator(inst.uid) }}>✕</button>
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
      {menu && drawRef.current && (
        <ChartMenu menu={menu} pane={pane} paneId={pane.id} drawings={drawRef.current} onReset={resetView} onSnapshot={snapshot} onClose={() => setMenu(null)} />
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
