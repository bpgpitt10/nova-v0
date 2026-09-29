#!/usr/bin/env python3
"""Narrow GSPro lie-reader override for the existing OpenGolfCoach helper.

Keeps the existing /health, /derive and /wind behavior untouched. Only /lie is
replaced, using the minimap-footer geometry proven by the earlier live probe.
"""

import json
import os
import re
import subprocess

import open_golf_coach_helper as base


# Proven minimap-footer ROI from tools/minimap_probe/lie_state.py.
# Right-side is the normal layout; left-side is a mirrored fallback for users
# who place the minimap on the opposite side.
RIGHT_FOOTER = (0.848, 0.952, 0.997, 0.999)
LEFT_FOOTER = (0.003, 0.952, 0.152, 0.999)

WINDOWS_LIE_FOOTER_OCR_SCRIPT = r'''
$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LooperGsproLieFooterWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

  [LooperGsproLieFooterWindow]::SetProcessDPIAware() | Out-Null
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

  $rect = New-Object LooperGsproLieFooterWindow+RECT
  if (-not [LooperGsproLieFooterWindow]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
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
    $scaled = $null
    $graphics = $null
    $scaledGraphics = $null
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

      # The footer text is physically small. Upscale before Windows OCR so the
      # native OCR engine gets roughly the same benefit as the proven probe's
      # preprocessing without adding OpenCV/Tesseract dependencies.
      $scale = 4
      $scaled = New-Object System.Drawing.Bitmap($CropWidth * $scale, $CropHeight * $scale)
      $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
      $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $scaledGraphics.DrawImage($bitmap, 0, 0, $scaled.Width, $scaled.Height)

      $tempPath = Join-Path $env:TEMP ("looper-gspro-lie-footer-" + $Name + "-" + [Guid]::NewGuid().ToString("N") + ".png")
      $scaled.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)

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
      if ($scaledGraphics) { $scaledGraphics.Dispose() }
      if ($graphics) { $graphics.Dispose() }
      if ($scaled) { $scaled.Dispose() }
      if ($bitmap) { $bitmap.Dispose() }
      if ($tempPath -and (Test-Path $tempPath)) { Remove-Item -Force $tempPath -ErrorAction SilentlyContinue }
    }
  }

  function Read-FooterCandidate($Name, $X1, $Y1, $X2, $Y2) {
    $footerX = $rect.Left + [int][Math]::Round($windowWidth * $X1)
    $footerY = $rect.Top + [int][Math]::Round($windowHeight * $Y1)
    $footerRight = $rect.Left + [int][Math]::Round($windowWidth * $X2)
    $footerBottom = $rect.Top + [int][Math]::Round($windowHeight * $Y2)
    $footerWidth = [Math]::Max(2, $footerRight - $footerX)
    $footerHeight = [Math]::Max(2, $footerBottom - $footerY)

    # Same overlapping 56% / 44% split as the proven reader.
    $longWidth = [Math]::Max(2, [int][Math]::Round($footerWidth * 0.56))
    $latOffset = [int][Math]::Round($footerWidth * 0.44)
    $latWidth = [Math]::Max(2, $footerWidth - $latOffset)

    $longitudinal = Read-OcrCrop ($Name + "-long") $footerX $footerY $longWidth $footerHeight
    $lateral = Read-OcrCrop ($Name + "-lat") ($footerX + $latOffset) $footerY $latWidth $footerHeight

    return [PSCustomObject]@{
      name = $Name
      footer = [PSCustomObject]@{ x = $footerX; y = $footerY; width = $footerWidth; height = $footerHeight }
      longitudinal = $longitudinal
      lateral = $lateral
    }
  }

  $right = Read-FooterCandidate "right" 0.848 0.952 0.997 0.999
  $left = Read-FooterCandidate "left" 0.003 0.952 0.152 0.999

  [PSCustomObject]@{
    status = "ok"
    windowTitle = $process.MainWindowTitle
    candidates = @($right, $left)
  } | ConvertTo-Json -Depth 7 -Compress
} catch {
  [PSCustomObject]@{ status = "error"; note = $_.Exception.Message } | ConvertTo-Json -Compress
}
'''


def _display_number(raw: str):
    """Recover GSPro's one-decimal lie display even if OCR mangles ° as a digit."""
    compact = re.sub(r"\s+", "", (raw or "").upper()).replace(",", ".")
    match = re.search(r"(\d{1,2})\.(\d)", compact)
    if match:
        value = float(f"{match.group(1)}.{match.group(2)}")
        return value if 0.0 <= value <= 60.0 else None
    if compact in ("0", "00", "0."):
        return 0.0
    return None


def _direction(raw: str, allowed):
    compact = re.sub(r"\s+", "", (raw or "").upper())
    for label in allowed:
        if label in compact:
            return label
    return None


def _component(raw: str, positive: str, negative: str):
    value = _display_number(raw)
    direction = _direction(raw, (positive, negative))
    if value == 0.0 and direction is None:
        direction = positive
    if value is None or direction is None:
        return None, None
    signed = value if direction == positive else -value
    return round(signed, 1), direction


def _parse_candidate(candidate: dict):
    longitudinal = candidate.get("longitudinal") or {}
    lateral = candidate.get("lateral") or {}
    if longitudinal.get("status") != "ok" or lateral.get("status") != "ok":
        return None

    long_raw = str(longitudinal.get("rawText") or "")
    lat_raw = str(lateral.get("rawText") or "")
    up_down, up_down_dir = _component(long_raw, "UP", "DOWN")
    left_right, left_right_dir = _component(lat_raw, "RIGHT", "LEFT")
    score = int(up_down is not None) + int(left_right is not None)

    canonical_parts = []
    if up_down is not None:
        canonical_parts.append(f"{abs(up_down):.1f} {up_down_dir}")
    if left_right is not None:
        canonical_parts.append(f"{abs(left_right):.1f} {left_right_dir}")

    return {
        "score": score,
        "upDownDegrees": up_down,
        "leftRightDegrees": left_right,
        "rawText": " ".join(canonical_parts),
        "ocrRawText": {
            "longitudinal": long_raw,
            "lateral": lat_raw,
        },
        "capture": {
            "side": candidate.get("name"),
            "footer": candidate.get("footer"),
            "longitudinal": longitudinal.get("crop"),
            "lateral": lateral.get("crop"),
        },
    }


def read_gspro_lie_hud() -> dict:
    if os.name != "nt":
        return {
            "status": "UNAVAILABLE",
            "surface": None,
            "upDownDegrees": None,
            "leftRightDegrees": None,
            "observedAt": base.utc_now_iso(),
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
                WINDOWS_LIE_FOOTER_OCR_SCRIPT,
            ],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=creation_flags,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "status": "UNAVAILABLE",
            "observedAt": base.utc_now_iso(),
            "note": "Windows minimap footer OCR timed out.",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "UNAVAILABLE",
            "observedAt": base.utc_now_iso(),
            "note": f"Windows minimap footer OCR could not start: {exc}",
        }

    output_lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if not output_lines:
        detail = completed.stderr.strip() or f"PowerShell exit code {completed.returncode}"
        return {
            "status": "UNAVAILABLE",
            "observedAt": base.utc_now_iso(),
            "note": f"Windows minimap footer OCR returned no payload: {detail}",
        }

    try:
        capture = json.loads(output_lines[-1])
    except json.JSONDecodeError as exc:
        return {
            "status": "UNKNOWN",
            "observedAt": base.utc_now_iso(),
            "rawText": output_lines[-1],
            "note": f"Windows minimap footer OCR returned invalid JSON: {exc}",
        }

    if capture.get("status") != "ok":
        return {
            "status": "UNAVAILABLE",
            "observedAt": base.utc_now_iso(),
            "rawText": None,
            "note": capture.get("note") or "GSPro minimap footer could not be captured.",
        }

    parsed = [p for p in (_parse_candidate(c) for c in (capture.get("candidates") or [])) if p]
    if not parsed:
        return {
            "status": "UNAVAILABLE",
            "observedAt": base.utc_now_iso(),
            "note": "GSPro minimap footer OCR produced no usable candidates.",
        }

    observation = max(parsed, key=lambda item: item["score"])
    missing = []
    if observation["upDownDegrees"] is None:
        missing.append("up/down angle")
    if observation["leftRightDegrees"] is None:
        missing.append("left/right angle")

    return {
        "status": "READY" if not missing else "UNKNOWN",
        "surface": None,
        "upDownDegrees": observation["upDownDegrees"],
        "leftRightDegrees": observation["leftRightDegrees"],
        "observedAt": base.utc_now_iso(),
        "confidence": None,
        # Canonicalized to one decimal so the browser's defensive re-parser
        # cannot turn OCR junk like visible 2.8° -> raw 2.89 back into 2.89.
        "rawText": observation["rawText"],
        "ocrRawText": observation["ocrRawText"],
        "capture": {
            "windowTitle": capture.get("windowTitle"),
            **observation["capture"],
        },
        "note": (
            "Windows OCR read the proven GSPro minimap-footer ROI. Signed convention is "
            "+UP/-DOWN and +RIGHT/-LEFT."
            if not missing
            else f"Minimap footer OCR was incomplete; missing {', '.join(missing)}."
        ),
    }


# Monkey-patch only the lie endpoint dependency used by the existing handler.
base.read_gspro_lie_hud = read_gspro_lie_hud
base.HELPER_HEALTH_VERSION = "5-lie-footer"


if __name__ == "__main__":
    server = base.ThreadingHTTPServer((base.HOST, base.PORT), base.OpenGolfCoachHandler)
    print(f"OpenGolfCoach helper + proven lie footer listening on http://{base.HOST}:{base.PORT}")
    server.serve_forever()
