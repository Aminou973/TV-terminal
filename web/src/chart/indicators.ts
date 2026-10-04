import {
  AreaSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { IndicatorRegistryEntry } from 'lightweight-charts-indicators'
import type { BarData } from '../api/client'

// ---------------------------------------------------------------------------
// Indicator definitions come from two places: the bundled registry (hundreds
// of TradingView-compatible indicators) and user scripts (run in a worker,
// see scripts/runtime.ts). Both produce the same output shape.
// ---------------------------------------------------------------------------

export interface PlotSpec {
  id: string
  title: string
  color: string
  lineWidth?: number
  style?: string
  display?: string
  histbase?: number
  linestyle?: 'solid' | 'dashed' | 'dotted'
}

export interface HLineSpec {
  id: string
  price: number
  title?: string
  color?: string
  linestyle?: 'solid' | 'dashed' | 'dotted'
  linewidth?: number
}

export interface InputSpec {
  id: string
  type: string
  defval: unknown
  title?: string
  min?: number
  max?: number
  step?: number
  options?: string[]
}

export interface PlotPoint {
  time: number
  value: number | null
  color?: string
}

export interface MarkerSpec {
  time: number
  position: string
  shape: string
  color: string
  text?: string
  price?: number
}

export interface IndicatorOutput {
  plots: Record<string, PlotPoint[]>
  markers?: MarkerSpec[]
}

export interface IndicatorDef {
  key: string
  name: string
  shortName: string
  category: string
  /** registry group ('standard' | 'community' | 'candlestick') or 'script' */
  group: string
  overlay: boolean
  inputs: InputSpec[]
  plots: PlotSpec[]
  hlines: HLineSpec[]
  defaults: Record<string, unknown>
  compute: (bars: BarData[], inputs: Record<string, unknown>) => IndicatorOutput | Promise<IndicatorOutput>
}

// ------------------------------------------------------------ registry -----
let registryPromise: Promise<IndicatorDef[]> | null = null

/** The indicator library is large — load it on demand (own chunk). */
export function loadRegistry(): Promise<IndicatorDef[]> {
  registryPromise ??= import('lightweight-charts-indicators').then((m) =>
    m.indicatorRegistry.map(fromRegistry),
  )
  return registryPromise
}

function fromRegistry(e: IndicatorRegistryEntry): IndicatorDef {
  return {
    key: e.id,
    name: e.name,
    shortName: e.shortName,
    category: e.category,
    group: e.group,
    overlay: e.overlay,
    inputs: e.inputConfig as InputSpec[],
    plots: e.plotConfig as PlotSpec[],
    hlines: (e.hlineConfig ?? []) as HLineSpec[],
    defaults: e.defaultInputs,
    compute: (bars, inputs) => {
      const r = e.calculate(bars as never, { ...e.defaultInputs, ...inputs })
      return { plots: r.plots ?? {}, markers: r.markers }
    },
  }
}

// ---------------------------------------------------------------- layer ----
const TRANSPARENT = /^(transparent|#[0-9a-f]{6}00|rgba\(.*,\s*0\))$/i

function lineStyle(s?: string): LineStyle {
  return s === 'dashed' ? LineStyle.Dashed : s === 'dotted' ? LineStyle.Dotted : LineStyle.Solid
}

function markerShape(shape: string): SeriesMarker<Time>['shape'] {
  if (shape === 'arrowUp' || shape === 'labelUp' || shape === 'triangleUp') return 'arrowUp'
  if (shape === 'arrowDown' || shape === 'labelDown' || shape === 'triangleDown') return 'arrowDown'
  if (shape === 'square' || shape === 'diamond' || shape === 'flag') return 'square'
  return 'circle'
}

function markerPosition(m: MarkerSpec): SeriesMarker<Time>['position'] {
  if (m.price != null && (m.position === 'atPriceTop' || m.position === 'atPriceBottom' || m.position === 'atPriceMiddle'))
    return m.position
  if (m.position === 'belowBar' || m.position === 'bottom' || m.position === 'atPriceBottom') return 'belowBar'
  if (m.position === 'inBar' || m.position === 'atPriceMiddle') return 'inBar'
  return 'aboveBar'
}

export class IndicatorLayer {
  readonly series: { plot: PlotSpec; api: ISeriesApi<SeriesType> }[] = []
  private priceLines: { api: ISeriesApi<SeriesType>; line: IPriceLine }[] = []
  private markers: ISeriesMarkersPluginApi<Time> | null = null
  private seq = 0

  constructor(
    private chart: IChartApi,
    private main: ISeriesApi<SeriesType>,
    readonly def: IndicatorDef,
    readonly inputs: Record<string, unknown>,
    paneIndex: number,
    visible: boolean,
  ) {
    const pane = def.overlay ? 0 : paneIndex
    for (const plot of def.plots) {
      if (plot.display === 'none' || TRANSPARENT.test(plot.color)) continue
      const common = { lastValueVisible: !def.overlay, priceLineVisible: false, visible, title: '' }
      const width = Math.max(1, Math.min(4, plot.lineWidth ?? 1)) as 1 | 2 | 3 | 4
      let api: ISeriesApi<SeriesType>
      switch (plot.style) {
        case 'histogram':
        case 'columns':
          api = chart.addSeries(HistogramSeries, { ...common, color: plot.color, base: plot.histbase ?? 0 }, pane)
          break
        case 'area':
        case 'areabr':
          api = chart.addSeries(
            AreaSeries,
            { ...common, lineColor: plot.color, topColor: `${plot.color.slice(0, 7)}55`, bottomColor: `${plot.color.slice(0, 7)}00`, lineWidth: width },
            pane,
          )
          break
        case 'circles':
        case 'cross':
        case 'stepline_diamond':
          api = chart.addSeries(
            LineSeries,
            { ...common, color: plot.color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2, crosshairMarkerVisible: false },
            pane,
          )
          break
        default:
          api = chart.addSeries(
            LineSeries,
            {
              ...common,
              color: plot.color,
              lineWidth: width,
              lineStyle: lineStyle(plot.linestyle),
              lineType: plot.style?.startsWith('step') ? LineType.WithSteps : LineType.Simple,
              crosshairMarkerVisible: false,
            },
            pane,
          )
      }
      this.series.push({ plot, api })
    }
    const host = this.series[0]?.api ?? (def.overlay ? main : null)
    if (host) {
      for (const h of def.hlines) {
        if (h.color && TRANSPARENT.test(h.color)) continue
        const line = host.createPriceLine({
          price: h.price,
          color: h.color ?? '#787b86',
          lineStyle: lineStyle(h.linestyle ?? 'dashed'),
          lineWidth: 1,
          axisLabelVisible: false,
          title: '',
        })
        this.priceLines.push({ api: host, line })
      }
    }
  }

  /** Recompute on the full bar set; ignores results that arrive out of order. */
  async update(bars: BarData[]): Promise<void> {
    const seq = ++this.seq
    let out: IndicatorOutput
    try {
      out = await this.def.compute(bars, this.inputs)
    } catch (err) {
      console.warn(`indicator ${this.def.key} failed:`, err)
      return
    }
    if (seq !== this.seq || this.destroyed) return
    for (const { plot, api } of this.series) {
      const pts = out.plots[plot.id] ?? []
      api.setData(
        pts.map((p) =>
          p.value == null || !Number.isFinite(p.value)
            ? { time: p.time as UTCTimestamp }
            : p.color && !TRANSPARENT.test(p.color)
              ? { time: p.time as UTCTimestamp, value: p.value, color: p.color }
              : { time: p.time as UTCTimestamp, value: p.value },
        ),
      )
    }
    if (out.markers?.length) {
      const host = this.def.overlay ? this.main : (this.series[0]?.api ?? this.main)
      const markers = out.markers
        .map((m) => {
          const position = markerPosition(m)
          const base = { time: m.time as UTCTimestamp, shape: markerShape(m.shape), color: m.color, text: m.text }
          return position.startsWith('atPrice')
            ? ({ ...base, position, price: m.price! } as SeriesMarker<Time>)
            : ({ ...base, position } as SeriesMarker<Time>)
        })
        .sort((a, b) => (a.time as number) - (b.time as number))
      if (this.markers) this.markers.setMarkers(markers)
      else this.markers = createSeriesMarkers(host, markers)
    } else {
      this.markers?.setMarkers([])
    }
  }

  setVisible(v: boolean) {
    for (const { api } of this.series) api.applyOptions({ visible: v })
  }

  private destroyed = false

  destroy() {
    this.destroyed = true
    this.markers?.detach()
    for (const { api, line } of this.priceLines) {
      try {
        api.removePriceLine(line)
      } catch {
        /* series already gone */
      }
    }
    for (const { api } of this.series) this.chart.removeSeries(api)
    this.series.length = 0
  }
}

/** Short label like "RSI 14 close" for the legend. */
export function indicatorLabel(def: IndicatorDef, inputs: Record<string, unknown>): string {
  const vals = def.inputs
    .filter((i) => (i.type === 'int' || i.type === 'float' || i.type === 'source') && !/offset/i.test(i.id))
    .slice(0, 3)
    .map((i) => String(inputs[i.id] ?? i.defval))
  return [def.shortName, ...vals].join(' ')
}
