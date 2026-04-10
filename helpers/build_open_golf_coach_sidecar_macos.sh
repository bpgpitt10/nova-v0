#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_SCRIPT="$ROOT_DIR/helpers/open_golf_coach_helper.py"
BIN_DIR="$ROOT_DIR/src-tauri/binaries"
DIST_DIR="$ROOT_DIR/helpers/dist"
BUILD_DIR="$ROOT_DIR/helpers/build"
VENV_DIR="$ROOT_DIR/helpers/.venv-open-golf-coach-sidecar-mac"

ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  TARGET_TRIPLE="aarch64-apple-darwin"
elif [[ "$ARCH" == "x86_64" ]]; then
  TARGET_TRIPLE="x86_64-apple-darwin"
else
  echo "Unsupported macOS architecture: $ARCH"
  exit 1
fi

OUT_NAME="open-golf-coach-helper-${TARGET_TRIPLE}"
OUT_PATH="$BIN_DIR/$OUT_NAME"

if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi

VENV_PYTHON="$VENV_DIR/bin/python"
if [[ ! -x "$VENV_PYTHON" ]]; then
  echo "Failed to locate virtualenv python at $VENV_PYTHON"
  exit 1
fi

"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install --upgrade pyinstaller opengolfcoach
"$VENV_PYTHON" -m PyInstaller --noconfirm --onefile --name "$OUT_NAME" "$HELPER_SCRIPT" \
  --distpath "$DIST_DIR" \
  --workpath "$BUILD_DIR" \
  --specpath "$ROOT_DIR/helpers"

mkdir -p "$BIN_DIR"
cp "$DIST_DIR/$OUT_NAME" "$OUT_PATH"
chmod +x "$OUT_PATH"

echo "Built OpenGolfCoach sidecar: $OUT_PATH"
