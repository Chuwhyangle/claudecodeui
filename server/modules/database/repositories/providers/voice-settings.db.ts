import {
  VOICE_SETTINGS_EMPTY_DOCUMENT,
  VOICE_SETTINGS_STRING_FIELDS,
} from '@shared/voice/voiceSettingsRegistry.js';
import { getConnection } from '@/modules/database/core/index.js';
import type { VoiceSettings } from '@/shared/types.js';

type VoiceSettingsRow = {
  settings_json: string;
};

/**
 * Every field of a settings document, in one place so readers and writers agree.
 *
 * THE LIST IS THE SHARED CONTRACT'S, NOT A COPY. This array is what `decodeSettings` reads a
 * stored document through, so a field missing from it is silently DROPPED on the way back out — a
 * user would save a workspace address and their key, read the document back, and find both gone,
 * with nothing anywhere reporting it. Keeping it in the same module that declares the type (and
 * that the browser reads its own field list from) is what makes adding a field a one-place change
 * instead of a field that exists in the type and nowhere in the storage loop.
 */
const VOICE_SETTINGS_FIELDS = VOICE_SETTINGS_STRING_FIELDS;

/**
 * What a user who has never saved voice settings reads back as, from the contract's own empty
 * document.
 *
 * The provider-owned fields are present and empty there for the same reason the six are: a document
 * that omits them and one that carries the empty string mean the same thing to every reader, and
 * having exactly one shape cross the wire is what lets a client compare whole documents.
 */
const EMPTY_VOICE_SETTINGS: VoiceSettings = VOICE_SETTINGS_EMPTY_DOCUMENT;

/**
 * Coerces one stored document into a complete `VoiceSettings`.
 *
 * A row written by an older or newer build may be missing fields or hold
 * non-strings; both are read as "unset" rather than failing the request, so a
 * single bad field can never cost the user the rest of their configuration.
 */
function decodeSettings(raw: string): VoiceSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[VoiceSettings] Dropping unreadable settings document');
    return { ...EMPTY_VOICE_SETTINGS };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...EMPTY_VOICE_SETTINGS };
  }

  const source = parsed as Record<string, unknown>;
  const settings = { ...EMPTY_VOICE_SETTINGS };
  for (const field of VOICE_SETTINGS_FIELDS) {
    const value = source[field];
    if (typeof value === 'string') {
      settings[field] = value;
    }
  }

  // THE TWO USER-DATA FIELDS ARE NOT IN `VOICE_SETTINGS_FIELDS`, because that list is the STRING
  // fields and these are a boolean and a number; they are decoded here so a document that carries
  // them round-trips. THEY ARE NOT IN `EMPTY_VOICE_SETTINGS` EITHER, and that is deliberate: a user
  // who never saved has no such keys, and the store's own default (recording on, 2 GiB) is what
  // applies then. Adding them to the empty document would make the never-saved shape carry a
  // `voiceDataRecording: true` the store already implies, and would break every reader that compares
  // that document for exactly ten string fields. An absent key here therefore means "unset", which
  // the store reads as the default rather than as "off".
  if (typeof source.voiceDataRecording === 'boolean') {
    settings.voiceDataRecording = source.voiceDataRecording;
  }
  if (typeof source.voiceDataMaxBytes === 'number' && Number.isFinite(source.voiceDataMaxBytes)) {
    settings.voiceDataMaxBytes = source.voiceDataMaxBytes;
  }

  return settings;
}

/**
 * Reads and writes the per-user Voice backend settings table.
 *
 * Used by the Voice module to serve `GET`/`PUT /api/voice/config`; the values it
 * returns are the ones the browser later calls its own backend with, so this
 * repository never sends a request of its own.
 */
export const voiceSettingsDb = {
  /** Returns the user's stored settings, or the all-empty set when none are stored. */
  getSettings(userId: number): VoiceSettings {
    const row = getConnection()
      .prepare('SELECT settings_json FROM user_voice_settings WHERE user_id = ?')
      .get(userId) as VoiceSettingsRow | undefined;

    return row ? decodeSettings(row.settings_json) : { ...EMPTY_VOICE_SETTINGS };
  },

  /**
   * Replaces the user's settings document as a whole.
   *
   * One row per user, so this is a plain upsert: there is no partial-update
   * shape to reconcile, and a caller that intends to change one field reads the
   * document first and writes the whole of it back.
   */
  saveSettings(userId: number, settings: VoiceSettings): void {
    getConnection()
      .prepare(
        `INSERT INTO user_voice_settings (user_id, settings_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           settings_json = excluded.settings_json,
           updated_at = CURRENT_TIMESTAMP`
      )
      .run(userId, JSON.stringify(settings));
  },
};
