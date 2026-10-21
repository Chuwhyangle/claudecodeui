import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// The client shows the installed package version so it can be compared against the
// version the server process is actually running. Reading package.json here and
// injecting it keeps the frontend free of imports that reach outside src/.
const pkg = createRequire(import.meta.url)('./package.json')

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  // Where Vite keeps its dependency pre-bundle. Left unset this is Vite's own default, `node_modules/.vite`,
  // and that default is one mutable directory shared by every checkout: `dispatch-worktree-setup.sh` links
  // each task worktree's `node_modules` to the main checkout's, so the symlink is the same directory for all
  // of them. It is not merely "shared", it is *guaranteed to be rewritten*: Vite's dep-cache staleness check
  // compares a `configHash` that includes `root`, `root` defaults to the process cwd, and a worktree's cwd is
  // by construction a different path from the main checkout's — so a run in a worktree finds the cache the
  // main checkout wrote "stale because vite config has changed" and re-optimizes it, which swaps the
  // `browserHash` in every dependency URL. A page already in flight from another run is holding the old hash
  // and each of its requests then gets `504 (Outdated Optimize Dep)`, losing the React dispatcher mid-render.
  // Pointing this at a directory the caller owns makes the cache private to that caller, so nobody's
  // re-optimization can reach anyone else's in-flight page. Unset, the default is untouched and every other
  // entry point (`npm run dev`, the build) behaves exactly as before.
  //
  // Read through `env` like the ports above: `loadEnv` is called with an empty prefix, so the process
  // environment reaches this object too — the same channel SERVER_PORT and VITE_PORT already travel on.
  const cacheDir = env.VITE_CACHE_DIR || undefined

  return {
    cacheDir,
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // The repository-root shared tree, the same modules the server compiles from
        // ../shared/... . It needs its own alias because the frontend lint override forbids
        // the relative imports that would otherwise be the only way to reach it. This alias
        // is the bundle's copy; vitest.config.ts carries its own, because vitest does not
        // read this file, and tsconfig.json and .oxlintrc.json carry theirs.
        '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
        // elkjs (`@yalehwang/plantuml-js/elk`'s layout engine) has no `browser` field: its bare
        // `main` is `lib/main.js`, the Node entry, which does `require('web-worker')` — an optional
        // Node-only package we deliberately do not install. Vite's dep optimizer resolves that
        // require statically and the whole pre-bundle fails, so the dev server dies on boot and
        // every e2e run in the checkout loses its module graph. `lib/elk.bundled.js` is the
        // browser build (worker inlined, no external requires); upstream's own demo aliases the
        // same bare specifier to it. Aliased for dev and build alike — same module, so the
        // first-screen chunk still never sees it (the import stays dynamic).
        elkjs: fileURLToPath(new URL('./node_modules/elkjs/lib/elk.bundled.js', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      // Host header allowlist (dev server only; this is Vite's DNS-rebinding guard).
      // A leading dot allows the domain itself AND every subdomain, so any zrok share
      // in this zone works — the share name changes on each `zrok share` restart.
      allowedHosts: ['.shares.zrok.io'],
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        // The browser recogniser's runtime and model files. The server serves them same-origin at
        // `/voice-client` in production; in dev this proxy puts them on the same path, so the front
        // end's `BASE_URL`-derived URLs are identical in both.
        '/voice-client': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        // The browser's Realtime voice socket (GOAL-031 / AC-312). Same-origin in
        // dev, the way `/ws` is, so the front end's socket URL needs no
        // environment-specific host and the upstream credential stays on the
        // server that terminates this hop.
        '/voice-realtime': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      // Vite empties outDir on EVERY build pass, and `vite build --watch` re-runs the
      // whole pipeline per change. That would blank dist/ for the length of each rebuild
      // (rollup only writes at the end), so a refresh mid-rebuild 404s. Keeping old
      // hashed chunks also lets a page loaded before the rebuild finish its requests.
      emptyOutDir: false,
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    }
  }
})
