# Nova Stock Range Validation

Bare-bones local-first React + TypeScript validation app for the Nova golf shot tracking flow.

## Run

```sh
npm install
npm run dev
```

## Connecting to a Real Nova Device

Nova is discovered on the local network via mDNS, then exposed to the browser through a local WebSocket proxy. This is necessary because browsers cannot perform mDNS discovery or open raw TCP sockets.

### Option 1: All-in-one (recommended)

```sh
npm run dev:with-nova
```

This starts the discovery proxy in the background, waits for it to find Nova, then launches the dev server connected to it.

### Option 2: Separate terminals

Terminal 1 — start the discovery proxy:

```sh
npm run nova-proxy
```

Terminal 2 — start the browser app pointed at the proxy:

```sh
VITE_NOVA_WS_URL=ws://localhost:3100 npm run dev
```

### Option 3: Manual WebSocket URL

If you already know your Nova's WebSocket address (e.g. from your router's device list):

```sh
VITE_NOVA_WS_URL=ws://192.168.1.100:2920 npm run dev
```

### How discovery works

The proxy (`helpers/nova-discovery-proxy.mjs`) discovers Nova on the local network:

1. **mDNS**: Browses for `_openapi-nova._tcp` via `bonjour-service`, then falls back to `_openlaunch-ws._tcp`
2. **Connection**: Connects to Nova via TCP (OpenAPI) or WebSocket depending on what was discovered
3. **Bridge**: Forwards all shot data as WebSocket messages on `ws://localhost:3100`

Nova mDNS service types:

| Service | mDNS Type |
|---------|-----------|
| OpenAPI (TCP) | `_openapi-nova._tcp.local.` |
| WebSocket | `_openlaunch-ws._tcp.local.` |

### Data format mapping

When the proxy connects to Nova's OpenAPI (TCP) endpoint, it converts from the TCP JSON format to the WebSocket JSON format:

| OpenAPI/TCP field | WebSocket field | Conversion |
|---|---|---|
| `BallData.Speed` (mph) | `ball_speed_meters_per_second` | `* 0.44704` |
| `BallData.VLA` | `vertical_launch_angle_degrees` | direct |
| `BallData.HLA` | `horizontal_launch_angle_degrees` | direct |
| `BallData.TotalSpin` | `total_spin_rpm` | direct |
| `BallData.SpinAxis` | `spin_axis_degrees` | direct |
| `BallData.BackSpin` | `back_spin_rpm` | direct |
| `BallData.SideSpin` | `side_spin_rpm` | direct |

If the proxy discovers the WebSocket service directly, messages pass through unchanged.

## OpenGolfCoach enrichment

Shot enrichment runs directly in the browser via WebAssembly — no Python helper needed. The OpenGolfCoach WASM module is bundled in `src/lib/opengolfcoach-wasm/` and loads on first shot.

Every shot gets these derived values from raw launch monitor data:

- carry distance (yards)
- total distance (yards)
- offline distance (yards)
- shot name (e.g. "Straight", "Push Fade")
- shot rank (S+, S, A, B, C, D, E)

The Python helper (`helpers/open_golf_coach_helper.py`) is still available as an alternative if you prefer a local HTTP service, but it is no longer required.

## Nova API adapter

The app listens for live shots through `src/adapters/nova.ts`.

Architecture direction:

- Nova is the raw live shot source.
- OpenGolfCoach is planned as the derived-values engine, not as a data source.
- Mock mode remains available for local validation when Nova is not connected.

Current adapter paths:

- `src/adapters/nova.ts` — selects real WebSocket mode when `VITE_NOVA_WS_URL` is set or auto-connects to the local proxy at `ws://localhost:3100`, otherwise mock mode.
- `src/adapters/novaWebSocket.ts` — owns the real WebSocket JSON path.
- `src/adapters/mockNova.ts` — owns the mock shot feed.
- `helpers/nova-discovery-proxy.mjs` — discovers Nova via mDNS and bridges to WebSocket for the browser.
- `src/lib/openGolfCoach.ts` — runs OpenGolfCoach WASM in-browser for shot enrichment.

## OpenGolfCoach input

```ts
type OpenGolfCoachInput = {
  ball_speed_meters_per_second?: number
  vertical_launch_angle_degrees?: number
  horizontal_launch_angle_degrees?: number
  total_spin_rpm?: number
  spin_axis_degrees?: number
}
```

Derived output:

- carry distance (yards)
- total distance (yards)
- offline distance (yards)
- shot name
- shot rank
