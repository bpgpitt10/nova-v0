# Nova Stock Range Validation

Bare-bones local-first React + TypeScript validation app for the Nova golf shot tracking flow.

## Run

```sh
npm install
npm run dev
```

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

Known Nova integration details from the developer guide:

- Nova exposes two local receive-only JSON APIs for shot data.
- Primary real-mode target for this browser app: local WebSocket JSON.
- Secondary/future target: local OpenAPI-over-TCP JSON, likely through a helper/proxy because browsers cannot open arbitrary TCP sockets directly.
- Nova advertises local services over mDNS:
  - WebSocket JSON: `_openlaunch-ws._tcp.local.`
  - TCP JSON: `_openapi-nova._tcp.local.`

Set this environment variable when connecting to a discovered local Nova WebSocket endpoint:

```sh
VITE_NOVA_WS_URL=ws://nova-local-host:port/path
```

If neither value is present, the adapter uses the Mock Nova Feed so the local session model can still be validated.

Current adapter paths:

- `src/adapters/nova.ts` selects real WebSocket mode when `VITE_NOVA_WS_URL` is set, otherwise mock mode.
- `src/adapters/novaWebSocket.ts` owns the real local WebSocket JSON path.
- `src/adapters/mockNova.ts` owns the mock shot feed.
- `src/lib/openGolfCoach.ts` defines the placeholder OpenGolfCoach enrichment boundary.

Expected real WebSocket flow:

1. Discover Nova's `_openlaunch-ws._tcp.local.` service outside the browser app, or manually provide the local WebSocket URL as `VITE_NOVA_WS_URL`.
2. Start the app.
3. Start a Stock Range Session.
4. The app opens a receive-only WebSocket connection to the configured URL.
5. Nova sends JSON messages.
6. The adapter parses JSON conservatively and maps only known fields: `timestamp`, `carry`, `total`, `offline`, `spin`, `vla`, and `shotRanking`.
7. Unknown fields are logged in development only.

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

Current placeholder module:

- `src/lib/openGolfCoach.ts`

Easiest integration path:

1. Browser-side wasm/js binding:
   best if OpenGolfCoach already ships a browser-safe JS or WASM API and can run directly in Vite without native dependencies.
2. Tiny local helper/service:
   best if OpenGolfCoach needs native bindings, local files, or process isolation; the browser app would send normalized inputs to the helper and receive derived values back.

The browser-side binding is the easiest path if it exists and runs cleanly in the browser. A tiny local helper is the safer fallback if OpenGolfCoach is not browser-native.

Still unknown before replacing mock mode:

- Exact mapping from Nova raw payload fields into `OpenGolfCoachInput`
- Exact units and sign conventions for horizontal launch angle and spin axis
- Whether OpenGolfCoach is available as a browser-safe JS/WASM package
- Whether a tiny local helper/service is needed for OpenGolfCoach execution
- Exact shot payload schema beyond `timestamp`, `carry`, `total`, `offline`, `spin`, `vla`, and `shotRanking`
- Exact message envelope for the WebSocket and TCP APIs
- Whether browser-side mDNS discovery is realistic
- Whether a small local helper/proxy is needed to handle mDNS discovery and/or TCP JSON
