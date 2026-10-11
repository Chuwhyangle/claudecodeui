#!/usr/bin/env bash
# P0.14 — build the isolated Python env for the Chinese zero-shot benchmark.
# Standalone; nothing in the repo build reads it. Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv --without-pip .venv
fi
python3 -m pip --python .venv/bin/python install --quiet --upgrade pip
# torch from the CPU wheel index (avoid CUDA), everything else from PyPI; the p99turn wheel comes
# from the pinned HF URL in requirements.txt.
python3 -m pip --python .venv/bin/python install --quiet --index-url https://download.pytorch.org/whl/cpu torch==2.14.1
python3 -m pip --python .venv/bin/python install --quiet -r requirements.txt
.venv/bin/python -c "import onnxruntime, numpy, torch, p99turn; print('venv ok', onnxruntime.__version__, numpy.__version__, torch.__version__)"
