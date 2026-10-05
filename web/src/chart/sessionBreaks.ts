import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts'

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0]

/** Dotted vertical lines at the first bar of each trading session. */
export class SessionBreaks implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null
  private request: (() => void) | null = null
  private times: number[] = []
  private color = 'rgba(120,123,134,0.45)'

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart
    this.request = p.requestUpdate
  }

  detached() {
    this.chart = null
    this.request = null
  }

  set(times: number[], color: string) {
    this.times = times
    this.color = color
    this.request?.()
  }

  updateAllViews() {}

  paneViews(): IPrimitivePaneView[] {
    const view: IPrimitivePaneView = {
      zOrder: () => 'bottom',
      renderer: () => ({
        draw: (target: DrawTarget) => {
          const chart = this.chart
          if (!chart || !this.times.length) return
          const ts = chart.timeScale()
          target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio }) => {
            ctx.save()
            ctx.strokeStyle = this.color
            ctx.lineWidth = Math.max(1, Math.round(horizontalPixelRatio))
            ctx.setLineDash([4 * horizontalPixelRatio, 4 * horizontalPixelRatio])
            for (const t of this.times) {
              const x = ts.timeToCoordinate(t as Time)
              if (x == null) continue
              const px = Math.round(x * horizontalPixelRatio) + 0.5
              ctx.beginPath()
              ctx.moveTo(px, 0)
              ctx.lineTo(px, bitmapSize.height)
              ctx.stroke()
            }
            ctx.restore()
          })
        },
      }),
    }
    return [view]
  }
}
