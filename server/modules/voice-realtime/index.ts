/**
 * The `voice-realtime` module's public API.
 *
 * The Realtime bridge and the six mirrored tool descriptors are the whole of
 * what this module offers; everything else (the guards, the state machine's
 * internals, the field comparison helpers) stays behind this barrel. A caller
 * outside the module imports from here and nowhere else — that is the module
 * boundary, and it is what keeps the bridge a leaf that pulls in no other
 * module's runtime.
 *
 * Consumers: a later task wires a real Realtime client to `connect`, and the
 * criteria read the descriptors through `REALTIME_TOOLS`.
 */
export {
  DASHSCOPE_REALTIME_ENDPOINT,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
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
