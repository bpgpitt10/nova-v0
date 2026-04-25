import type { NovaAdapter, NovaConnection } from './nova'

export const mockNovaAdapter: NovaAdapter = {
  connectToShots(onShot, onStatusChange, onDebugEvent): NovaConnection {
    console.info('[Mock Nova] mock mode active')
    let shotNumber = 1
    let timer: number | null = null

    const emitShot = () => {
      const carryYards = 135 + Math.round(Math.random() * 25)
      const ballSpeedMph = 92 + Math.round(Math.random() * 14)
      const verticalLaunchAngleDegrees = 14 + Math.round(Math.random() * 6)
      const horizontalLaunchAngleDegrees = -4 + Math.round(Math.random() * 8)
      const totalSpinRpm = 6200 + Math.round(Math.random() * 800)
      const spinAxisDegrees = -12 + Math.round(Math.random() * 24)
      const shot = {
        id: `mock-${Date.now()}-${shotNumber}`,
        timestamp: new Date().toISOString(),
        ballSpeedMph,
        ball_speed_meters_per_second: Number((ballSpeedMph * 0.44704).toFixed(2)),
        carryYards,
        launchAngleDeg: verticalLaunchAngleDegrees,
        vertical_launch_angle_degrees: verticalLaunchAngleDegrees,
        horizontal_launch_angle_degrees: horizontalLaunchAngleDegrees,
        spinRpm: totalSpinRpm,
        total_spin_rpm: totalSpinRpm,
        spin_axis_degrees: spinAxisDegrees,
      }

      onDebugEvent?.({
        rawMessage: JSON.stringify(shot),
        normalizedShot: shot,
        openGolfCoachInput: null,
        openGolfCoachResponse: null,
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
        console.info('[Mock Nova] paused')
        stopTimer()
        onStatusChange?.('paused')
      },
      resume: () => {
        console.info('[Mock Nova] resumed')
        if (timer === null) {
          startTimer()
        }
        onStatusChange?.('connected')
      },
      disconnect: () => {
        console.info('[Mock Nova] disconnected')
        stopTimer()
        onStatusChange?.('disconnected')
      },
    }
  },
}
