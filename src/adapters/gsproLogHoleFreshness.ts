// GSPro's output_log sometimes carries "currentHole" lines, and they are only
// useful when they were written AFTER the latest shot in currentRound.dat
// ("the player has walked to the next tee"). A line left over from an earlier
// round in the same GSPro session is not: on 15 Nov a player's log still said
// hole 18 while he played holes 1-5 of a new round, and Live Caddie waited on a
// tee for the whole round.
//
// The log is append-only, so "written after" is a byte position: every marker
// before the log's size at the moment the latest shot appeared is stale.

export type LogHoleBoundary = {
  /** Identity of the latest shot when the boundary was last moved. */
  shotIdentity: string | null
  /** Markers before this byte offset in output_log are stale. */
  staleBeforeOffset: number
  /** The log's size at the previous read (a smaller size means a new log). */
  lastLogSize: number
}

/**
 * Move the boundary for this read. On the first read everything already in the
 * log is of unknown age, so it counts as stale; after that the boundary moves
 * up to the log's current end whenever a new shot (or a new round) appears.
 */
export const advanceLogHoleBoundary = (
  previous: LogHoleBoundary | null,
  shotIdentity: string | null,
  logSize: number,
): LogHoleBoundary => {
  if (!previous) return { shotIdentity, staleBeforeOffset: logSize, lastLogSize: logSize }
  // GSPro restarted and started a new log: nothing in it predates this session.
  if (logSize < previous.lastLogSize) return { shotIdentity, staleBeforeOffset: 0, lastLogSize: logSize }
  if (shotIdentity !== previous.shotIdentity) {
    return { shotIdentity, staleBeforeOffset: logSize, lastLogSize: logSize }
  }
  return { ...previous, lastLogSize: logSize }
}

/** Was the log's latest hole marker written after the latest shot? */
export const logHoleMarkerIsFresh = (
  boundary: LogHoleBoundary,
  tailStartOffset: number,
  markerIndexInTail: number | null,
) => markerIndexInTail != null
  && markerIndexInTail >= 0
  && tailStartOffset + markerIndexInTail >= boundary.staleBeforeOffset
