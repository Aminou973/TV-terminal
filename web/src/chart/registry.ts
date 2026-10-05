import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts'
import type { DrawingManager } from 'lightweight-charts-drawing'
import { create } from 'zustand'

// Live handles of the mounted chart panes, for panels and dialogs that act on
// a chart from outside it (object tree, drawing settings, hotkeys, snapshots).

export interface PaneHandle {
  paneId: string
  chart: IChartApi
  main: ISeriesApi<SeriesType>
  drawings: DrawingManager
  resetView: () => void
  snapshot: () => Promise<void>
  undo: () => void
  redo: () => void
}

const handles = new Map<string, PaneHandle>()

/** Bumped whenever a pane registers or its drawings change (re-render hook). */
export const useRegistry = create<{ version: number; bump: () => void }>((set, get) => ({
  version: 0,
  bump: () => set({ version: get().version + 1 }),
}))

export function registerPane(h: PaneHandle): () => void {
  handles.set(h.paneId, h)
  useRegistry.getState().bump()
  return () => {
    if (handles.get(h.paneId) === h) handles.delete(h.paneId)
    useRegistry.getState().bump()
  }
}

export const getPane = (paneId: string | undefined) => (paneId ? handles.get(paneId) : undefined)
