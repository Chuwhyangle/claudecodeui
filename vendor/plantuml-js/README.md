# Vendored `@yalehwang/plantuml-js`

The architecture tab renders through [`@yalehwang/plantuml-js`](https://github.com/yaleh/plantuml-js),
a pure-TypeScript PlantUML class-diagram renderer (ELK layout + SVG emission). The package is
**not published to npm** — `npm view @yalehwang/plantuml-js` returns 404 (checked 2026-10-21) —
so the built tarball is checked in here and `package.json` depends on it by path:

```json
"@yalehwang/plantuml-js": "file:vendor/plantuml-js/yalehwang-plantuml-js-0.1.0.tgz"
```

That keeps the repository self-contained: `npm ci` works from a fresh clone without relying on a
local checkout or a private registry. When the package is published, replace this entry with the
registry version and delete this directory.

## What is inside

- Version: `0.1.0`
- Tarball: `yalehwang-plantuml-js-0.1.0.tgz` (44 kB packed, 184 kB unpacked)
- `sha512` (dist integrity): `sha512-IgESCabJqPMtrAMLKz4PFmjgKgf/wJePq2dtNowCeUZ1kNhw7IErAHF9XHPFrPdGlhhAMdMOgzQi1IuukjpAvQ==`
- `sha512sum`: `22011209a6c9a8f32dac030b2b3e0f1668e02a07ffc0978fab676d368c0279467590d870ec812b00717d5c73c5acf74696184031d30e833422d48bae923a40bd`
- Source: `/data/home/yale/work/plantuml-js` at commit `0cacb14e84883081474b5cf6510fbcb1dca6478c`, plus
  the uncommitted working-tree changes present when the tarball was built (2026-10-21): the
  `./elk` and `./archguard` subpath exports, the ELK-only `core.js`, and the stable
  `data-entity-id` / `data-edge-source` / `data-edge-target` / `data-edge-type` /
  `data-package-id` attributes on the emitted SVG groups.

The architecture tab imports only the `./elk` subpath, which excludes `@viz-js/viz` (the Graphviz
WASM engine). The package still declares `@viz-js/viz` as a dependency, so npm installs it as
well; it is never imported by this repository's bundle.

## Rebuilding the tarball

```bash
cd /data/home/yale/work/plantuml-js
npm run build
npm pack --pack-destination <this-repo>/vendor/plantuml-js
```

Then update the file name/integrity in `package.json` and `package-lock.json` (`npm install
./vendor/plantuml-js/<new>.tgz`) and the hashes above.
