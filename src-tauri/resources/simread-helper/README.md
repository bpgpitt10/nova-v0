# SimRead helper resource

Beta packaging expects the compiled SimRead helper artifact in this directory:

```text
src-tauri/resources/simread-helper/
  dist/
  node_modules/
  package.json
  simread.cmd
```

Prepare it with:

```powershell
powershell -ExecutionPolicy Bypass -File helpers/prepare_simread_resources_windows.ps1
```

The generated artifact files are intentionally ignored by git.
