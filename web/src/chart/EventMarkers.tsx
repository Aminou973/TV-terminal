import { useEffect, useRef, useState } from 'react'
import { createSeriesMarkers, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type SeriesType, type Time } from 'lightweight-charts'
import { getMarketEvents, type MarketEvent } from '../api/client'

const STYLE: Record<MarketEvent['kind'], { color: string; text: string }> = {
  earnings: { color: '#ff9800', text: 'E' },
  dividend: { color: '#2962ff', text: 'D' },
  split: { color: '#9c27b0', text: 'S' },
}

/** Earnings / dividend / split markers under the bars they fall in. */
export default function EventMarkers({ series, symbol, generation, dataVersion, getBars }: {
  series: ISeriesApi<SeriesType> | null
  symbol: string
  generation: number
  dataVersion: number
  getBars: () => { time: number }[] | null
}) {
  const [events, setEvents] = useState<MarketEvent[]>([])
  const pluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)

  useEffect(() => {
    let alive = true
    setEvents([])
    getMarketEvents(symbol).then((r) => alive && setEvents(r.events)).catch(() => {})
    return () => {
      alive = false
    }
  }, [symbol])

  useEffect(() => {
    if (!series) return
    pluginRef.current = createSeriesMarkers(series, [])
    return () => {
      try {
        pluginRef.current?.detach()
      } catch {
        /* series gone */
      }
      pluginRef.current = null
    }
  }, [series, generation])

  useEffect(() => {
    const plugin = pluginRef.current
    const bars = getBars()
    if (!plugin) return
    if (!bars?.length || !events.length) return plugin.setMarkers([])
    const first = bars[0].time
    const last = bars[bars.length - 1].time
    const marks: SeriesMarker<Time>[] = []
    for (const e of events) {
      if (e.upcoming || e.time < first || e.time > last + 86400) continue
      // the bar containing the event: last bar opening at or before it
      let lo = 0
      let hi = bars.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (bars[mid].time <= e.time) lo = mid
        else hi = mid - 1
      }
      const st = STYLE[e.kind]
      marks.push({ time: bars[lo].time as Time, position: 'belowBar', shape: 'circle', color: st.color, text: st.text, size: 1, id: `${e.kind}-${e.time}` })
    }
    marks.sort((a, b) => (a.time as number) - (b.time as number))
    plugin.setMarkers(marks)
  }, [events, dataVersion, generation, getBars])

  return null
}
