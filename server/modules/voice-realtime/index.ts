/**
 * The `voice-realtime` module's public API.
 *
 * TWO SURFACES, ONE BARREL. This module offers a lean half and a runtime half:
 *
 *  - the LEAN half — the Realtime bridge, the six mirrored tool descriptors and
 *    the DashScope transport. `voice-realtime-bridge.service.ts` reaches no
 *    module at runtime, so the bridge itself stays an offline-provable leaf.
 *  - the RUNTIME half — {@link createVoiceRealtimeLiveExecutor}, which by design
 *    imports the MCP gateway's barrel (and, through it, the services a real send
 *    needs). A caller that wires a real connection uses this; a caller that only
 *    drives the bridge relies on the lean half.
 *
 * Both are exported here because a caller outside the module imports from this
 * barrel and nowhere else (the module boundary). Everything else — the guards,
 * the state machine's internals, the field comparison helpers, the executor's
 * refusal vocabulary's internals — stays behind it.
 *
 * Consumers: a later task wires a real Realtime client to `connect` and its
 * executor to `createVoiceRealtimeLiveExecutor`; the criteria read the
 * descriptors through `REALTIME_TOOLS` and drive the executor over fake
 * services.
 */
export {
  DASHSCOPE_REALTIME_ENDPOINT,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_VOICE,
  argumentSchemaViolation,
  createDashscopeTransport,
  toBridgeEvent,
  toDashscopeFrames,
  type DashscopeSocket,
  type DashscopeSocketFactory,
  type DashscopeTransport,
  type DashscopeTransportError,
  type DashscopeTransportOptions,
  type DashscopeWireObserver,
} from './voice-realtime-dashscope-transport.js';
export {
  connect,
  type RealtimeBridge,
  type RealtimeBridgeError,
  type RealtimeBridgeHooks,
  type RealtimeBridgeOptions,
  type RealtimeBridgeState,
  type RealtimeClientMessage,
  type RealtimeFunctionCall,
  type RealtimeFunctionDeclaration,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
  type RealtimeTransport,
} from './voice-realtime-bridge.service.js';
export {
  REALTIME_TOOLS,
  REALTIME_TOOLS_BY_NAME,
  diffToolDescriptors,
  diffToolSchemas,
  type RealtimeToolDescriptor,
  type RealtimeToolName,
  type SchemaFieldMismatch,
  type SchemaFieldMismatchKind,
  type ToolSchemaSection,
} from './voice-realtime-tools.js';
export {
  VoiceRealtimeSessionRefusalError,
  createVoiceRealtimeLiveExecutor,
  type VoiceRealtimeCaller,
  type VoiceRealtimeLiveExecutorDeps,
  type VoiceRealtimeSessionRefusal,
} from './voice-realtime-live-executor.js';
