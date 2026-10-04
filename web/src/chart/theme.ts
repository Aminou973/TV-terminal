import { ColorType, CrosshairMode, LineStyle, type DeepPartial, type ChartOptions } from 'lightweight-charts'

export interface ChartPalette {
  bg: string
  text: string
  grid: string
  border: string
  crosshair: string
  label: string
  up: string
  down: string
  volUp: string
  volDown: string
}

export const PALETTES: Record<'dark' | 'light', ChartPalette> = {
  dark: {
    bg: '#131722', text: '#d1d4dc', grid: '#1e222d', border: '#2a2e39', crosshair: '#758696',
    label: '#363a45', up: '#089981', down: '#f23645', volUp: '#26a69a66', volDown: '#ef535066',
  },
  light: {
    bg: '#ffffff', text: '#131722', grid: '#f0f3fa', border: '#e0e3eb', crosshair: '#9598a1',
    label: '#4c525e', up: '#089981', down: '#f23645', volUp: '#26a69a55', volDown: '#ef535055',
  },
}

export function chartOptions(p: ChartPalette): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: p.bg },
      textColor: p.text,
      attributionLogo: true, // Apache-2.0 requirement — keep enabled
      panes: { separatorColor: p.border, separatorHoverColor: '#2962ff55', enableResize: true },
    },
    grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: p.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: p.label },
      horzLine: { color: p.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: p.label },
    },
    rightPriceScale: { borderColor: p.border },
    timeScale: { borderColor: p.border, timeVisible: true, secondsVisible: false, rightOffset: 8 },
  }
}
