/// <reference lib="webworker" />
import { runScript, type Bar } from './engine'

interface Job {
  id: number
  source: string
  bars: Bar[]
  inputs: Record<string, unknown>
  pointValue?: number
  strategy?: Record<string, number | boolean>
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, source, bars, inputs, pointValue, strategy } = e.data
  try {
    const result = runScript(source, bars, inputs, { pointValue, strategy })
    self.postMessage({ id, ok: true, result })
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    self.postMessage({ id, ok: false, error: msg })
  }
}
