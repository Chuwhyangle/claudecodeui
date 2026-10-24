# Fixture repo for `scripts/contraction-candidates/scan.mjs`

This directory is documentation only. The fixture is **materialised at test time** by
`scripts/contraction-candidates/scan.test.mjs` in a fresh `mkdtemp` directory, then committed
there with `git init` + `git commit`.

## Why it is not checked in as files

The scanner walks the repo it is pointed at. If a miniature "instrument that never fires" lived
here as checked-in code and state, every real scan of `claudecodeui` (whose root contains
`scripts/`) would report its own fixture as a contraction candidate. Building the fixture in a
temp directory keeps this repo's scan honest.

## Shape the test materialises

```
<tmp>/
├── .quay/
│   ├── gate-events.jsonl        # gate "always-green": 6 pass, 0 fail
│   │                            # gate "sometimes-red": 4 pass, 1 fail
│   ├── never-read.json          # written by src/writer.mjs, read by nothing
│   └── has-reader.json          # written by src/writer.mjs, read by src/reader.mjs
├── src/
│   ├── writer.mjs               # writeFileSync(...never-read.json / has-reader.json)
│   └── reader.mjs               # readFileSync(...has-reader.json)
└── docs/                        # live.md referenced by index.md; orphan.md not referenced
```

## Readings the test asserts

| Reading | Expected |
| --- | --- |
| `gate:always-green` | reported as `never-red-gate` |
| `gate:sometimes-red` | **not** reported as `never-red-gate` (it has a fail record) |
| `state:.quay/never-read.json` | reported as `zero-reader-state-file` |
| `state:.quay/has-reader.json` | **not** reported (negative control: a read call exists) |
| `git status --porcelain` before vs after | identical (the scan is read-only) |
| every candidate | non-empty `evidence[]` and non-empty `counterCheck` |
