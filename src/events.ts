// Run events in one process: package D publishes a run's start, cells and end; status, hooks and the colab.runs source
// subscribe. A listener that throws never stops the others or the publisher.
import type { RunEvent, RunEvents } from "./ports.js"

export function createRunEvents(): RunEvents {
  const listeners = new Set<(event: RunEvent) => void>()
  return {
    publish(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          // A subscriber's failure is its own.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
