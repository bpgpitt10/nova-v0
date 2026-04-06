# Nova Stock Range Validation

Bare-bones local-first React + TypeScript validation app for the Nova golf shot tracking flow.

## Run

```sh
npm install
npm run dev
```

## Nova API adapter

The app listens for live shots through `src/adapters/nova.ts`.

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

Expected real WebSocket flow:

1. Discover Nova's `_openlaunch-ws._tcp.local.` service outside the browser app, or manually provide the local WebSocket URL as `VITE_NOVA_WS_URL`.
2. Start the app.
3. Start a Stock Range Session.
4. The app opens a receive-only WebSocket connection to the configured URL.
5. Nova sends JSON messages.
6. The adapter parses JSON conservatively and maps only known fields: `timestamp`, `carry`, `total`, `offline`, `spin`, `vla`, and `shotRanking`.
7. Unknown fields are logged in development only.

Still unknown before replacing mock mode:

- Exact shot payload schema beyond `timestamp`, `carry`, `total`, `offline`, `spin`, `vla`, and `shotRanking`
- Exact message envelope for the WebSocket and TCP APIs
- Whether browser-side mDNS discovery is realistic
- Whether a small local helper/proxy is needed to handle mDNS discovery and/or TCP JSON
