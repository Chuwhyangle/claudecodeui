#!/usr/bin/env tsx
/**
 * The command line's face of the voice transcription chain (ADR-004 decision 2).
 *
 * The point of this entry point is not that a terminal can transcribe a file — it is that the
 * SAME module the browser and the server compile can be driven from outside them. Until this
 * existed, "prove the shipping implementation is correct against a new recognition service" had no
 * object to call: the only thing that spoke the wire protocol lived inline in a React hook and a
 * server method, so any experiment would have had to re-implement it and would then have been
 * measuring the re-implementation. This file therefore imports shared/asr/contract/transcriptionWire.ts
 * rather than repeating any of it, and every mode below hands the request building and the response
 * parsing to that module.
 *
 * Started with `npx tsx`, not bare `node`: the wire module is compiled by the server's NodeNext
 * configuration, whose relative import specifiers carry a `.js` extension, and bare node resolves
 * those literally (there is no `.js` on disk next to the `.ts` source). tsx maps the specifier for
 * us. That is a property of the LAUNCH, not a label this file prints, so the evidence
 * (`ASR-CLI-LAUNCH execArgv=… tsxEnv=…`) is written raw to stderr and the criterion derives the
 * launcher from it. `tsxEnv` is printed but is deliberately NOT decisive: it is inherited by a
 * bare-node child of a tsx-launched parent, so on its own it would report `tsx` for a process node
 * started itself (measured in this repository's worker environment).
 *
 * MODES
 *
 *   (default)               build the request, send it, print the transcript
 *   --dry-run               build the request, print it redacted, send nothing
 *   --offline <rec.json>    answer from a recording instead of the network
 *   --record <out.json>     the one mode that reaches the network; not a criterion (ADR-004 dec. 8)
 *   --explain-sites         print the absolute paths and symbols every mode drives
 *
 * INJECTION
 *
 *   --fetch-impl <module>   a module whose default export replaces fetch. It is injected, never
 *                           discovered: a criterion supplies a double that records its calls, so
 *                           "a request happened" is a reading rather than a claim.
 *   --api-key-env <VAR>     read the bearer token from a named variable, which is how a criterion
 *                           passes a constant of its own making instead of a real credential.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createTranscriptionRequest, parseTranscriptionResponse } from '../../shared/asr/contract/transcriptionWire.js';
import type { TranscriptionTarget, TranscriptionUpload, TranscriptionTolerance } from '../../shared/asr/contract/transcriptionWire.js';
import { runDryRun, sha256Hex } from './dryRun.js';
import type { FetchLike } from './dryRun.js';
import { loadRecording, runOfflineReplay, runRecord } from './offlineReplay.js';

const USAGE_LINE =
  'usage: npx tsx experiments/voice-asr-cli/transcribe.ts --audio <file> --base-url <url> [--api-key <key>] [--model <name>]';

const USAGE_NOTES = [
  '  --audio        path to the recording to transcribe (required)',
  '  --base-url     the OpenAI-compatible endpoints base, e.g. https://api.groq.com/openai/v1 (required)',
  '  --api-key      bearer token for that endpoint (optional; omitted sends no Authorization header)',
  '  --api-key-env  name of the variable holding the bearer token, read at call time (preferred over',
  '                 --api-key when a caller wants to inject a credential rather than spell one)',
  '  --model        transcription model name (default: whisper-1)',
  '  --dry-run      print the request redacted and send nothing',
  '  --offline      replay the recorded answer in <rec.json> instead of the network',
  '  --tolerance    strict | lenient — which shipping tolerance a replay reads the answer under',
  '  --record       send once and write the answer, with both tolerances, to <out.json>',
  '  --record-source  a label recorded into the provenance of --record output',
  '  --fetch-impl   module whose default export replaces fetch (the criterion injects a double here)',
  '  --explain-sites  print the absolute path and symbol of every module the modes drive, then exit',
  '',
  'The request is built and the answer is read by shared/asr/contract/transcriptionWire.ts — the same',
  'module the browser and the server compile, so a reading taken here is a reading of the',
  'shipping implementation rather than of a copy of it.',
].join('\n');

/** The container the recogniser is told the bytes have, from the file's own extension. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
};

/** The relative specifier this file imports the wire implementation through. */
const ADAPTER_SPECIFIER = '../../shared/asr/contract/transcriptionWire.js';

/** The symbols the modes below drive out of the shipping tree. */
const DRIVEN_SYMBOLS = ['createTranscriptionRequest', 'parseTranscriptionResponse'];

type Options = {
  audioPath: string;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  model: string;
  dryRun: boolean;
  offlinePath: string;
  tolerance: string;
  recordPath: string;
  recordSource: string;
  fetchImpl: string;
  explainSites: boolean;
};

/**
 * Reads the documented flags, or returns null so the caller prints the usage line. Unknown flags
 * are refused rather than ignored: a typo'd `--base-url` that silently fell back to a default would
 * send a recording somewhere the caller did not name.
 */
function parseArgs(argv: readonly string[]): Options | null {
  const options: Options = {
    audioPath: '',
    baseUrl: '',
    apiKey: '',
    apiKeyEnv: '',
    model: 'whisper-1',
    dryRun: false,
    offlinePath: '',
    tolerance: '',
    recordPath: '',
    recordSource: '',
    fetchImpl: '',
    explainSites: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--audio':
        options.audioPath = value;
        i += 1;
        break;
      case '--base-url':
        options.baseUrl = value;
        i += 1;
        break;
      case '--api-key':
        options.apiKey = value;
        i += 1;
        break;
      case '--api-key-env':
        options.apiKeyEnv = value;
        i += 1;
        break;
      case '--model':
        options.model = value;
        i += 1;
        break;
      case '--offline':
        options.offlinePath = value;
        i += 1;
        break;
      case '--tolerance':
        options.tolerance = value;
        i += 1;
        break;
      case '--record':
        options.recordPath = value;
        i += 1;
        break;
      case '--record-source':
        options.recordSource = value;
        i += 1;
        break;
      case '--fetch-impl':
        options.fetchImpl = value;
        i += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--explain-sites':
        options.explainSites = true;
        break;
      default:
        return null;
    }
  }

  if (options.explainSites) return options;
  if (!options.audioPath || !options.baseUrl) return null;
  if (options.offlinePath && options.tolerance !== 'strict' && options.tolerance !== 'lenient') return null;
  return options;
}

/**
 * The raw launch evidence, printed rather than interpreted.
 *
 * A launcher this file PRINTED would be a self-report; the criterion derives `tsx`/`node` from these
 * two values instead, which is why they are the runtime's own (`process.execArgv`, the presence of
 * the variable tsx exports) and not a literal.
 */
function writeLaunchEvidence(): void {
  const evidence = { execArgv: [...process.execArgv], tsxEnv: 'TSX_TSCONFIG_PATH' in process.env };
  process.stderr.write(`ASR-CLI-LAUNCH execArgv=${JSON.stringify(evidence.execArgv)} tsxEnv=${evidence.tsxEnv}\n`);
}

/**
 * The absolute path the adapter implementation is loaded from.
 *
 * `import.meta.resolve` reports the specifier as written, and the specifier is the `.js` the server's
 * NodeNext configuration emits; on disk that file is the `.ts` source. The fallback applies the same
 * mapping the loader applies, so this reports the file that was actually driven rather than the name
 * that was asked for.
 */
function adapterRealPath(): string {
  const asWritten = fileURLToPath(import.meta.resolve(ADAPTER_SPECIFIER));
  if (existsSync(asWritten)) return realpathSync(asWritten);
  if (asWritten.endsWith('.js')) {
    const source = `${asWritten.slice(0, -3)}.ts`;
    if (existsSync(source)) return realpathSync(source);
  }
  return asWritten;
}

/** `--explain-sites`: where each driven symbol actually lives, as an absolute path. */
function explainSites(): number {
  const cliPath = realpathSync(fileURLToPath(import.meta.url));
  process.stdout.write(`ASR-CLI-SITE cli ${cliPath} symbol=main\n`);
  const adapterPath = adapterRealPath();
  for (const symbol of DRIVEN_SYMBOLS) {
    process.stdout.write(`ASR-CLI-SITE adapter ${adapterPath} symbol=${symbol}\n`);
  }
  return 0;
}

/**
 * Loads the module `--fetch-impl` named, or null when it was not given.
 *
 * A path is resolved against the working directory and a URL scheme is taken as-is, so a criterion
 * can point at a file in the tree it is driving or at a `data:` URL it built inline.
 */
async function loadTransport(specifier: string): Promise<FetchLike | null> {
  if (!specifier) return null;
  const target = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)
    ? specifier
    : pathToFileURL(resolve(process.cwd(), specifier)).href;
  const loaded = (await import(target)) as { default?: FetchLike };
  if (typeof loaded.default !== 'function') {
    throw new Error(`--fetch-impl ${specifier} has no default export function`);
  }
  return loaded.default;
}

/** The bearer token, from the variable the caller named rather than from a guess at the ambient env. */
function apiKeyFrom(options: Options): string {
  if (!options.apiKeyEnv) return options.apiKey;
  const value = process.env[options.apiKeyEnv] ?? '';
  if (!value) throw new Error(`--api-key-env ${options.apiKeyEnv} is unset or empty`);
  return value;
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (!options) {
    process.stdout.write(`${USAGE_LINE}\n`);
    process.stdout.write(`${USAGE_NOTES}\n`);
    return 2;
  }

  writeLaunchEvidence();

  if (options.explainSites) return explainSites();

  const target: TranscriptionTarget = {
    baseUrl: options.baseUrl,
    apiKey: apiKeyFrom(options),
    model: options.model,
  };

  const bytes = readFileSync(options.audioPath);
  const mimeType = MIME_BY_EXTENSION[extname(options.audioPath).toLowerCase()] || 'audio/webm';
  const upload: TranscriptionUpload = {
    audio: new Blob([bytes], { type: mimeType }),
    fileName: basename(options.audioPath),
  };

  // Loaded for every mode, including the two that must not send through it: a transport that was
  // never loaded cannot be the thing a criterion moves to ask whether a mode really stayed offline.
  const transport = await loadTransport(options.fetchImpl);

  if (options.dryRun) return runDryRun(target, upload, transport);

  if (options.recordPath) {
    return runRecord({
      recordingPath: options.recordPath,
      source: options.recordSource || options.fetchImpl || 'global fetch',
      target,
      upload,
      audio: {
        name: upload.fileName,
        mimeType,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
      },
      transport,
    });
  }

  if (options.offlinePath) {
    return runOfflineReplay({
      recording: loadRecording(options.offlinePath),
      target,
      upload,
      tolerance: options.tolerance as TranscriptionTolerance,
      injectedTransport: transport,
    });
  }

  const request = createTranscriptionRequest(target, upload);
  const send = transport ?? fetch;
  const response = await send(request.url, request.init);
  if (!response.ok) {
    process.stderr.write(`transcribe: ${response.status} ${await response.text()}\n`);
    return 1;
  }

  // `strict` here, unlike the proxy path: this is a diagnostic, so a malformed answer has to be
  // visible as a failure rather than printed as if it were a transcript.
  process.stdout.write(`${await parseTranscriptionResponse(response, 'strict')}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`transcribe: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
