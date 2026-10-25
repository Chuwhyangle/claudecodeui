# voice-tse-eval

Offline validation of target-speaker extraction (TSE) on the samples selected in
`/tmp/speaker-gate-audition-2026-10-20/`.

- **Read the result:** [`REPORT.md`](./REPORT.md) (TSE implementations) and [`CONFIRMED-LABELS.md`](./CONFIRMED-LABELS.md) (user-confirmed labels, model/threshold/selector).
- **Main matrix:** `run_eval.py` — 6 targets × 6 conditions × 11 methods;
  writes `out/results_all.csv` and `out/summary_all.json`.
- **Vanta pilot:** `run_vanta.py` — Chinese targets + English control; writes `out/vanta_pilot.csv`.
- **Session-local streaming:** `run_live.py` — target speaks first for 4 s,
  then an interferer joins; compares `vox_stream`, `vox_live`, `vox_isolate`;
  writes `out/live_results.csv`.
- **Raw readings:** `out/part{1,2,3}/results.csv`, `out/live_results.csv`.

No audio is committed. The scripts read the audition set from
`/tmp/speaker-gate-audition-2026-10-20/` and models from `/tmp/tse-eval-models/`
(GTCRN, CAM++) and `/tmp/OpenSpeakerBeam-SS/checkpoints/` (OSB). Vanta is
cloned at `/tmp/Vanta` with `scripts/download_weights.py`. VoxLock downloads
its ONNX weights from Hugging Face on first use.

Headline: VoxLock with a **session-local** 3–4 s sample gives a median
**+10.1 dB** SI-SDRi in streaming mode; a **cross-session** pre-enrolled
voiceprint fails (median −3 to −15 dB, worst −68 dB). Raw-audio CAM++ cosine is
already ~0.92 at 0 dB, so use the gate for identity and TSE only to clean the
audio sent to ASR.
