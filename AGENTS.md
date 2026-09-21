# Looper architecture: WEB APP ONLY

This repository is a browser-delivered web application. Treat that as a hard architectural constraint.

## Forbidden

- Do not add, restore, or use Tauri.
- Do not add Electron or any other native desktop shell.
- Do not add Rust/native app wrappers for the Looper UI.
- Do not use `@tauri-apps/*`, `src-tauri/`, Tauri commands/events/plugins, or Tauri sidecars.
- Do not make browser features depend on a desktop wrapper, native window lifecycle, updater, installer, or bundled executable.
- Do not solve browser limitations by silently converting Looper into a desktop application.

## Required architecture

- The Looper UI and application runtime must remain a normal web app that runs in the browser.
- Browser code should use ordinary web APIs and HTTP/WebSocket/SSE endpoints.
- When GSPro or Windows-local data cannot be read directly by the browser, expose it through a separately run local service (for example `http://127.0.0.1:<port>` or WebSocket) with appropriate CORS/security, then consume that service from the web app.
- Local helper processes may exist only as independent services. They are never bundled as a Tauri/Electron sidecar and never become the application shell.
- Features must degrade to `UNKNOWN`/`UNAVAILABLE` when a local signal is absent; they must not require a native wrapper to keep the app running.

## Review rule

Any proposal, code change, dependency, script, workflow, or documentation that introduces a native desktop shell is an architecture violation and must be rejected or redesigned as web + service before merge.
