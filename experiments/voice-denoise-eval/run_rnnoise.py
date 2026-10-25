#!/usr/bin/env python3
"""Run FFmpeg's arnndn (RNNoise) over the prepared mixtures.

RNNoise runs at 48 kHz, so the filter chain upsamples, denoises, and returns to
16 kHz. `mix=1.0` is full suppression; `mix=0.85` is the gentler arm the FFmpeg
docs recommend when full suppression sounds vacuum-sealed.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

OUT = Path("/tmp/voice-denoise-eval")
MODEL = OUT / "models" / "std.rnnn"
ENHANCED = OUT / "enhanced"


def main() -> None:
    ENHANCED.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((OUT / "dataset" / "manifest.json").read_text(encoding="utf-8"))
    for item in manifest:
        for name, mix in (("rnnoise", "1.0"), ("rnnoise085", "0.85")):
            target = ENHANCED / f"{item['id']}_{name}.wav"
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-loglevel",
                    "error",
                    "-i",
                    item["noisy"],
                    "-af",
                    f"aresample=48000,arnndn=m={MODEL}:mix={mix},aresample=16000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(target),
                ],
                check=True,
            )
            print(f"{item['id']} {name}: {target}")


if __name__ == "__main__":
    main()
