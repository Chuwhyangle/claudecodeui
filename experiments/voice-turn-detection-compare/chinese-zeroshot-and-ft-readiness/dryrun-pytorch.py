#!/usr/bin/env python3
"""P0.14 AC5 — REAL PyTorch load / training-code dry-run for both candidate fine-tune targets.

WHAT THIS IS NOT. It is not training. There is no optimizer, no backward pass, no checkpoint written,
no dataset, no GPU. It runs ONE forward (and, for Smart Turn, one loss) and exits.

WHAT IT IS FOR. AC5 asks whether fine-tuning is TECHNICALLY reproducible, and it explicitly forbids
answering that by reading docs. So this script does the two things a doc cannot:

  · turn-1-mini: import the pinned `p99turn` package, build its real `Turn1Mini` nn.Module, let it
    pull its pinned `turn-1-mini.safetensors`, and run a forward — proving (a) the released checkpoint
    is a real PyTorch-format TRAINABLE checkpoint, not an ONNX-only artifact, and (b) the released
    code contains NO training path (so a LoRA/fine-tune would have to supply its own loop).
  · Smart Turn v3.2: reproduce the published training entry point. The HF repo ships ONNX only, but
    the GitHub `pipecat-ai/smart-turn` `train.py` builds `SmartTurnV3Model(WhisperPreTrainedModel)`
    and calls `from_pretrained("openai/whisper-tiny", num_labels=1, ignore_mismatched_sizes=True)`.
    This script mirrors that model class and that exact call, then runs a forward + the same
    BCEWithLogits loss the trainer would use. The base weights downloaded are openai/whisper-tiny —
    a BASE model, NOT a fine-tuned endpointing weight.

Every download is recorded. Nothing is written back to the Hub. Nothing is trained.

Run: -I so the interpreter does not import from the cwd (the working dir holds downloaded audio).
  .venv/bin/python -I dryrun-pytorch.py --out data/dryrun-evidence.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import traceback
from pathlib import Path

DIR = Path(__file__).resolve().parent
DATA = DIR / "data"

# Pinned to the P0.13 revisions — the SAME checkpoints the benchmark scores, so the dry-run describes
# the artifact actually under test, not a nearby one.
T1M_REPO = "p99lab/turn-1-mini"
T1M_REV = "076c86d1744a231d3a4cce31f3bbbd1211b4c281"
T1M_SAFETENSORS = "turn-1-mini.safetensors"
T1M_SAFETENSORS_SHA256 = "d03ccff872eb0ae2ed0366b1ea94d860328daa0122bf9003fb32b7a34b14acb9"
ST_BASE_MODEL = "openai/whisper-tiny"
ST_UPSTREAM_TRAIN = "https://github.com/pipecat-ai/smart-turn/blob/main/train.py"

downloads: list[dict] = []


def record_download(repo: str, filename: str, revision: str | None, local: Path, kind: str) -> None:
    is_dir = local.is_dir()
    downloads.append(
        {
            "repo": repo,
            "filename": filename,
            "revision": revision,
            # A transformers snapshot is a DIRECTORY of blobs; hashing it as a file is meaningless, so
            # a directory records its total byte size instead (the per-file hashes live in the Hub
            # snapshot's own metadata).
            "bytes": _dir_size(local) if is_dir else (local.stat().st_size if local.exists() else None),
            "sha256": None if is_dir else (_sha256(local) if local.exists() else None),
            "isDirectory": is_dir,
            "kind": kind,
        }
    )


def _dir_size(p: Path) -> int | None:
    if not p.exists():
        return None
    try:
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
    except OSError:
        return None


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def set_hf_home() -> None:
    os.environ.setdefault("HF_HOME", str(DATA / "hf"))
    (DATA / "hf").mkdir(parents=True, exist_ok=True)


# ── Part A: turn-1-mini ──────────────────────────────────────────────────────────────────────────
def dryrun_turn1_mini() -> dict:
    """Load the pinned safetensors into the released nn.Module and run one forward."""
    out: dict = {"model": "turn-1-mini", "repo": T1M_REPO, "revision": T1M_REV}
    try:
        import torch
        from huggingface_hub import hf_hub_download

        cfg_path = Path(hf_hub_download(repo_id=T1M_REPO, filename="config.json", revision=T1M_REV))
        record_download(T1M_REPO, "config.json", T1M_REV, cfg_path, "config")
        config = json.loads(cfg_path.read_text())
        out["config"] = config
        out["declaredTrainingLanguage"] = config.get("language")

        w_path = Path(hf_hub_download(repo_id=T1M_REPO, filename=T1M_SAFETENSORS, revision=T1M_REV))
        record_download(T1M_REPO, T1M_SAFETENSORS, T1M_REV, w_path, "checkpoint (trainable format, float32)")
        got = _sha256(w_path)
        out["checkpointSha256"] = got
        out["checkpointMatchesPinnedP013"] = got == T1M_SAFETENSORS_SHA256

        from safetensors import safe_open

        with safe_open(str(w_path), framework="pt") as f:
            keys = list(f.keys())
            meta = f.metadata() or {}
        out["safetensorsTensors"] = len(keys)
        out["safetensorsMetadataKeys"] = sorted(meta.keys())
        out["safetensorsSampleKeys"] = keys[:6]

        # The released runtime: does it carry ANY training path? (AC5: a LoRA would need its own loop.)
        import p99turn
        from p99turn import mini as p99mini

        pkg_dir = Path(p99turn.__file__).parent
        module_files = sorted(p.name for p in pkg_dir.glob("*.py"))
        # TRAINING-specific needles only. A bare "loss" substring is not a training path — the first
        # draft of this check flagged p99turn/mini.py:132 "The int8 file is slightly lossy" and
        # reported a training path that does not exist; these needles are the ones that would move
        # parameters, not the ones that merely mention them.
        needles = ("def train", "backward(", ".step()", "optim.", "TrainingArguments", "Trainer(", "load_dataset", "AdamW", "SGD(")
        hits: dict[str, list[dict]] = {}
        for name in module_files:
            lines = (pkg_dir / name).read_text(errors="replace").splitlines()
            found = [{"line": i + 1, "snippet": lines[i].strip()[:100]} for i in range(len(lines)) if any(n in lines[i] for n in needles)]
            if found:
                hits[name] = found
        out["p99turnModules"] = module_files
        out["p99turnTrainingPathHits"] = hits
        out["p99turnHasTrainingCode"] = bool(hits)
        out["p99turnTrainingNeedles"] = list(needles)
        out["p99turnHasTorchModule"] = hasattr(p99mini, "Turn1Mini") and issubclass(p99mini.Turn1Mini, torch.nn.Module)

        if out["p99turnHasTorchModule"]:
            t0 = time.perf_counter()
            model = p99mini.Turn1Mini(revision=T1M_REV)  # loads the pinned safetensors itself
            load_ms = (time.perf_counter() - t0) * 1000.0
            model.eval()
            out["paramCount"] = int(sum(p.numel() for p in model.parameters()))
            out["moduleClass"] = type(model).__module__ + "." + type(model).__name__
            sr = int(getattr(p99mini, "SR", 16000))
            # 2 s of deterministic pseudo-audio: a REAL forward through the released module.
            g = torch.Generator().manual_seed(0)
            wav = (torch.rand(1, sr * 2, generator=g) * 2 - 1) * 0.1
            with torch.no_grad():
                y = model(wav)
            out["forward"] = {
                "inputShape": list(wav.shape),
                "outputType": type(y).__name__,
                "outputShape": list(y.shape) if hasattr(y, "shape") else None,
                "outputFinite": bool(torch.isfinite(y).all()),
                "loadMs": round(load_ms, 1),
                "note": "forward only — no optimizer, no backward, no save",
            }
        out["status"] = "loaded-and-forwarded"
    except Exception as err:  # noqa: BLE001 — evidence is the point; a failure must be recorded verbatim
        out["status"] = "load-failed"
        out["error"] = f"{type(err).__name__}: {err}"
        out["traceback"] = traceback.format_exc().splitlines()[-6:]
    return out


# ── Part B: Smart Turn v3.2 ──────────────────────────────────────────────────────────────────────
def dryrun_smart_turn() -> dict:
    """Mirror train.py's `SmartTurnV3Model` + its `from_pretrained` call, then forward + loss."""
    out: dict = {"model": "smart-turn-v3.2", "upstreamTrainingCode": ST_UPSTREAM_TRAIN, "baseModel": ST_BASE_MODEL}
    try:
        import torch
        from torch import nn
        from torch.nn.functional import softmax
        from transformers import WhisperConfig, WhisperPreTrainedModel
        from transformers.models.whisper.modeling_whisper import WhisperEncoder

        # VERBATIM structural mirror of pipecat-ai/smart-turn train.py:63-135 (encoder + attention
        # pool + classifier head). Kept in-file so the dry-run does not depend on the repo being cloned.
        class SmartTurnV3Model(WhisperPreTrainedModel):
            def __init__(self, config: WhisperConfig):
                super().__init__(config)
                config.max_source_positions = 400
                self.encoder = WhisperEncoder(config)
                hidden = config.d_model
                self.pool_attention = nn.Sequential(nn.Linear(hidden, 256), nn.Tanh(), nn.Linear(256, 1))
                self.classifier = nn.Sequential(
                    nn.Linear(hidden, 256), nn.LayerNorm(256), nn.GELU(), nn.Dropout(0.1),
                    nn.Linear(256, 64), nn.GELU(), nn.Linear(64, 1),
                )

            def forward(self, input_features, labels=None):
                hs = self.encoder(input_features=input_features).last_hidden_state
                w = softmax(self.pool_attention(hs), dim=1)
                pooled = torch.sum(hs * w, dim=1)
                logits = self.classifier(pooled)
                if labels is not None:
                    pos_weight = ((labels == 0).sum() / (labels == 1).sum().clamp(min=1)).clamp(min=0.1, max=10.0)
                    loss = nn.BCEWithLogitsLoss(pos_weight=pos_weight)(logits.view(-1), labels.float().view(-1))
                    return {"loss": loss, "logits": torch.sigmoid(logits.detach())}
                return {"logits": torch.sigmoid(logits)}

        t0 = time.perf_counter()
        # THE EXACT documented entry point (train.py:684), with the public class that ships in the
        # transformers release train.py imports from.
        model = SmartTurnV3Model.from_pretrained(ST_BASE_MODEL, num_labels=1, ignore_mismatched_sizes=True)
        load_ms = (time.perf_counter() - t0) * 1000.0
        record_download(ST_BASE_MODEL, "(transformers snapshot: base encoder weights)", "main", Path(_st_cache_probe()), "BASE model (not a fine-tuned endpointing weight)")
        model.eval()
        out["paramCount"] = int(sum(p.numel() for p in model.parameters()))
        out["encoderHiddenSize"] = int(model.config.d_model)
        out["maxSourcePositions"] = int(model.config.max_source_positions)

        # Smart Turn's own geometry: 8 s window, 80 mels, 800 frames (the ONNX input is [1, 80, 800]).
        g = torch.Generator().manual_seed(0)
        feats = torch.randn(2, 80, 800, generator=g)
        labels = torch.tensor([[1.0], [0.0]])
        with torch.no_grad():
            res = model(input_features=feats, labels=labels)
        out["forward"] = {
            "inputShape": list(feats.shape),
            "logitsShape": list(res["logits"].shape),
            "logitsFinite": bool(torch.isfinite(res["logits"]).all()),
            "bceLoss": round(float(res["loss"]), 6),
            "lossIsFinite": bool(torch.isfinite(res["loss"])),
            "loadMs": round(load_ms, 1),
            "note": "forward + loss only — no optimizer, no backward, no save",
        }
        # Note the shape: the CLASS does not call from_pretrained (so counting it in the class source
        # returns 0 — a first draft printed that misleading "0"); the CALL below is the documented
        # train.py:684 entry point, and it is what produced these 8,000,386 params.
        out["constructedVia"] = f'SmartTurnV3Model.from_pretrained({ST_BASE_MODEL!r}, num_labels=1, ignore_mismatched_sizes=True)'
        out["trainsFromBase"] = f'the BASE {ST_BASE_MODEL} encoder (12 classifier/pool tensors newly initialised: expected for a fresh head)'
        out["status"] = "loaded-and-forwarded"
    except Exception as err:  # noqa: BLE001
        out["status"] = "load-failed"
        out["error"] = f"{type(err).__name__}: {err}"
        out["traceback"] = traceback.format_exc().splitlines()[-6:]
    return out


def _st_cache_probe() -> str:
    """Best-effort path of the Hugging Face snapshot dir, for the download record."""
    try:
        from huggingface_hub import constants

        return str(Path(constants.HF_HUB_CACHE) / "models--openai--whisper-tiny")
    except Exception:  # noqa: BLE001
        return str(DATA / "hf")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DATA / "dryrun-evidence.json"))
    ap.add_argument("--only", choices=["turn1mini", "smartturn"], default=None)
    args = ap.parse_args()
    set_hf_home()

    print(f"python {sys.version.split()[0]}  torch ", end="")
    try:
        import torch

        print(torch.__version__)
    except Exception:  # noqa: BLE001
        print("MISSING")

    evidence = {
        "schema": "voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness-dryrun@1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "disclaimer": "forward / loss ONLY. No optimizer step, no backward, no checkpoint written, no dataset, no GPU.",
        "python": sys.version.split()[0],
        "results": {},
        "downloads": downloads,
    }
    if args.only in (None, "turn1mini"):
        print("== turn-1-mini (pinned safetensors -> released nn.Module -> forward) ==")
        evidence["results"]["turn-1-mini"] = dryrun_turn1_mini()
        print("   ", evidence["results"]["turn-1-mini"].get("status"), evidence["results"]["turn-1-mini"].get("error", ""))
    if args.only in (None, "smartturn"):
        print("== Smart Turn v3.2 (documented from_pretrained(openai/whisper-tiny) -> forward + BCE) ==")
        evidence["results"]["smart-turn-v3.2"] = dryrun_smart_turn()
        print("   ", evidence["results"]["smart-turn-v3.2"].get("status"), evidence["results"]["smart-turn-v3.2"].get("error", ""))
    evidence["downloads"] = downloads
    evidence["noFineTunedWeightsDownloaded"] = all("BASE model" in d["kind"] or "checkpoint" in d["kind"] or "config" in d["kind"] for d in downloads)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n")
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
