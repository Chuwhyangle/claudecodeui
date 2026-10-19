// voiceRoutes: used by the server entrypoint to mount authenticated STT/TTS endpoints.
export { voiceRoutes } from './voice.module.js';
// voiceClientAssetRoutes: used by the server entrypoint to serve the browser recogniser's runtime
// and model files same-origin at `/voice-client`, ahead of the static layer and outside the
// authenticated `/api/voice` prefix.
export { voiceClientAssetRoutes } from './voice.module.js';
// readVoiceSettings: used by the server entrypoint's Live Voice realtime assembly point to read the
// signed-in user's saved DashScope key. One narrow read so the entrypoint does not reach into the
// database module's repository for a settings row.
export { readVoiceSettings } from './voice.module.js';
// voiceLexicon: the U-source lexicon singleton. Used by the chat dispatch to
// record the identifier-shaped tokens of every message a user sends — the
// auto-record half of the cold-start-plus-live pair — and by the Voice routes.
export { voiceLexicon } from './voice-lexicon.js';
export type { VoiceLexiconDependencies } from './voice-lexicon.js';
// voice-data: the user's own kept recordings (D1). The store itself is built by
// the composition root, but the directory resolver and the record shape are the
// module's public surface — the correction-feedback track reads a record by id
// and a later readout counts what is on disk from the same resolved directory,
// so neither has to spell the path or the shape a second time.
export { createVoiceDataStore, resolveVoiceDataDir, voiceDataDirStartupLine } from './voice-data.js';
export type {
  VoiceDataRecord,
  VoiceDataRecordInput,
  VoiceDataSegment,
  VoiceDataStore,
} from './voice-data.js';
