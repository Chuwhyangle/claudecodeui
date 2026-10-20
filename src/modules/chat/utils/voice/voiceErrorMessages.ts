import type { TFunction } from 'i18next';

import type { VoiceTranscriptionFailure } from '@/shared/types';
// The recognition seam's shipped vocabulary, imported as a VALUE: `AsrErrorCode` is a type and a
// type is erased, so the only runtime answer to "which codes are there" is this constant. Reading
// it here rather than writing a list is the whole point — a code added to the vocabulary shows up
// in this mapping with no edit, and a code spelled wrong here cannot compile.
import { ASR_ERROR_CODES } from '@shared/asr/asrRegistry';

/** The key every failure the vocabulary does not name resolves to. */
const FALLBACK_KEY = 'voice.errors.unknown';

/** The namespace path the twelve locales publish this vocabulary under. */
const KEY_PREFIX = 'voice.errors.';

/**
 * The shipped vocabulary, as a lookup. Built once from `ASR_ERROR_CODES`, so membership is decided
 * by the constant rather than by a hand-kept list beside it.
 */
const VOCABULARY: ReadonlySet<string> = new Set(ASR_ERROR_CODES);

/**
 * Which sentence a refusal gets: the key its `code` names, or the fallback key.
 *
 * The single place a code becomes a sentence-key, which is what makes "every code has copy" a
 * property of one function rather than of every place a failure is shown. A code outside the
 * vocabulary and a failure with no code at all both land on the fallback: the first says the
 * backend named something this build does not know, the second that it named nothing — the
 * difference is worth keeping in the payload (see `VoiceTranscriptionFailure`), but there is no
 * different sentence to show for it, and inventing one would be a second opinion about a
 * classification the server already made.
 */
export function voiceErrorKey(failure: VoiceTranscriptionFailure): string {
  const { code } = failure;
  return code !== undefined && VOCABULARY.has(code) ? `${KEY_PREFIX}${code}` : FALLBACK_KEY;
}

/**
 * The localized sentence for a refusal, resolved through the caller's own translator.
 *
 * Takes `t` rather than the i18n instance so the language is the caller's — the composer's, which
 * follows the user's choice — instead of a module-level opinion about which locale is current.
 * Used by chat's `ChatComposer` to turn a refusal into the string its error bubble renders.
 */
export function voiceErrorMessage(failure: VoiceTranscriptionFailure, t: TFunction): string {
  return t(voiceErrorKey(failure));
}

/**
 * The machine-readable half of a refusal, for a technical-detail line: the status the seam answered
 * with, and whichever code strings the answer carried.
 *
 * Deliberately NOT translated. Every part of it is a number or a code string — tokens a reader
 * matches against a log, not prose — and a localized label around them would make the same failure
 * print differently per locale while the part being read stayed identical. Empty when the failure
 * carried neither a status nor a code, which is the honest rendering of "there is no detail here"
 * rather than a placeholder standing in for one.
 */
export function voiceErrorTechnicalDetail(failure: VoiceTranscriptionFailure): string {
  const parts: string[] = [];
  if (typeof failure.status === 'number') parts.push(String(failure.status));
  if (failure.code) parts.push(failure.code);
  if (failure.upstreamCode) parts.push(failure.upstreamCode);
  return parts.join(' · ');
}
