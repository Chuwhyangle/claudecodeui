/**
 * Public barrel for the model-library feature: the model catalog and custom-model
 * editor shared by chat, chat-support and settings. Every cross-module import of
 * this module goes through this file; internal code keeps deep specifiers.
 */
export type { CodexProviderBindRequest } from '@/modules/model-library/ModelLibraryPanel';
export { default as ModelLibraryPanel } from '@/modules/model-library/ModelLibraryPanel';
