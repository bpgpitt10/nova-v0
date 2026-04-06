import type { NovaAdapter, NovaConnection } from './nova'

export const mockNovaAdapter: NovaAdapter = {
  connectToShots(onShot, onStatusChange, onDebugEvent): NovaConnection {
    let shotNumber = 1
    let timer: number | null = null

    const emitShot = () => {
      const carryYards = 135 + Math.round(Math.random() * 25)
      const shot = {
        id: `mock-${Date.now()}-${shotNumber}`,
        timestamp: new Date().toISOString(),
        ballSpeedMph: 92 + Math.round(Math.random() * 14),
        carryYards,
        launchAngleDeg: 14 + Math.round(Math.random() * 6),
        spinRpm: 6200 + Math.round(Math.random() * 800),
      }

      onDebugEvent?.({
        rawMessage: JSON.stringify(shot),
        normalizedShot: shot,
      })

      onShot(shot)
      shotNumber += 1
    }

    const startTimer = () => {
      timer = window.setInterval(emitShot, 3500)
    }

    const stopTimer = () => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }

    startTimer()
    window.queueMicrotask(() => onStatusChange?.('connected'))

    return {
      mode: 'mock',
      pause: () => {
        stopTimer()
        onStatusChange?.('paused')
      },
      resume: () => {
        if (timer === null) {
          startTimer()
        }
        onStatusChange?.('connected')
      },
      disconnect: () => {
        stopTimer()
        onStatusChange?.('disconnected')
      },
    }
  },
}
