import { useEffect, useRef } from 'react'
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type LineWidth,
  type UTCTimestamp,
} from 'lightweight-charts'
import { getHistory } from '../api/client'
import { stream } from './stream'
import { useTerminal } from '../store'

// TV-like dark theme
const CHART_OPTIONS = {
  layout: {
    background: { type: ColorType.Solid, color: '#131722' },
    textColor: '#d1d4dc',
    attributionLogo: true, // Apache-2.0 requirement — keep enabled
    panes: { separatorColor: '#2a2e39', separatorHoverColor: '#2962ff' },
  },
  grid: {
    vertLines: { color: '#1e222d' },
    horzLines: { color: '#1e222d' },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: '#758696', width: 1 as LineWidth, style: 2, labelBackgroundColor: '#363a45' },
    horzLine: { color: '#758696', width: 1 as LineWidth, style: 2, labelBackgroundColor: '#363a45' },
  },
  rightPriceScale: { borderColor: '#2a2e39' },
  timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false },
}

const CANDLE_OPTIONS = {
  upColor: '#089981',
  downColor: '#f23645',
  borderUpColor: '#089981',
  borderDownColor: '#f23645',
  wickUpColor: '#089981',
  wickDownColor: '#f23645',
}

export default function ChartView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)

  const symbol = useTerminal((s) => s.symbol)
  const tf = useTerminal((s) => s.tf)

  // create the chart once
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, CHART_OPTIONS)
    chartRef.current = chart

    candleRef.current = chart.addSeries(CandlestickSeries, CANDLE_OPTIONS)
    volumeRef.current = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: '#26a69a' },
      0,
    )
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    chart.timeScale().fitContent()

    const resize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight })
    }
    window.addEventListener('resize', resize)
    resize()

    return () => {
      window.removeEventListener('resize', resize)
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
  }, [])

  // load history + attach the live stream whenever symbol/tf changes
  useEffect(() => {
    const candles = candleRef.current
    const volume = volumeRef.current
    const chart = chartRef.current
    if (!candles || !volume || !chart) return

    let stale = false
    getHistory(symbol, tf)
      .then(({ bars }) => {
        if (stale) return
        candles.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })))
        volume.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? '#26a69a80' : '#ef535080' })))
        chart.timeScale().fitContent()
      })
      .catch((err) => console.error('history load failed:', err))

    const off = stream.subscribeBars(symbol, tf, (msg) => {
      const b = msg.bar
      candles.update({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })
      volume.update({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? '#26a69a80' : '#ef535080' })
    })

    return () => {
      stale = true
      off()
    }
  }, [symbol, tf])

  return <div ref={containerRef} className="chart-container" />
}