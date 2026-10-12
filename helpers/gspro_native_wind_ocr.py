"""Windows-only read-only wind OCR from the *native GSPro HWND capture*, not desktop.

Reuses the existing tested parse_wind_ocr_text convention, but captures no
desktop pixels. A bounded, temporary HUD-only PNG is deleted in finally.
Actual WinRT OCR with GSPro foreground/background still requires sim validation.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile

import cv2
import numpy as np

import gspro_window_capture as native_capture
from open_golf_coach_helper import parse_wind_ocr_text, utc_now_iso

# Windows Powershell 5.1 WinRT await must use AsTask(IAsyncOperation<T>).
# The earlier GetMember("GetAwaiter").Where(...)[0] was null on the sim PC.
# No CopyFromScreen, screenshots returned to browser, or desktop input.
WINRT_WIND_OCR_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$fileStream = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Foundation.IAsyncOperation`1, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

  $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
  if ($null -eq $asTaskMethod) { throw 'WinRT_AsTask_IAsyncOperation_unavailable' }

  function Await-WinRT($operation, [Type]$resultType) {
    if ($null -eq $operation) { throw 'WinRT_null_async_operation' }
    $task = $asTaskMethod.MakeGenericMethod(@($resultType)).Invoke($null, @($operation))
    if ($null -eq $task) { throw 'WinRT_null_task' }
    return $task.GetAwaiter().GetResult()
  }

  $path = $env:LOOPER_WIND_OCR_IMAGE
  if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw 'Wind_HUD_image_unavailable'
  }
  $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $ocrEngine) { throw 'Windows_OCR_engine_unavailable' }

  $storageFile = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $fileStream = Await-WinRT ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($fileStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await-WinRT ($ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  [PSCustomObject]@{ status = 'ok'; rawText = $result.Text } | ConvertTo-Json -Compress -Depth 3
} catch {
  [PSCustomObject]@{ status = 'error'; note = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 3
} finally {
  if ($fileStream) { try { $fileStream.Dispose() } catch {} }
}
"""


def _unavailable(reason: str) -> dict:
    return {
        "status": "UNAVAILABLE", "observedAt": utc_now_iso(),
        "speedMph": None, "directionDegrees": None,
        "note": reason, "ocrSource": "gspro-native-window",
    }


def extract_wind_hud_image(report: dict):
    """Crop the GSPro WINDOW pixels only; avoid Windows screen copies."""
    if report.get("status") != "captured" or not report.get("quality", {}).get("nonblank", False):
        return None
    raw = report.get("_private_bgra")
    try:
        width, height = int(report["windowWidth"]), int(report["windowHeight"])
        if width < 640 or height < 360 or width * height > native_capture.MAX_CAPTURE_PIXELS:
            return None
        if not isinstance(raw, bytes) or len(raw) != width * height * 4:
            return None
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)
        # Existing Windows wind reader used the top-center 36% x 16% window ROI.
        x1, x2 = int(width * 0.32), int(width * 0.68)
        y1, y2 = 0, int(height * 0.16)
        roi = frame[y1:y2, x1:x2, :3]
        if roi.size == 0:
            return None
        # Upscaling short HUD glyphs helps WinRT, while source stays GSPro-only.
        cropped = cv2.resize(roi, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        return cropped, {"x": x1, "y": y1, "width": x2-x1, "height": y2-y1}
    except (ValueError, TypeError, KeyError, cv2.error):
        return None


def _ocr_png_with_windows(png: bytes) -> dict:
    if os.name != "nt":
        return {"status": "error", "note": "windows_only"}
    path = None
    try:
        with tempfile.NamedTemporaryFile(prefix="looper-wind-hud-", suffix=".png", delete=False) as output:
            path = output.name
            output.write(png)
        env = os.environ.copy()
        env["LOOPER_WIND_OCR_IMAGE"] = path
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-Command", WINRT_WIND_OCR_SCRIPT],
            capture_output=True, text=True, check=False, timeout=12,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), env=env,
        )
        lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if not lines:
            return {"status": "error", "note": "windows_ocr_no_payload"}
        payload = json.loads(lines[-1])
        if not isinstance(payload, dict):
            return {"status": "error", "note": "windows_ocr_invalid_payload"}
        return payload
    except subprocess.TimeoutExpired:
        return {"status": "error", "note": "windows_ocr_timeout"}
    except (OSError, ValueError, json.JSONDecodeError):
        return {"status": "error", "note": "windows_ocr_subprocess_failed"}
    finally:
        if path is not None:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                pass


def read_wind_from_capture(report: dict) -> dict:
    """Return a single read-only, source-labelled wind observation or fail closed."""
    crop = extract_wind_hud_image(report)
    if crop is None:
        return _unavailable("GSPro window capture unavailable or HUD image invalid.")
    image, crop_box = crop
    encoded, png = cv2.imencode(".png", image)
    if not encoded:
        return _unavailable("Could not encode GSPro wind HUD crop.")
    result = _ocr_png_with_windows(png.tobytes())
    if result.get("status") != "ok":
        return _unavailable(str(result.get("note") or "Windows wind OCR unavailable.")[:240])
    text = result.get("rawText")
    if not isinstance(text, str):
        return _unavailable("Windows wind OCR returned no text.")
    parsed = parse_wind_ocr_text(text)
    parsed["ocrSource"] = "gspro-native-window"
    parsed["captureFreshness"] = "single_capture_unverified"
    parsed["capture"] = {"method": report.get("method"), "crop": crop_box}
    return parsed


def read_gspro_native_wind(window: dict, *, captured: dict | None = None) -> dict:
    report = captured if captured is not None else native_capture.probe_gspro_capture(window, keep_pixels=True)
    return read_wind_from_capture(report)
