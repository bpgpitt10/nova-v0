import { buildGreywolfCourseDecisionAudit } from '../liveCaddie/greywolfDecisionAudit'
import type { SavedSession } from '../types'

type AuditWorkerRequest = {
  sessions: SavedSession[]
}

type AuditWorkerResponse =
  | {
      type: 'success'
      result: Awaited<ReturnType<typeof buildGreywolfCourseDecisionAudit>>
    }
  | {
      type: 'error'
      error: string
    }

self.onmessage = async (event: MessageEvent<AuditWorkerRequest>) => {
  try {
    const result = await buildGreywolfCourseDecisionAudit(event.data.sessions)
    const response: AuditWorkerResponse = { type: 'success', result }
    self.postMessage(response)
  } catch (cause) {
    const response: AuditWorkerResponse = {
      type: 'error',
      error: cause instanceof Error ? cause.message : String(cause),
    }
    self.postMessage(response)
  }
}

export {}
