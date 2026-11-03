"""Read-only wind OCR: native GSPro HWND pixels + packaged Tesseract 5 CLI.

The browser's validated crop/preprocessing/PSM strategy is the reference.
No Chrome screen-sharing; native window capture remains read-only.
The WinRT helper below is intentionally retained for the already-working lie reader.
"""
from __future__ import annotations

import json
import os
import re
import time
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
    # 16-point labels. Without these, a WNW/ENE/ESE/WSW wind never read and
    # NNE/NNW/SSE/SSW were collapsed to their 8-point neighbour (22.5 deg off).
    "NNE": 22.5, "ENE": 67.5, "ESE": 112.5, "SSE": 157.5,
    "SSW": 202.5, "WSW": 247.5, "WNW": 292.5, "NNW": 337.5,
}


# Tesseract needs a margin around the text and reads best at modest text
# heights. A 4K window cropped at 8x put the "8" of "8 MPH" against the crop
# edge at ~250 px tall and it read "0 MP" (Brian's FarmLinks screenshot,
# 2 Nov 2026). Crops are now scaled to a target height and padded, read at
# several heights, and a value counts only when two reads agree.
OCR_PAD_PX = 16
SPEED_TARGET_HEIGHTS = (80, 100, 140)
EXPANDED_SPEED_TARGET_HEIGHTS = (60, 100)
DIRECTION_TARGET_HEIGHTS = (80, 100, 140)
MIN_AGREEING_READS = 2
# GSPro's wind box is a dark pill at top centre: "<speed> MPH (arrow) <dir>".
# It widens for "15 MPH" or "WNW", so the crops follow its measured edges
# (FarmLinks 3776 px: 0.4356-0.5649) instead of fixed boxes that cut the
# leading digit (15 -> "5") or the last letter (WNW -> "WN").
WIND_BOX_BAND = (0.012, 0.035)
WIND_BOX_LEFT_RANGE = (0.40, 0.46)
WIND_BOX_RIGHT_RANGE = (0.54, 0.60)
WIND_ARROW_CLEAR = (0.479, 0.522)  # keep the arrow disc out of both crops
WIND_BOX_INSET = 0.003


def _drop_edge_specks(binary: np.ndarray, disc_side: str | None = None) -> np.ndarray:
    """Clear small dark marks touching the crop's left/right edge: the wind
    box's anti-aliased rounded corner, which made Tesseract drop the '8'.
    Real glyphs are far larger than these slivers. Anything touching the side
    that faces the arrow disc is the disc's rim, whatever its size: on a
    narrow "6 MPH" box it reached into the speed crop and the '6' read as
    nothing (Valhalla, 2 Nov 2026)."""
    ink = (binary == 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    height, width = binary.shape[:2]
    out = binary.copy()
    for i in range(1, count):
        x, _, w, _, area = stats[i]
        left, right = x == 0, x + w >= width
        disc = (disc_side == "right" and right) or (disc_side == "left" and left)
        if disc or ((left or right) and area < 0.02 * height * height):
            out[labels == i] = 255
    return out


def _number_only(binary: np.ndarray) -> np.ndarray | None:
    """The glyphs left of the widest gap ("6" of "6 MPH"), padded, or None."""
    ink = (binary == 0).astype(np.uint8)
    count, _, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    height = binary.shape[0]
    boxes = sorted((int(stats[i][0]), int(stats[i][0] + stats[i][2])) for i in range(1, count)
                   if stats[i][3] >= 0.3 * (height - 2 * OCR_PAD_PX))
    if len(boxes) < 2:
        return None
    gaps = [(boxes[i + 1][0] - max(b for _, b in boxes[:i + 1]), i) for i in range(len(boxes) - 1)]
    _, split = max(gaps)
    right = max(b for _, b in boxes[:split + 1])
    left = boxes[0][0]
    digits = binary[:, left:right]
    return cv2.copyMakeBorder(digits, 0, 0, OCR_PAD_PX, OCR_PAD_PX, cv2.BORDER_CONSTANT, value=255)


def _measured_wind_crops(frame: np.ndarray):
    """Speed/direction crops from the wind box's actual edges, or None."""
    height, width = frame.shape[:2]
    band = frame[int(height * WIND_BOX_BAND[0]):int(height * WIND_BOX_BAND[1])].astype(np.float32)
    if band.size == 0:
        return None
    lum = 0.0722 * band[:, :, 0] + 0.7152 * band[:, :, 1] + 0.2126 * band[:, :, 2]
    dark = (lum < 90).mean(axis=0)

    def edge(start: int, step: int) -> int:
        x = start
        while 0 < x < width - 1 and dark[x] >= 0.25:
            x += step
        return x

    start_left, start_right = int(width * 0.47), int(width * 0.53)
    if dark[start_left] < 0.25 or dark[start_right] < 0.25:
        return None
    left, right = edge(start_left, -1) / width, edge(start_right, 1) / width
    if not (WIND_BOX_LEFT_RANGE[0] <= left <= WIND_BOX_LEFT_RANGE[1]
            and WIND_BOX_RIGHT_RANGE[0] <= right <= WIND_BOX_RIGHT_RANGE[1]):
        return None
    y, h = WIND_CROPS["speed"][1], WIND_CROPS["speed"][3]
    speed_left = left + WIND_BOX_INSET
    direction_right = right - WIND_BOX_INSET
    return {
        "speed": (speed_left, y, WIND_ARROW_CLEAR[0] - speed_left, h),
        "direction": (WIND_ARROW_CLEAR[1], y, direction_right - WIND_ARROW_CLEAR[1], h),
    }


def extract_wind_hud_regions(report: dict, *, expanded_speed: bool = False,
                             target_height: int | None = None):
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
        measured = _measured_wind_crops(frame)
        bounds = dict(measured or WIND_CROPS)
        if expanded_speed and not measured:
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
            scale = (max(1.0, min(float(WIND_CROP_SCALE), target_height / ch))
                     if target_height else float(WIND_CROP_SCALE))
            enlarged = cv2.resize(roi, (max(1, round(cw * scale)), max(1, round(ch * scale))),
                                  interpolation=cv2.INTER_CUBIC)
            b, g, red = cv2.split(enlarged)
            luminance = 0.0722 * b.astype(np.float32) + 0.7152 * g.astype(np.float32) + 0.2126 * red.astype(np.float32)
            binary = np.where(luminance >= WIND_BINARY_THRESHOLD, 0, 255).astype(np.uint8)
            if measured:
                binary = _drop_edge_specks(binary, "right" if name == "speed" else "left")
            binary = cv2.copyMakeBorder(binary, OCR_PAD_PX, OCR_PAD_PX, OCR_PAD_PX, OCR_PAD_PX,
                                        cv2.BORDER_CONSTANT, value=255)
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
    letters = re.sub(r"[^NESW]", "", compact_direction)
    cardinal = next((c for c in (compact_direction, letters, collapsed) if c in WIND_CARDINAL_DEGREES), None)
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


def _cardinal_from_text(text: str):
    compact = re.sub(r"\s+", "", (text or "").upper())
    collapsed = re.sub(r"(.)\1+", r"\1", compact)
    letters = re.sub(r"[^NESW]", "", compact)
    return next((c for c in (compact, letters, collapsed) if c in WIND_CARDINAL_DEGREES), None)


def _agreed(reads: list[tuple[object, str]]):
    """The value at least MIN_AGREEING_READS reads gave (most votes; ties go
    to the larger speed, since a cut-off leading digit reads smaller)."""
    counts: dict[object, int] = {}
    for value, _ in reads:
        if value is not None:
            counts[value] = counts.get(value, 0) + 1
    if not counts:
        return None, ""
    best = max(counts, key=lambda v: (counts[v], v if isinstance(v, (int, float)) else 0))
    if counts[best] < MIN_AGREEING_READS:
        return None, ""
    return best, next(text for value, text in reads if value == best)


_last_diagnostic_at = 0.0
DIAGNOSTIC_INTERVAL_S = 30.0
DIAGNOSTIC_KEEP = 6


def _diagnostics_dir() -> Path | None:
    override = os.environ.get("LOOPER_COMPANION_SETTINGS_DIR")
    base = Path(override) if override else (
        Path(os.environ["LOCALAPPDATA"]) / "Looper" / "Companion" if os.environ.get("LOCALAPPDATA") else None)
    return base / "diagnostics" if base else None


def _save_wind_diagnostic(report: dict) -> str | None:
    """When the speed can't be read, keep the wind box as GSPro drew it (top
    centre of the window only: HUD pixels, no paths) so it can be checked.
    At most one every 30 s; the newest few are kept. Returns the file name."""
    global _last_diagnostic_at
    folder = _diagnostics_dir()
    now = time.monotonic()
    if folder is None or now - _last_diagnostic_at < DIAGNOSTIC_INTERVAL_S:
        return None
    try:
        width, height = int(report["windowWidth"]), int(report["windowHeight"])
        frame = np.frombuffer(report["_private_bgra"], dtype=np.uint8).reshape(height, width, 4)[:, :, :3]
        band = frame[0:max(1, int(height * 0.05)), int(width * 0.35):int(width * 0.65)]
        folder.mkdir(parents=True, exist_ok=True)
        name = time.strftime("wind-%Y%m%d-%H%M%S.png")
        ok, encoded = cv2.imencode(".png", band)
        if not ok:
            return None
        (folder / name).write_bytes(encoded.tobytes())
        _last_diagnostic_at = now
        for old in sorted(folder.glob("wind-*.png"))[:-DIAGNOSTIC_KEEP]:
            old.unlink(missing_ok=True)
        return name
    except (OSError, KeyError, ValueError, TypeError, cv2.error):
        return None


def read_wind_from_capture(report: dict) -> dict:
    """Read speed and direction from GSPro's wind box: each crop is read at a
    few sizes and a value is used only when two reads agree."""
    regions = extract_wind_hud_regions(report)
    if regions is None:
        return _unavailable("GSPro window capture unavailable or wind HUD regions invalid.")

    speed_reads: list[tuple[object, str]] = []
    speed_strategy = "reference-crop"
    for index, height in enumerate(SPEED_TARGET_HEIGHTS):
        result = _recognize_region(extract_wind_hud_regions(report, target_height=height), "speed", 7)
        if result.get("status") != "ok":
            if index == 0:
                return _unavailable("Tesseract wind speed OCR failed: " + str(result.get("note"))[:150])
            continue
        text = result.get("rawText") or ""
        speed_reads.append((_normalize_wind_speed(text), text))
    speed, speed_text = _agreed(speed_reads)
    if speed is None:
        # A two-digit speed can push its first digit outside the reference crop.
        for height in EXPANDED_SPEED_TARGET_HEIGHTS:
            expanded = extract_wind_hud_regions(report, expanded_speed=True, target_height=height)
            result = _recognize_region(expanded, "speed", 7) if expanded else {"status": "error"}
            if result.get("status") == "ok":
                text = result.get("rawText") or ""
                speed_reads.append((_normalize_wind_speed(text), text))
        speed, speed_text = _agreed(speed_reads)
        if speed is not None:
            speed_strategy = "expanded-crop"
    if speed is None and any("MPH" in re.sub(r"\s+", "", t.upper()) for _, t in speed_reads):
        # "MPH" read but the number dropped: read the number on its own.
        digit_reads: list[tuple[object, str]] = []
        for height in SPEED_TARGET_HEIGHTS:
            regions_h = extract_wind_hud_regions(report, target_height=height)
            number = _number_only(regions_h["speed"][0]) if regions_h else None
            if number is None:
                continue
            ok, encoded = cv2.imencode(".png", number)
            for psm in (7, 8):
                result = _ocr_png_with_tesseract(encoded.tobytes(), psm=psm, whitelist="0123456789") if ok else {}
                if result.get("status") == "ok":
                    text = (result.get("rawText") or "").strip()
                    digit_reads.append((_normalize_wind_speed(text) if text else None, text + " MPH"))
        speed, speed_text = _agreed(digit_reads)
        speed_reads.extend(digit_reads)
        if speed is not None:
            speed_strategy = "number-only"

    direction_reads: list[tuple[object, str]] = []
    direction_strategy = "word-psm8"
    for index, height in enumerate(DIRECTION_TARGET_HEIGHTS):
        result = _recognize_region(extract_wind_hud_regions(report, target_height=height), "direction", 8)
        if result.get("status") != "ok":
            if index == 0:
                return _unavailable("Tesseract wind direction OCR failed: " + str(result.get("note"))[:150])
            continue
        text = result.get("rawText") or ""
        direction_reads.append((_cardinal_from_text(text), text))
        if _agreed(direction_reads)[0] is not None:
            break
    cardinal, direction_text = _agreed(direction_reads)
    if cardinal is None and speed not in (None, 0):
        for mode in (7, 10):
            result = _recognize_region(extract_wind_hud_regions(report, target_height=100), "direction", mode)
            if result.get("status") == "ok":
                text = result.get("rawText") or ""
                direction_reads.append((_cardinal_from_text(text), text))
        cardinal, direction_text = _agreed(direction_reads)
        if cardinal is not None:
            direction_strategy = "fallback-psm"

    parsed = _parse_split_wind(speed_text if speed is not None else "",
                               direction_text if cardinal is not None else "")
    seen = lambda reads: " / ".join(t or "-" for _, t in reads)
    parsed["rawText"] = f"SPEED: {seen(speed_reads)} | DIR: {seen(direction_reads)}"
    parsed["ocrSource"] = "gspro-native-tesseract"
    parsed["ocrEngine"] = "tesseract-cli"
    parsed["captureFreshness"] = "single_capture_unverified"
    parsed["directionOcrStrategy"] = direction_strategy
    parsed["speedOcrStrategy"] = speed_strategy
    parsed["capture"] = {
        "method": report.get("method"),
        "crops": {name: roi[1] for name, roi in regions.items()},
        "measuredBox": _measured_wind_crops(
            np.frombuffer(report["_private_bgra"], dtype=np.uint8).reshape(
                int(report["windowHeight"]), int(report["windowWidth"]), 4)[:, :, :3]) is not None,
    }
    if parsed.get("speedMph") is None:
        sc = regions["speed"][1]
        parsed["note"] = (parsed.get("note") or "") + (
            f" Speed crop x {sc['x']} w {sc['width']} of {report.get('windowWidth')}"
            f" ({'box edges found' if parsed['capture']['measuredBox'] else 'fixed crop'}).")
        saved = _save_wind_diagnostic(report)
        if saved:
            parsed["diagnosticFile"] = saved
            parsed["note"] = (parsed.get("note") or "") + f" Wind box saved as {saved} in the companion's diagnostics folder."
    return parsed


def read_gspro_native_wind(window: dict, *, captured: dict | None = None) -> dict:
    report = captured if captured is not None else native_capture.probe_gspro_capture(window, keep_pixels=True)
    return read_wind_from_capture(report)
