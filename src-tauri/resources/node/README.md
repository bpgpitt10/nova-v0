# Bundled Node runtime

Beta packaging expects a Windows Node runtime here:

```text
src-tauri/resources/node/node.exe
```

Prepare it with:

```powershell
powershell -ExecutionPolicy Bypass -File helpers/prepare_simread_resources_windows.ps1
```

`node.exe` is intentionally ignored by git.
