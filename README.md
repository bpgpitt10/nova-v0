# Nova Stock Range Validation

Bare-bones local-first React + TypeScript validation app for the Nova golf shot tracking flow.

## Run

```sh
npm install
npm run dev
```

## Connecting to a Real Nova Device

Nova is discovered on the local network via SSDP and mDNS, then exposed to the browser through a local WebSocket proxy. This is necessary because browsers cannot perform mDNS discovery or open raw TCP sockets.

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

The proxy (`helpers/nova-discovery-proxy.mjs`) follows the same pattern used by the reference Electron integration:

1. **SSDP (primary)**: Sends a multicast M-SEARCH to `239.255.255.250:1900` looking for `urn:openlaunch:service:openapi:1` or `urn:openlaunch:service:websocket:1`
2. **mDNS (fallback)**: If SSDP times out after 5 seconds, browses for `_openapi-nova._tcp` or `_openlaunch-ws._tcp` via `bonjour-service`
3. **Connection**: Connects to Nova via TCP (OpenAPI) or WebSocket depending on what was discovered
4. **Bridge**: Forwards all shot data as WebSocket messages on `ws://localhost:3100`

Nova service types:

| Protocol | OpenAPI Service | WebSocket Service |
|----------|-----------------|-------------------|
| mDNS | `_openapi-nova._tcp.local.` | `_openlaunch-ws._tcp.local.` |
| SSDP | `urn:openlaunch:service:openapi:1` | `urn:openlaunch:service:websocket:1` |

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

## OpenGolfCoach helper

The smallest local OpenGolfCoach integration in this repo is a tiny Python helper:

- file: `helpers/open_golf_coach_helper.py`
- endpoint: `POST /derive`
- default address: `http://127.0.0.1:8787`

Install and start it locally:

```sh
python3 -m pip install opengolfcoach
python3 helpers/open_golf_coach_helper.py
```

Point the browser app at it with:

```sh
VITE_OPEN_GOLF_COACH_URL=http://127.0.0.1:8787 npm run dev
```

How the browser app finds it:

- the app reads `VITE_OPEN_GOLF_COACH_URL`
- if that env var is missing, the `openGolfCoachEnricher` returns empty derived values
- if it is set, the app posts normalized OpenGolfCoach input JSON to `/derive`
- if the helper fails, shot capture continues without enrichment

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
- `helpers/nova-discovery-proxy.mjs` — discovers Nova via SSDP/mDNS and bridges to WebSocket for the browser.
- `src/lib/openGolfCoach.ts` — defines the placeholder OpenGolfCoach enrichment boundary.

## OpenGolfCoach enrichment plan

OpenGolfCoach should be treated as a downstream enrichment step over normalized raw shot inputs.

Normalized input shape:

```ts
type OpenGolfCoachInput = {
  ball_speed_meters_per_second?: number
  vertical_launch_angle_degrees?: number
  horizontal_launch_angle_degrees?: number
  total_spin_rpm?: number
  spin_axis_degrees?: number
}
```

Target derived values:

- carry distance
- total distance
- offline distance
- shot name
- shot rank
