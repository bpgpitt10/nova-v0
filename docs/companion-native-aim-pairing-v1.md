# Looper native companion — user pairing & Auto Aim command boundary (V1 specification)

**Status: designed, not enabled.** Target branch auto-aim-windows-companion-v1.
There is currently NO /companion/v1/aim command. Every POST /companion/* is
still rejected with HTTP 405. Origin allowlists and browser Local Network
Access permission alone are not authorization to move a user's mouse.

## Threat boundary

The hosted Looper browser tab is a potentially compromised/untrusted caller.
The Windows helper has desktop input capabilities. The default trust boundary
must remain **read-only**. Never give any website raw cursor/screen/file-write
operations, never bind to 0.0.0.0, and never accept CSRF-equivalent ambient
authorizations. Existing helper legacy /health, /wind, /lie, /derive endpoints
must be audited separately before sharing authentication policy with native
input routes.

## Proposed explicit pairing (not yet implemented)

1. Only a visible **native user-session** companion UI/tray control can initiate
   the one-time pairing. The website cannot invoke an unprotected HTTP endpoint
   that generates its own unrestricted authorization.
2. The companion generates a CSPRNG one-time human pairing code and displays it
   *locally* in the tray dialog for 60 seconds. It is tied to the origin that
   will be authorized and a fresh browser-initiated challenge; apply request
   rate limits and never place the code in GET /status or in browser logs.
3. The user enters that code in the Looper tab. The companion validates it over
   loopback, consumes it exactly once, then issues an unpredictable short-lived
   per-browser session token (~30 minutes), bound to the exact allowed Origin
   and native companion process. Store it in tab memory, not a URL, cookies,
   localStorage, or server logs. Rotate/revoke on uninstall, session reset or
   companion restart.
4. Every future native aim request must have Authorization: Bearer <session>
   AND exact allowed Origin, a one-time nonce, expiry <=5 seconds, a server-side
   fresh shot/hole identity and an exact recommendation revision. No cookies,
   permissive wildcard CORS or query-string tokens for input operations.
5. The companion computes GSPro pixels itself from its own fresh capture and
   verified native tee calibration; the browser may send only the recommendation
   intent (club, course+hole+shot+revision and desired verified aim location),
   never raw HWND/window coordinates, arbitrary screen coordinates, mouse
   button, key code, path, or free-form desktop action.
6. Validate that current GSPro PID/HWND/window rectangle, shot identity,
   calibration, target revision, pin error, course frame, active surface,
   capture age and input-enable state match. Never aim on a green or putt.
7. A visible per-shot Set Aim user gesture is mandatory for V1, even when
   paired. A successful response is only sent AFTER one native click and a
   NEW, nonstale magenta acceptance observation within 3 yards. Fail closed;
   never silently repeat mouse clicks.
8. Read-only Live Caddie must continue to work when the companion is absent,
   pairing expires, capture is stale or GSPro is not running.

## User experience / gate

After live native screenshot validation, install the companion once → open
Live Caddie → native discovery attaches without picking folders/windows →
pair once via tray code if user enables Auto Aim → click Set Aim for the current
recommended shot → show verified AIM SET or explicit MANUAL AIM.

Current Stage C release intentionally does NOT expose any of the above paired
POST endpoints. Build only after live simulator discovery/capture and course
coordinate equivalence have been independently verified. No mouse input in
CI or in the development website preview.
