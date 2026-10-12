"""Read-only wind OCR: native GSPro HWND pixels + packaged Tesseract 5 CLI.

The browser's validated crop/preprocessing/PSM strategy is the reference.
No Chrome screen-sharing; native window capture remains read-only.
The WinRT helper below is intentionally retained for the already-working lie reader.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
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
WIND_SPEED_EXPANDED_BOUNDS = (0.439, 0.011, 0.043, 0.026)
WIND_CROP_SCALE = 8
WIND_BINARY_THRESHOLD = 190
WIND_CARDINAL_DEGREES = {
    "N": 0, "NE": 45, "E": 90, "SE": 135,
    "S": 180, "SW": 225, "W": 270, "NW": 315,
}


def extract_wind_hud_regions(report: dict, *, expanded_speed: bool = False):
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
        bounds = dict(WIND_CROPS)
        if expanded_speed:
            bounds["speed"] = WIND_SPEED_EXPANDED_BOUNDS
        for name, (x, y, w, h) in bounds.items():
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




def _tesseract_bundle():
    """Use an installed adjacent portable OCR bundle in frozen builds only.

    Development may use a locally installed CLI. A missing packaged binary
    fails closed: no WinRT fallback, browser screen sharing, or network install.
    """
    if getattr(sys, "frozen", False):
        root = Path(sys.executable).resolve().parent / "ocr"
        engine = root / "tesseract.exe"
        trained = root / "tessdata" / "eng.traineddata"
        if engine.is_file() and trained.is_file():
            return engine, root / "tessdata"
        return None
    executable = shutil.which("tesseract")
    return (Path(executable), None) if executable else None


def _ocr_png_with_tesseract(png: bytes, *, psm: int, whitelist: str) -> dict:
    """Read one tightly cropped local image, using the browser's Tesseract PSM.

    The OCR executable is bundled alongside the Windows EXE with eng.traineddata.
    We pass fixed command arguments (not OCR text or arbitrary user strings).
    """
    bundle = _tesseract_bundle()
    if bundle is None:
        return {"status": "error", "note": "bundled_tesseract_unavailable"}
    engine, tessdata = bundle
    path = None
    try:
        with tempfile.NamedTemporaryFile(prefix="looper-wind-hud-", suffix=".png", delete=False) as output:
            path = output.name
            output.write(png)
        args = [
            str(engine), path, "stdout", "-l", "eng", "--psm", str(psm),
            "-c", f"tessedit_char_whitelist={whitelist}",
            "-c", "load_system_dawg=0", "-c", "load_freq_dawg=0",
        ]
        if tessdata is not None:
            args.extend(["--tessdata-dir", str(tessdata)])
        completed = subprocess.run(
            args, capture_output=True, text=True, check=False, timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if completed.returncode:
            return {"status": "error", "note": "tesseract_exit_" + str(completed.returncode)}
        return {"status": "ok", "rawText": completed.stdout.strip()}
    except subprocess.TimeoutExpired:
        return {"status": "error", "note": "tesseract_timeout"}
    except OSError:
        return {"status": "error", "note": "tesseract_start_failed"}
    finally:
        if path is not None:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                pass


def _recognize_region(regions: dict, name: str, psm: int):
    image, _ = regions[name]
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        return {"status": "error", "note": "wind_" + name + "_encode_failed"}
    return _ocr_png_with_tesseract(
        encoded.tobytes(),
        psm=psm,
        whitelist="0123456789.,MPH " if name == "speed" else "NSEW ",
    )


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
    """Read speed/direction via the proven Tesseract family and PSM strategy."""
    regions = extract_wind_hud_regions(report)
    if regions is None:
        return _unavailable("GSPro window capture unavailable or wind HUD regions invalid.")

    speed_result = _recognize_region(regions, "speed", 7)
    if speed_result.get("status") != "ok":
        return _unavailable("Tesseract wind speed OCR failed: " + str(speed_result.get("note"))[:150])
    speed_text = speed_result.get("rawText") or ""
    speed_strategy = "reference-crop"
    if _normalize_wind_speed(speed_text) is None:
        # Browser-proven ROI first. Screenshot from physical sim shows that
        # 2048-pixel scaled frames may truncate the leftmost numeral; a modest
        # widened fallback sees the numeral without the compass/arrow HUD.
        expanded = extract_wind_hud_regions(report, expanded_speed=True)
        if expanded:
            retry = _recognize_region(expanded, "speed", 7)
            if retry.get("status") == "ok" and _normalize_wind_speed(retry.get("rawText") or "") is not None:
                regions["speed"] = expanded["speed"]
                speed_text = retry["rawText"]
                speed_strategy = "expanded-crop"

    direction_result = _recognize_region(regions, "direction", 8)
    if direction_result.get("status") != "ok":
        return _unavailable("Tesseract wind direction OCR failed: " + str(direction_result.get("note"))[:150])
    direction_text = direction_result.get("rawText") or ""
    parsed = _parse_split_wind(speed_text, direction_text)
    direction_strategy = "word-psm8"
    if parsed["status"] == "UNKNOWN" and parsed["speedMph"] not in (None, 0) and parsed["directionDegrees"] is None:
        # The existing browser OCR attempts modes 7 and 10 for missing
        # compass labels. Never accept an unsupported cardinal.
        for mode in (7, 10):
            retry = _recognize_region(regions, "direction", mode)
            if retry.get("status") == "ok":
                candidate = _parse_split_wind(speed_text, retry.get("rawText") or "")
                if candidate["directionDegrees"] is not None:
                    direction_text = retry["rawText"]
                    parsed = candidate
                    direction_strategy = "fallback-psm" + str(mode)
                    break

    parsed["ocrSource"] = "gspro-native-tesseract"
    parsed["ocrEngine"] = "tesseract-cli"
    parsed["captureFreshness"] = "single_capture_unverified"
    parsed["directionOcrStrategy"] = direction_strategy
    parsed["speedOcrStrategy"] = speed_strategy
    parsed["capture"] = {
        "method": report.get("method"),
        "crops": {name: roi[1] for name, roi in regions.items()},
    }
    return parsed


def read_gspro_native_wind(window: dict, *, captured: dict | None = None) -> dict:
    report = captured if captured is not None else native_capture.probe_gspro_capture(window, keep_pixels=True)
    return read_wind_from_capture(report)
