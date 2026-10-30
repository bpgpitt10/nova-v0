#!/usr/bin/env python3

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import opengolfcoach


HOST = os.environ.get("OPEN_GOLF_COACH_HOST", "127.0.0.1")
PORT = int(os.environ.get("OPEN_GOLF_COACH_PORT", "8787"))
HELPER_SERVICE_NAME = "open-golf-coach-helper"
HELPER_HEALTH_VERSION = "4"

WIND_CARDINAL_DEGREES = {
    "N": 0,
    "NE": 45,
    "E": 90,
    "SE": 135,
    "S": 180,
    "SW": 225,
    "W": 270,
    "NW": 315,
}

LIE_SURFACE_PATTERNS = (
    ("deep rough", r"\bDEEP\s+ROUGH\b"),
    ("fairway", r"\bFAIRWAY\b"),
    ("rough", r"\bROUGH\b"),
    ("green", r"\bGREEN\b"),
    ("fringe", r"\bFRINGE\b"),
    ("sand", r"\bSAND\b"),
    ("bunker", r"\bBUNKER\b"),
    ("tee", r"\bTEE\b"),
)

# Keep capture/OCR outside the React state layers. The helper finds the
# GSPro window, captures only a generous top-center HUD crop, then uses the OCR
# engine already included with Windows. No Tesseract/model bundle is required.
WINDOWS_WIND_OCR_SCRIPT = r'''
$ErrorActionPreference = "Stop"
$bitmap = $null
$graphics = $null
$fileStream = $null
$tempPath = $null
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LooperGsproWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

  [LooperGsproWindow]::SetProcessDPIAware() | Out-Null
  $process = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and (
      $_.ProcessName -like "GSPro*" -or $_.MainWindowTitle -like "*GSPro*"
    )
  } | Select-Object -First 1

  if (-not $process) {
    [PSCustomObject]@{ status = "unavailable"; note = "GSPro window not found." } |
      ConvertTo-Json -Compress
    exit 0
  }

  $rect = New-Object LooperGsproWindow+RECT
  if (-not [LooperGsproWindow]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
    throw "GetWindowRect failed for GSPro."
  }

  $windowWidth = $rect.Right - $rect.Left
  $windowHeight = $rect.Bottom - $rect.Top
  if ($windowWidth -lt 640 -or $windowHeight -lt 360) {
    throw "GSPro window is too small or minimized ($windowWidth x $windowHeight)."
  }

  # GSPro's wind tile is top-center. Use a deliberately generous crop so the
  # OCR survives resolution/UI-scale differences; parsing later only accepts
  # '<number> MPH' plus one of the eight cardinal tokens.
  $cropWidth = [Math]::Max(320, [int]($windowWidth * 0.36))
  $cropHeight = [Math]::Max(110, [int]($windowHeight * 0.16))
  $cropWidth = [Math]::Min($cropWidth, $windowWidth)
  $cropHeight = [Math]::Min($cropHeight, $windowHeight)
  $cropX = $rect.Left + [int](($windowWidth - $cropWidth) / 2)
  $cropY = $rect.Top

  $bitmap = New-Object System.Drawing.Bitmap($cropWidth, $cropHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen(
    (New-Object System.Drawing.Point($cropX, $cropY)),
    [System.Drawing.Point]::Empty,
    (New-Object System.Drawing.Size($cropWidth, $cropHeight))
  )

  $tempPath = Join-Path $env:TEMP ("looper-gspro-wind-" + [Guid]::NewGuid().ToString("N") + ".png")
  $bitmap.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Foundation.IAsyncOperation`1, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

  $getAwaiterBaseMethod = [WindowsRuntimeSystemExtensions].GetMember("GetAwaiter").Where({
    $PSItem.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation`1"
  }, "First")[0]

  function Await($AsyncTask, $ResultType) {
    $getAwaiterBaseMethod.MakeGenericMethod($ResultType).Invoke($null, @($AsyncTask)).GetResult()
  }

  $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $ocrEngine) { throw "Windows OCR engine is unavailable for the current user profile." }

  $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tempPath)) ([Windows.Storage.StorageFile])
  $fileStream = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $bitmapDecoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($fileStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $softwareBitmap = Await ($bitmapDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ocrResult = Await ($ocrEngine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])

  [PSCustomObject]@{
    status = "ok"
    rawText = $ocrResult.Text
    windowTitle = $process.MainWindowTitle
    crop = [PSCustomObject]@{ x = $cropX; y = $cropY; width = $cropWidth; height = $cropHeight }
  } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ status = "error"; note = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  if ($fileStream) { try { $fileStream.Dispose() } catch {} }
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
  if ($tempPath -and (Test-Path $tempPath)) { Remove-Item -Force $tempPath -ErrorAction SilentlyContinue }
}
'''

# The minimap can be configured on either side of the GSPro screen. Capture a
# broad strip on both sides, OCR each strip, and let the parser choose whichever
# one actually contains the current-lie labels and angles. This avoids assuming
# a player's minimap-side preference or a single exact screen resolution.
WINDOWS_LIE_OCR_SCRIPT = r'''
$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LooperGsproLieWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

  [LooperGsproLieWindow]::SetProcessDPIAware() | Out-Null
  $process = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and (
      $_.ProcessName -like "GSPro*" -or $_.MainWindowTitle -like "*GSPro*"
    )
  } | Select-Object -First 1

  if (-not $process) {
    [PSCustomObject]@{ status = "unavailable"; note = "GSPro window not found." } |
      ConvertTo-Json -Compress
    exit 0
  }

  $rect = New-Object LooperGsproLieWindow+RECT
  if (-not [LooperGsproLieWindow]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
    throw "GetWindowRect failed for GSPro."
  }

  $windowWidth = $rect.Right - $rect.Left
  $windowHeight = $rect.Bottom - $rect.Top
  if ($windowWidth -lt 640 -or $windowHeight -lt 360) {
    throw "GSPro window is too small or minimized ($windowWidth x $windowHeight)."
  }

  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Foundation.IAsyncOperation`1, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

  $getAwaiterBaseMethod = [WindowsRuntimeSystemExtensions].GetMember("GetAwaiter").Where({
    $PSItem.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation`1"
  }, "First")[0]

  function Await($AsyncTask, $ResultType) {
    $getAwaiterBaseMethod.MakeGenericMethod($ResultType).Invoke($null, @($AsyncTask)).GetResult()
  }

  $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $ocrEngine) { throw "Windows OCR engine is unavailable for the current user profile." }

  function Read-OcrCrop($Name, $CropX, $CropY, $CropWidth, $CropHeight) {
    $bitmap = $null
    $graphics = $null
    $fileStream = $null
    $tempPath = $null
    try {
      $bitmap = New-Object System.Drawing.Bitmap($CropWidth, $CropHeight)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen(
        (New-Object System.Drawing.Point($CropX, $CropY)),
        [System.Drawing.Point]::Empty,
        (New-Object System.Drawing.Size($CropWidth, $CropHeight))
      )
      $tempPath = Join-Path $env:TEMP ("looper-gspro-lie-" + $Name + "-" + [Guid]::NewGuid().ToString("N") + ".png")
      $bitmap.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)

      $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tempPath)) ([Windows.Storage.StorageFile])
      $fileStream = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      $bitmapDecoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($fileStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $softwareBitmap = Await ($bitmapDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $ocrResult = Await ($ocrEngine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])

      return [PSCustomObject]@{
        status = "ok"
        name = $Name
        rawText = $ocrResult.Text
        crop = [PSCustomObject]@{ x = $CropX; y = $CropY; width = $CropWidth; height = $CropHeight }
      }
    } catch {
      return [PSCustomObject]@{ status = "error"; name = $Name; note = $_.Exception.Message }
    } finally {
      if ($fileStream) { try { $fileStream.Dispose() } catch {} }
      if ($graphics) { $graphics.Dispose() }
      if ($bitmap) { $bitmap.Dispose() }
      if ($tempPath -and (Test-Path $tempPath)) { Remove-Item -Force $tempPath -ErrorAction SilentlyContinue }
    }
  }

  $cropWidth = [Math]::Max(360, [int]($windowWidth * 0.32))
  $cropWidth = [Math]::Min($cropWidth, $windowWidth)
  $cropY = $rect.Top + [int]($windowHeight * 0.08)
  $cropHeight = [Math]::Max(320, [int]($windowHeight * 0.84))
  $cropHeight = [Math]::Min($cropHeight, $rect.Bottom - $cropY)
  $leftX = $rect.Left
  $rightX = $rect.Right - $cropWidth

  $left = Read-OcrCrop "left" $leftX $cropY $cropWidth $cropHeight
  $right = Read-OcrCrop "right" $rightX $cropY $cropWidth $cropHeight

  [PSCustomObject]@{
    status = "ok"
    windowTitle = $process.MainWindowTitle
    candidates = @($left, $right)
  } | ConvertTo-Json -Depth 5 -Compress
} catch {
  [PSCustomObject]@{ status = "error"; note = $_.Exception.Message } | ConvertTo-Json -Compress
}
'''


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def derive_values(payload: dict) -> dict:
    result_json = opengolfcoach.calculate_derived_values(json.dumps(payload))
    result = json.loads(result_json)
    if not isinstance(result, dict):
        raise ValueError("OpenGolfCoach result must be a JSON object")
    return result


def parse_wind_ocr_text(raw_text: str) -> dict:
    normalized = " ".join(raw_text.upper().split())
    speed_match = re.search(r"\b(\d{1,2}(?:\.\d+)?)\s*MPH\b", normalized)
    cardinal_match = re.search(r"\b(NE|SE|SW|NW|N|E|S|W)\b", normalized)

    speed_mph = float(speed_match.group(1)) if speed_match else None
    cardinal = cardinal_match.group(1) if cardinal_match else None
    direction_degrees = WIND_CARDINAL_DEGREES.get(cardinal) if cardinal else None

    missing = []
    if speed_mph is None:
        missing.append("speed")
    if direction_degrees is None:
        missing.append("cardinal direction")

    return {
        "status": "READY" if not missing else "UNKNOWN",
        "speedMph": speed_mph,
        "directionDegrees": direction_degrees,
        # GSPro documents the arrow as the direction the air is moving; the
        # cardinal label is the same wind direction independent of player view.
        "convention": "toward",
        "referenceFrame": "compass",
        "observedAt": utc_now_iso(),
        "confidence": None,
        "rawText": raw_text,
        "note": (
            "Windows OCR read GSPro top-center wind HUD. Cardinal is compass-referenced and "
            "mapped to the direction the wind is moving toward. Shot-relative projection remains "
            "blocked until Looper has a validated compass bearing for the intended shot."
            if not missing
            else f"HUD OCR was incomplete; missing {', '.join(missing)}."
        ),
    }


def _parse_lie_axis_prefix(normalized: str, positive: str, negative: str):
    number = r"(-?\d{1,2}(?:[\.,]\d+)?)"
    unit = r"\s*(?:°|DEG(?:REE)?S?)?\s*"
    match = re.search(rf"\b({positive}|{negative})\b{unit}{number}", normalized)
    if not match:
        return None
    value = abs(float(match.group(2).replace(",", ".")))
    return value if match.group(1) == positive else -value


def _parse_lie_axis_suffix(normalized: str, positive: str, negative: str):
    number = r"(-?\d{1,2}(?:[\.,]\d+)?)"
    unit = r"\s*(?:°|DEG(?:REE)?S?)?\s*"
    match = re.search(rf"{number}{unit}\b({positive}|{negative})\b", normalized)
    if not match:
        return None
    value = abs(float(match.group(1).replace(",", ".")))
    return value if match.group(2) == positive else -value


def parse_lie_ocr_text(raw_text: str) -> dict:
    normalized = " ".join(raw_text.upper().split())

    prefix_up_down = _parse_lie_axis_prefix(normalized, "UP", "DOWN")
    prefix_left_right = _parse_lie_axis_prefix(normalized, "RIGHT", "LEFT")
    suffix_up_down = _parse_lie_axis_suffix(normalized, "UP", "DOWN")
    suffix_left_right = _parse_lie_axis_suffix(normalized, "RIGHT", "LEFT")

    # Windows OCR may flatten the minimap as either label-first
    # ('UP 2.1 RIGHT 0.7') or value-first ('2.1 UP 0.7 RIGHT'). Parse the two
    # axes as one layout whenever possible. If each axis independently chose
    # its first match, the value immediately before RIGHT could incorrectly be
    # the UP value from a label-first string.
    if prefix_up_down is not None and prefix_left_right is not None:
        up_down = prefix_up_down
        left_right = prefix_left_right
        layout = "label-first"
    elif suffix_up_down is not None and suffix_left_right is not None:
        up_down = suffix_up_down
        left_right = suffix_left_right
        layout = "value-first"
    else:
        up_down = prefix_up_down if prefix_up_down is not None else suffix_up_down
        left_right = prefix_left_right if prefix_left_right is not None else suffix_left_right
        layout = "mixed/partial"

    surface = None
    for label, pattern in LIE_SURFACE_PATTERNS:
        if re.search(pattern, normalized):
            surface = label
            break

    missing = []
    if up_down is None:
        missing.append("up/down angle")
    if left_right is None:
        missing.append("left/right angle")

    return {
        "status": "READY" if not missing else "UNKNOWN",
        "surface": surface,
        "upDownDegrees": up_down,
        "leftRightDegrees": left_right,
        "observedAt": utc_now_iso(),
        "confidence": None,
        "rawText": raw_text,
        "note": (
            "Windows OCR read the GSPro minimap current-lie HUD. Signed convention is "
            "+UP/-DOWN and +RIGHT/-LEFT exactly as labeled by GSPro. Parsed OCR layout: "
            f"{layout}. This is kept separate from Looper's LiDAR-derived terrain plane."
            if not missing
            else f"Minimap lie OCR was incomplete; missing {', '.join(missing)}. Parsed OCR layout: {layout}."
        ),
    }


def read_gspro_wind_hud() -> dict:
    if os.name != "nt":
        return {
            "status": "UNAVAILABLE",
            "speedMph": None,
            "directionDegrees": None,
            "convention": None,
            "referenceFrame": None,
            "observedAt": utc_now_iso(),
            "confidence": None,
            "rawText": None,
            "note": "GSPro HUD OCR is currently implemented for Windows only.",
        }

    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                WINDOWS_WIND_OCR_SCRIPT,
            ],
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=creation_flags,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "status": "UNAVAILABLE",
            "observedAt": utc_now_iso(),
            "note": "Windows HUD OCR timed out.",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "UNAVAILABLE",
            "observedAt": utc_now_iso(),
            "note": f"Windows HUD OCR could not start: {exc}",
        }

    output_lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if not output_lines:
        detail = completed.stderr.strip() or f"PowerShell exit code {completed.returncode}"
        return {
            "status": "UNAVAILABLE",
            "observedAt": utc_now_iso(),
            "note": f"Windows HUD OCR returned no payload: {detail}",
        }

    try:
        capture = json.loads(output_lines[-1])
    except json.JSONDecodeError as exc:
        return {
            "status": "UNKNOWN",
            "observedAt": utc_now_iso(),
            "rawText": output_lines[-1],
            "note": f"Windows HUD OCR returned invalid JSON: {exc}",
        }

    if capture.get("status") != "ok":
        return {
            "status": "UNAVAILABLE",
            "observedAt": utc_now_iso(),
            "rawText": capture.get("rawText"),
            "note": capture.get("note") or "GSPro HUD could not be captured.",
        }

    observation = parse_wind_ocr_text(str(capture.get("rawText") or ""))
    observation["capture"] = {
        "windowTitle": capture.get("windowTitle"),
        "crop": capture.get("crop"),
    }
    return observation


def read_gspro_lie_hud() -> dict:
    if os.name != "nt":
        return {
            "status": "UNAVAILABLE",
            "surface": None,
            "upDownDegrees": None,
            "leftRightDegrees": None,
            "observedAt": utc_now_iso(),
            "confidence": None,
            "rawText": None,
            "note": "GSPro minimap lie OCR is currently implemented for Windows only.",
        }

    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                WINDOWS_LIE_OCR_SCRIPT,
            ],
            capture_output=True,
            text=True,
            timeout=12,
            creationflags=creation_flags,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "status": "UNAVAILABLE",
            "observedAt": utc_now_iso(),
            "note": "Windows minimap lie OCR timed out.",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "UNAVAILABLE",
            "observedAt": utc_now_iso(),
            "note": f"Windows minimap lie OCR could not start: {exc}",
        }

    output_lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if not output_lines:
        detail = completed.stderr.strip() or f"PowerShell exit code {completed.returncode}"
        return {
            "status": "UNAVAILABLE",
            "observedAt": utc_now_iso(),
            "note": f"Windows minimap lie OCR returned no payload: {detail}",
        }

    try:
        capture = json.loads(output_lines[-1])
    except json.JSONDecodeError as exc:
        return {
            "status": "UNKNOWN",
            "observedAt": utc_now_iso(),
            "rawText": output_lines[-1],
            "note": f"Windows minimap lie OCR returned invalid JSON: {exc}",
        }

    if capture.get("status") != "ok":
        return {
            "status": "UNAVAILABLE",
            "observedAt": utc_now_iso(),
            "rawText": None,
            "note": capture.get("note") or "GSPro minimap could not be captured.",
        }

    parsed_candidates = []
    for candidate in capture.get("candidates") or []:
        if not isinstance(candidate, dict) or candidate.get("status") != "ok":
            continue
        parsed = parse_lie_ocr_text(str(candidate.get("rawText") or ""))
        score = (
            (3 if parsed.get("upDownDegrees") is not None else 0)
            + (3 if parsed.get("leftRightDegrees") is not None else 0)
            + (1 if parsed.get("surface") else 0)
        )
        parsed_candidates.append((score, parsed, candidate))

    if not parsed_candidates:
        return {
            "status": "UNAVAILABLE",
            "observedAt": utc_now_iso(),
            "note": "Both GSPro minimap-side OCR crops failed.",
        }

    _, observation, candidate = max(parsed_candidates, key=lambda item: item[0])
    observation["capture"] = {
        "windowTitle": capture.get("windowTitle"),
        "side": candidate.get("name"),
        "crop": candidate.get("crop"),
    }
    return observation


class OpenGolfCoachHandler(BaseHTTPRequestHandler):
    def _write_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._write_json(204, {})

    def do_GET(self) -> None:
        if self.path == "/health":
            self._write_json(
                200,
                {
                    "service": HELPER_SERVICE_NAME,
                    "status": "ok",
                    "version": HELPER_HEALTH_VERSION,
                    "derive_endpoint": "/derive",
                    "wind_endpoint": "/wind",
                    "lie_endpoint": "/lie",
                },
            )
            return

        if self.path == "/wind":
            self._write_json(200, read_gspro_wind_hud())
            return

        if self.path == "/lie":
            self._write_json(200, read_gspro_lie_hud())
            return

        self._write_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/derive":
            self._write_json(404, {"error": "not found"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)

        try:
            payload = json.loads(raw_body.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("payload must be an object")
            derived_values = derive_values(payload)
        except Exception as exc:  # noqa: BLE001
            self._write_json(500, {"error": str(exc)})
            return

        self._write_json(200, derived_values)

    def log_message(self, format: str, *args) -> None:
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), OpenGolfCoachHandler)
    print(f"OpenGolfCoach helper listening on http://{HOST}:{PORT}")
    server.serve_forever()
