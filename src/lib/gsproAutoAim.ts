import { invoke } from '@tauri-apps/api/core'

export type GsproAutoAimResult = {
  ok: boolean
  status: string
  stdout: string
  stderr: string
  vectorErrorYds: number | null
}

export const isGsproAutoAimDesktopAvailable = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const calibrateGsproAutoAimTee = (input: {
  courseId: string
  holeNumber: number
  par: number
  teeX: number
  teeY: number
  monitor?: number
}) => invoke<GsproAutoAimResult>('gspro_auto_aim_calibrate_tee', {
  ...input,
  monitor: input.monitor ?? 1,
})

export const clickGsproAutoAimTarget = (input: {
  courseId: string
  holeNumber: number
  pinX: number
  pinY: number
  targetX: number
  targetY: number
  monitor?: number
}) => invoke<GsproAutoAimResult>('gspro_auto_aim_target', {
  ...input,
  monitor: input.monitor ?? 1,
})
