/**
 * The capture half of the voice service: the four seams that read or write the deployment's raw
 * recording switch and the user's own voice-data store.
 *
 * WHY IT IS A SIBLING MODULE RATHER THAN FOUR MORE METHODS ON `voice.service.ts`. These four
 * methods share one subject — the two injected stores (`VoiceCapturePort` for the deployment's
 * diagnostic switch, `VoiceDataStore` for the user's own kept recordings) — and share no state with
 * the transcription path beyond those dependencies. Extracting them leaves `createVoiceService` as
 * the composition of the reading paths plus this seam factory, which is the split this module's
 * conventions already make: `voice-capture.ts` owns the capture port's construction,
 * `voice-data.ts` owns the store, and this file owns the service-visible face over both.
 *
 * IT IS A PURE MOVE. Every body below is the shipping text, unchanged; only the dependency object
 * they close over is now an argument to a factory instead of a binding of `createVoiceService`.
 *
 * Consumed by `server/modules/voice/voice.service.ts`, which spreads the returned object into the
 * service it composes.
 */

import type { VoiceAudioUpload, VoiceDataEditLabel, VoiceServiceResult } from '@/shared/types.js';

import type { VoiceCapturePort } from './voice-capture.js';
// THE USER-DATA STORE IS REACHED AT RUNTIME THROUGH THIS INJECTED PORT AND NEVER THROUGH THIS FILE,
// so the import is a TYPE deliberately — the same discipline `voice.service.ts` keeps for the same
// reason: a value import would add the store's module to the service's runtime graph.
import type { VoiceDataStore } from './voice-data.js';

/**
 * The dependencies the capture seams read, structurally.
 *
 * Declared here rather than imported from `voice.service.ts` so this module cannot become a second
 * entry into the service's dependency shape: both members are optional for the same reason the
 * service's are — a caller that wires no port records nothing and clears nothing, which is the
 * shape every existing rig keeps.
 */
export type VoiceCaptureSeamDependencies = {
  capture?: VoiceCapturePort;
  voiceData?: VoiceDataStore;
};

/**
 * The service-visible capture face: raw-upload storage, its capability reading, and the two
 * user-data operations over the same store.
 *
 * The members are required here even though `VoiceService` declares the last two optional: this
 * factory always answers all four, and a caller composing it into a double that omits them does so
 * through `VoiceService`'s own optional slots.
 */
export type VoiceCaptureSeam = {
  captureRaw(input: { listenId: string; audio: VoiceAudioUpload }): VoiceServiceResult<{ stored: boolean }>;
  captureState(): { raw: boolean };
  clearVoiceData(): { deleted: number };
  labelVoiceData(input: {
    recordId: string;
    finalText: string;
    labels: VoiceDataEditLabel[];
  }): VoiceServiceResult<{ recordId: string }>;
};

/**
 * The ONE message a label write-back owes a client whose recording is no longer there.
 *
 * A single literal for the two ways the record can be missing — an id the store holds nothing for,
 * and a deployment with no store at all — because they are one sentence from the caller's side: the
 * listen this correction belongs to cannot be found. Keeping them one string is what stops a client
 * having to branch on a difference it cannot act on, and it names no id and no path (the same rule
 * `VOICE_DATA_FAILED_LINE` follows).
 */
const LABEL_MISSING_RECORD = 'No such recording.';

/**
 * Builds the capture face of the voice service over the two injected stores.
 *
 * Consumed by `server/modules/voice/voice.service.ts`'s `createVoiceService`, which spreads the
 * result into the object it returns; see this file's header for why the four methods live here.
 */
export function createVoiceCaptureSeam(
  dependencies: VoiceCaptureSeamDependencies,
): VoiceCaptureSeam {
  return {
    captureRaw({ listenId, audio }) {
      // THE GATE IS THE PORT'S OWN SWITCH, read as absent when off — the same shape `recording`
      // uses for the mode. A deployment that does not collect raw records nothing and says so
      // (`stored: false`) rather than failing: the request is well-formed, the capability is absent.
      const port = dependencies.capture?.raw === true ? dependencies.capture : null;
      if (port?.recordRaw === undefined) {
        return { ok: true, value: { stored: false } };
      }

      // THE SAME LOCAL GUARD the attempt recorder has, and for the same reason: the port is an
      // injected seam, and a deployment's own port may throw where this module's answers. A throw
      // here must not escape as a rejected handler — it becomes a refusal, and the file the caller
      // was told about is not written.
      try {
        port.recordRaw({ listenId, bytes: audio.bytes });
      } catch {
        return { ok: false, status: 500, error: 'Raw capture failed.' };
      }

      return { ok: true, value: { stored: true } };
    },

    captureState() {
      return { raw: dependencies.capture?.raw === true };
    },

    // THE CLEAR HALF OF THE USER-DATA STORE, and for the same reason `captureState` reads the port
    // rather than the environment: the store IS the port, so a caller that wired none — a probe, a
    // test — answers "nothing to clear" rather than failing, which is the same success a user who
    // never recorded gets. The count is whatever the store removed; this path never invents one.
    clearVoiceData() {
      return dependencies.voiceData?.clear() ?? { deleted: 0 };
    },

    // THE OTHER HALF OF THE SAME PORT, and the one that makes a record worth keeping: the text the
    // user sent and the pairs their edit produced, written back onto the listen they came from.
    //
    // A MISS IS A REFUSAL, NOT A THROW. The store answers `false` for an id it holds no record for,
    // and that becomes the `404` the client is owed — the record may have been evicted by the
    // capacity ceiling or removed by the user since the transcription, and neither is a failure of
    // this request. A store that THROWS is the bug path the transcribe route already guards, and it
    // is answered the same way here: a `500` rather than a rejected handler.
    labelVoiceData(input) {
      const store = dependencies.voiceData;
      if (store === undefined) {
        return { ok: false, status: 404, error: LABEL_MISSING_RECORD };
      }

      try {
        return store.label(input)
          ? { ok: true, value: { recordId: input.recordId } }
          : { ok: false, status: 404, error: LABEL_MISSING_RECORD };
      } catch {
        return { ok: false, status: 500, error: 'Writing the correction labels failed.' };
      }
    },
  };
}
