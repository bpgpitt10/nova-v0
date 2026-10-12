"""Windows-only read-only wind OCR from the *native GSPro HWND capture*, not desktop.

Reuses the existing tested parse_wind_ocr_text convention, but captures no
desktop pixels. A bounded, temporary HUD-only PNG is deleted in finally.
Actual WinRT OCR with GSPro foreground/background still requires sim validation.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
import subprocess
import tempfile

import cv2
import numpy as np

import gspro_window_capture as native_capture
from open_golf_coach_helper import utc_now_iso

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


# Use the *previously validated browser OCR* positions, not the legacy
# Windows helper's 36%-wide top-center block. Captures are HWND-relative.
# src/adapters/browserGsproVisualCapture.ts is the source for these constants.
# Separate crops matter: at 3840x2160 the direction is a ~77x56px tile.
WIND_CROPS = {
    "speed": (0.444, 0.011, 0.033, 0.026),
    "direction": (0.532, 0.011, 0.020, 0.026),
}
WIND_CROP_SCALE = 8
WIND_BINARY_THRESHOLD = 190
WIND_CARDINAL_DEGREES = {
    "N": 0, "NE": 45, "E": 90, "SE": 135,
    "S": 180, "SW": 225, "W": 270, "NW": 315,
}


def extract_wind_hud_regions(report: dict):
    """Extract both separate, preprocessed regions from one GSPro HWND capture.

    Match the browser's canvas drawCrop: normalized coordinates, 8x bicubic
    enlargement, then per-pixel luminance threshold to black on white.
    No desktop position or screen capture is involved.
    """
    if report.get("status") != "captured" or not report.get("quality", {}).get("nonblank", False):
        return None
    try:
        width, height = int(report["windowWidth"]), int(report["windowHeight"])
        raw = report.get("_private_bgra")
        if width < 640 or height < 360 or width * height > native_capture.MAX_CAPTURE_PIXELS:
            return None
        if not isinstance(raw, bytes) or len(raw) != width * height * 4:
            return None
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)[:, :, :3]
        regions = {}
        for name, (x, y, w, h) in WIND_CROPS.items():
            left, top = int(width * x), int(height * y)
            cw, ch = max(1, int(width * w)), max(1, int(height * h))
            if left + cw > width or top + ch > height:
                return None
            roi = frame[top:top + ch, left:left + cw]
            if roi.size == 0:
                return None
            # OpenCV frame is BGR. Browser uses RGB luminance coefficients.
            enlarged = cv2.resize(roi, (cw * WIND_CROP_SCALE, ch * WIND_CROP_SCALE),
                                  interpolation=cv2.INTER_CUBIC)
            b, g, red = cv2.split(enlarged)
            luminance = 0.0722 * b.astype(np.float32) + 0.7152 * g.astype(np.float32) + 0.2126 * red.astype(np.float32)
            binary = np.where(luminance >= WIND_BINARY_THRESHOLD, 0, 255).astype(np.uint8)
            regions[name] = (
                binary,
                {"x": left, "y": top, "width": cw, "height": ch},
            )
        return regions
    except (ValueError, TypeError, KeyError, cv2.error):
        return None


def _normalize_wind_speed(raw: str):
    """Parse speed-only OCR. Restrict letter substitutions to numeric tokens."""
    compact = re.sub(r"\s+", "", raw.upper()).replace(",", ".")
    # Preserve successful numeric OCR as-is. The observed 'IO MPH' -> 10 MPH
    # substitution is only made inside the SPEED crop, never the direction.
    # Allow I->1 and O->0 ONLY in the speed crop, and only for a
    # complete numeric-like token. Never convert arbitrary OCR noise to 0.
    match = re.search(r"(?<![A-Z0-9])([0-9IO]{1,2}(?:\.[0-9IO]+)?)(?=MPH|$)", compact)
    if not match:
        return None
    token = match.group(1).replace("I", "1").replace("O", "0")
    if not any(char.isdigit() for char in match.group(1)) and "MPH" not in compact:
        return None
    try:
        number = float(token)
        return number if 0 <= number <= 50 else None
    except ValueError:
        return None


def _parse_split_wind(speed_text: str, direction_text: str) -> dict:
    speed = _normalize_wind_speed(speed_text)
    compact_direction = re.sub(r"\s+", "", direction_text.upper())
    # Match browser duplicate-glyph tolerance without guessing cardinals.
    collapsed = re.sub(r"(.)\1+", r"\1", compact_direction)
    cardinal = collapsed if collapsed in WIND_CARDINAL_DEGREES else None
    calm = speed == 0
    direction = WIND_CARDINAL_DEGREES.get(cardinal)
    if calm and direction is None:
        direction = 0  # Mathematically immaterial at exactly 0 MPH; browser parity.
    missing = []
    if speed is None:
        missing.append("speed")
    if not calm and direction is None:
        missing.append("cardinal direction")
    return {
        "status": "READY" if not missing else "UNKNOWN",
        "speedMph": speed,
        "directionDegrees": direction,
        "convention": "from", "referenceFrame": "compass",
        "observedAt": utc_now_iso(), "confidence": None,
        "rawText": f"SPEED: {speed_text.strip()} | DIR: {direction_text.strip()}",
        "note": ("Native GSPro window OCR read split speed/direction HUD."
                 if not missing else "HUD OCR was incomplete; missing " + ", ".join(missing) + "."),
    }



def _parse_direction_from_joint_ocr(raw: str):
    """Only accept a cardinal explicitly OCR'd after MPH on stitched HUD tiles.

    Isolated one-letter crops can be discarded by WinRT OCR's line detector.
    Putting the speed and direction glyphs on a single text line gives that
    detector context, without hallucinating a direction from the speed.
    """
    normalized = " ".join(raw.upper().split())
    match = re.search(r"\bMPH\s*(NE|NW|SE|SW|N|E|S|W)\s*$", normalized)
    return match.group(1) if match else None


def _read_stitched_direction(regions: dict):
    """One WinRT OCR retry on a tiny derived image, never a desktop screenshot."""
    speed_image = regions["speed"][0]
    direction_image = regions["direction"][0]
    gap = 32
    h = max(speed_image.shape[0], direction_image.shape[0])
    w = speed_image.shape[1] + gap + direction_image.shape[1]
    line = np.full((h, w), 255, dtype=np.uint8)
    line[:speed_image.shape[0], :speed_image.shape[1]] = speed_image
    x = speed_image.shape[1] + gap
    line[:direction_image.shape[0], x:] = direction_image
    ok, encoded = cv2.imencode(".png", line)
    if not ok:
        return None, "stitched_image_encode_failed"
    result = _ocr_png_with_windows(encoded.tobytes())
    if result.get("status") != "ok" or not isinstance(result.get("rawText"), str):
        return None, str(result.get("note") or "stitched_ocr_failed")[:120]
    raw = result["rawText"]
    return _parse_direction_from_joint_ocr(raw), raw[:120]


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
    """Read independent speed/direction crops, preserving fail-closed behavior."""
    regions = extract_wind_hud_regions(report)
    if regions is None:
        return _unavailable("GSPro window capture unavailable or wind HUD regions invalid.")

    texts = {}
    for name in ("speed", "direction"):
        image, _ = regions[name]
        ok, png = cv2.imencode(".png", image)
        if not ok:
            return _unavailable(f"Could not encode GSPro wind {name} crop.")
        result = _ocr_png_with_windows(png.tobytes())
        if result.get("status") != "ok":
            return _unavailable(
                f"Windows {name} OCR failed: {str(result.get('note') or 'unknown')[:180]}"
            )
        if not isinstance(result.get("rawText"), str):
            return _unavailable(f"Windows {name} OCR returned invalid text.")
        texts[name] = result["rawText"]

    parsed = _parse_split_wind(texts["speed"], texts["direction"])
    # The physical sim returned SPEED: 9 MPH | DIR: (blank) despite an
    # independently recognized speed. Windows OCR may suppress isolated
    # single-character tokens. One optional joint-line OCR is a bounded
    # fallback; it does not crop additional screen space or invent a bearing.
    if parsed["status"] == "UNKNOWN" and parsed["speedMph"] is not None and parsed["directionDegrees"] is None:
        recovered, fallback_raw = _read_stitched_direction(regions)
        parsed["directionFallbackRawText"] = fallback_raw
        if recovered is not None:
            parsed = _parse_split_wind(texts["speed"], recovered)
            parsed["directionFallbackRawText"] = fallback_raw
            parsed["directionOcrStrategy"] = "stitched-line"
        else:
            parsed["directionOcrStrategy"] = "split-and-stitched-unreadable"
    else:
        parsed["directionOcrStrategy"] = "split"
    parsed["ocrSource"] = "gspro-native-window"
    parsed["captureFreshness"] = "single_capture_unverified"
    parsed["capture"] = {
        "method": report.get("method"),
        "crops": {name: roi[1] for name, roi in regions.items()},
    }
    return parsed


def read_gspro_native_wind(window: dict, *, captured: dict | None = None) -> dict:
    report = captured if captured is not None else native_capture.probe_gspro_capture(window, keep_pixels=True)
    return read_wind_from_capture(report)
