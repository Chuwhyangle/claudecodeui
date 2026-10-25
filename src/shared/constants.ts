import {
  Bell,
  Bot,
  GitBranch,
  Info,
  KeyRound,
  ListChecks,
  MonitorPlay,
  Palette,
  Plug,
} from 'lucide-react';
import type { ComponentType } from 'react';

import type {
  FileStatusCode,
  LLMProvider,
  McpProvider,
  McpScope,
  McpTransport,
  QuayInFlightPhase,
  SettingsMainTab,
} from '@/shared/types';
import type { UserPreferenceKey } from '@/shared/userSettings';

/** The four buckets the git changes view sorts working-tree files into. */
type GitStatusFileGroup = 'modified' | 'added' | 'deleted' | 'untracked';

//----------------- BRANDING ------------

/**
 * Font stack used to render the CloudCLI wordmark consistently wherever the brand name
 * appears as text. Apply it inline so the wordmark does not inherit a themed font.
 */
export const CLOUDCLI_WORDMARK_FONT_FAMILY =
  'ui-sans-serif, system-ui, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji';

// ---------------------------

//----------------- APPLICATION VERSION ------------

/**
 * Version of the installed package, baked into the client bundle at build time.
 * Compare it with the version reported by `/health` to detect a package that was
 * updated without restarting the server. Empty outside a Vite build (for example
 * under the `tsx` test runner), where no build-time value is injected.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

// ---------------------------

//----------------- SETTINGS NAVIGATION ------------

/** Shape of one entry in `SETTINGS_MAIN_TABS`; only that constant needs it. */
type SettingsMainTabMeta = {
  id: SettingsMainTab;
  label: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
};

/**
 * The ordered list of top-level settings tabs. The settings sidebar renders it directly and
 * the command palette turns each entry into an "open settings" command, so both stay in sync.
 */
export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  { id: 'agents', label: 'Agents', keywords: 'agents subagents claude code', icon: Bot },
  { id: 'appearance', label: 'Appearance', keywords: 'appearance theme dark light language', icon: Palette },
  { id: 'git', label: 'Git', keywords: 'git github commits', icon: GitBranch },
  { id: 'api', label: 'API Tokens', keywords: 'api tokens auth keys', icon: KeyRound },
  { id: 'tasks', label: 'Tasks', keywords: 'tasks taskmaster', icon: ListChecks },
  { id: 'browser', label: 'Browser', keywords: 'browser playwright chromium automation', icon: MonitorPlay },
  { id: 'notifications', label: 'Notifications', keywords: 'notifications alerts push', icon: Bell },
  { id: 'plugins', label: 'Plugins', keywords: 'plugins extensions integrations', icon: Plug },
  { id: 'about', label: 'About', keywords: 'about version info', icon: Info },
];

// ---------------------------

//----------------- CHAT REASONING EFFORT ------------

/**
 * Sentinel effort value meaning "use whatever the model defaults to". The composer's model
 * menu renders it as the first choice and the provider state treats it as "no explicit effort".
 */
export const DEFAULT_EFFORT_VALUE = 'default';

// ---------------------------

//----------------- FILE UPLOAD LIMITS ------------

/** Largest single file the upload endpoint accepts, in megabytes. Source of truth for the two derived limits below. */
export const MAX_FILE_UPLOAD_SIZE_MB = 200;

/** `MAX_FILE_UPLOAD_SIZE_MB` in bytes, for comparing against `File.size` before uploading. */
export const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;

/** Human-readable form of the size limit, shown in the file tree header and in upload errors. */
export const MAX_FILE_UPLOAD_SIZE_LABEL = `${MAX_FILE_UPLOAD_SIZE_MB}MB`;

// ---------------------------

//----------------- GIT CHANGE GROUPS ------------

/** Shape of one entry in `FILE_STATUS_GROUPS`; only that constant needs it. */
type GitStatusGroupEntry = {
  key: GitStatusFileGroup;
  status: FileStatusCode;
};

/**
 * The order in which the git changes view groups files, and the status code each group holds.
 * Both the change list and the status-grouping helper iterate it so the two stay aligned.
 */
export const FILE_STATUS_GROUPS: GitStatusGroupEntry[] = [
  { key: 'modified', status: 'M' },
  { key: 'added', status: 'A' },
  { key: 'deleted', status: 'D' },
  { key: 'untracked', status: 'U' },
];

// ---------------------------

//----------------- MCP SERVER CAPABILITIES ------------

/** Display name for each provider that can host MCP servers, used in headings and buttons. */
export const MCP_PROVIDER_NAMES: Record<McpProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Scopes each provider can install an MCP server into; drives the scope selector and validation. */
export const MCP_SUPPORTED_SCOPES: Record<McpProvider, McpScope[]> = {
  claude: ['user', 'project', 'local'],
  cursor: ['user', 'project'],
  codex: ['user', 'project'],
  opencode: ['user', 'project'],
};

/** Transports each provider can talk to an MCP server over; drives the transport selector and validation. */
export const MCP_SUPPORTED_TRANSPORTS: Record<McpProvider, McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
  cursor: ['stdio', 'http'],
  codex: ['stdio', 'http'],
  opencode: ['stdio', 'http'],
};

/** Transports offered when configuring a global (provider-agnostic) MCP server. */
export const MCP_GLOBAL_SUPPORTED_TRANSPORTS: McpTransport[] = ['stdio', 'http'];

/** Whether a provider honours an MCP server's working-directory setting; the form hides the field when it does not. */
export const MCP_SUPPORTS_WORKING_DIRECTORY: Record<McpProvider, boolean> = {
  claude: false,
  cursor: false,
  codex: true,
  opencode: false,
};

// ---------------------------

//----------------- QUICK SETTINGS PANEL ROWS ------------

/**
 * Class list for one row in the quick settings panel. Shared so plain rows and the clickable
 * toggle row (which appends `cursor-pointer`) stay visually identical.
 */
export const SETTING_ROW_CLASS =
  'flex items-center justify-between p-3 rounded-lg bg-muted/60 hover:bg-accent transition-colors border border-transparent hover:border-border';

// ---------------------------

//----------------- TERMINAL TIMING ------------

/**
 * Delay before the terminal is measured and fitted after it is attached. Gives the browser one
 * layout pass so the initial fit and the resize message sent to the backend use real dimensions.
 */
export const TERMINAL_INIT_DELAY_MS = 100;

// ---------------------------

//----------------- CODE EDITOR DISPLAY SETTINGS ------------

/**
 * The four localStorage keys the code-editor display settings used to live
 * under, kept only so `userSettings` can migrate an existing install onto the
 * stored `codeEditorSettings` preference. Nothing writes them any more.
 */
export const CODE_EDITOR_STORAGE_KEYS = {
  wordWrap: 'codeEditorWordWrap',
  showMinimap: 'codeEditorShowMinimap',
  lineNumbers: 'codeEditorLineNumbers',
  fontSize: 'codeEditorFontSize',
} as const;

/**
 * Values applied when a code-editor setting has never been written. These are
 * the editor's own historical defaults; the settings dialog used to carry its
 * own copy with a different fontSize, so merely opening it rewrote the user's
 * editor font.
 */
export const CODE_EDITOR_DEFAULTS = {
  wordWrap: false,
  showMinimap: true,
  lineNumbers: true,
  fontSize: '12',
} as const;


// ---------------------------

//----------------- PROVIDER TOOL SETTINGS STORAGE ------------

/**
 * Per-provider preference key holding that provider's tool-permission
 * settings, sent with every `chat.send`.
 *
 * `opencode` intentionally maps to its own key even though no settings UI
 * writes it yet: without the entry the lookup would fall through to Claude's
 * key and OpenCode sessions would silently inherit Claude's `skipPermissions`.
 */
export const PROVIDER_PERMISSION_PREFERENCE_KEYS: Record<LLMProvider, UserPreferenceKey> = {
  claude: 'claudePermissions',
  cursor: 'cursorPermissions',
  codex: 'codexPermissions',
  opencode: 'opencodePermissions',
};

// ---------------------------

//----------------- PERSONAL ACCESS TOKEN SCOPES ------------

/**
 * The five scopes a personal access token may carry, in the order the create
 * form renders them, each paired with whether it grants write access and with
 * the `settings` i18n leaf that labels it.
 *
 * `cloudcli:read` is the required baseline every token carries and is the only
 * non-writable scope; the five write scopes are opt-in, and checking any of them
 * is what makes the create form raise its write-access risk note. The vocabulary
 * mirrors the server's `ACCESS_TOKEN_SCOPES` (`server/modules/oauth`), which
 * rejects anything outside it. `labelKey` is an alias rather than the raw scope
 * because i18next treats `:` as its namespace separator, so a scope id cannot be
 * used as an i18n key directly.
 */
export const ACCESS_TOKEN_SCOPE_OPTIONS: readonly {
  scope: string;
  writable: boolean;
  labelKey: string;
}[] = [
  { scope: 'cloudcli:read', writable: false, labelKey: 'read' },
  { scope: 'cloudcli:session:send', writable: true, labelKey: 'sessionSend' },
  { scope: 'cloudcli:session:create', writable: true, labelKey: 'sessionCreate' },
  { scope: 'cloudcli:session:control', writable: true, labelKey: 'sessionControl' },
  { scope: 'cloudcli:approve', writable: true, labelKey: 'approve' },
  // gap-mcp-ui-open-session: opens a session in one of the user's browsers. A
  // write scope — it changes what the user's screen shows.
  { scope: 'cloudcli:navigate', writable: true, labelKey: 'navigate' },
];

// ---------------------------

//----------------- QUAY PULSE ------------

/*
 * The three visual vocabularies the Quay tab's Loop pulse card and the title bar's pulse
 * trigger/popover share. They live here — not in either component — because a second copy is
 * exactly how the two surfaces would start drawing the same reading differently: the trigger's
 * bars are compared against the card's by class, and the popover's phase badges against the
 * in-flight card's. Every consumer imports these declarations, so equality is structural.
 */

/**
 * Text colour per gantt bar state, on the palette `TimelineBar` and the panel's status dots use.
 *
 * Every state carries its own class: quay publishes *which* states exist but never what colour
 * they are, and two states sharing a colour would make the gantt silently unreadable (a `failed`
 * run indistinguishable from a `timed-out` one).
 */
export const QUAY_STATE_TEXT_CLASSES: Record<string, string> = {
  implementing: 'text-blue-500',
  'fan-in': 'text-violet-500',
  'awaiting-land': 'text-amber-500',
  landed: 'text-green-500',
  completed: 'text-emerald-600',
  failed: 'text-red-600',
  killed: 'text-rose-400',
  'timed-out': 'text-orange-600',
  'exited-not-landed': 'text-yellow-600',
};

/** The colour a bar falls back to when quay publishes a state this build does not know. */
export const QUAY_DEFAULT_STATE_TEXT_CLASS = 'text-gray-400';

/** The state key used when an interval has neither an in-flight phase nor a terminal state. */
export const QUAY_UNKNOWN_STATE = 'unknown';

/**
 * Coarse goal completion percentage for the Stage goals progress bar. `quay goal list --json`
 * carries no completion ratio, so the bar is a status-derived visual aid only — the status
 * text next to it is authoritative.
 */
export const QUAY_GOAL_STATUS_PERCENT: Record<string, number> = {
  achieved: 100,
  superseded: 100,
  active: 50,
};

/**
 * Visible label, colour class and SPOKEN colour per in-flight phase, covering every phase quay
 * publishes (`QuayInFlightPhase`). The phases must render as *different* markers (text, colour
 * and `data-testid`), so a reader — and the test that guards it — can never mistake a task
 * parked in fan-in for one still being implemented. `color` is the same bucket the view
 * contract publishes as a display attribute, kept here so 「红的那个」 and the drawn marker
 * cannot drift apart.
 */
export const QUAY_IN_FLIGHT_PHASE_META: Record<
  QuayInFlightPhase,
  { label: string; className: string; color: string }
> = {
  implementing: {
    label: 'implementing',
    className: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
    color: 'blue',
  },
  'fan-in': {
    label: 'fan-in',
    className: 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
    color: 'violet',
  },
  'awaiting-land': {
    label: 'awaiting land',
    className: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    color: 'amber',
  },
  landed: {
    label: 'landed',
    className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    color: 'green',
  },
};

/**
 * The classes every quay task badge shares before its state colour is appended. The in-flight
 * card and the title bar popover both build their badge as `cn(base, colourClass)`; sharing the
 * base is what makes a phase badge in the two surfaces byte-identical.
 */
export const QUAY_TASK_BADGE_BASE_CLASS = 'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium';

/**
 * Badge colour per stored task status that is not an in-flight phase, written the same
 * `bg-X-50 text-X-700 dark:bg-X-950 dark:text-X-300` way as the phase badges. `done` and
 * `superseded` are the folded-away reading; `needs-human` is the one that needs a person.
 */
export const QUAY_TASK_STATUS_BADGE_CLASSES: Record<string, string> = {
  'needs-human': 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  ready: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  todo: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  done: 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300',
  superseded: 'bg-muted text-muted-foreground',
};

/** The badge colour for a stored status this build does not know. */
export const QUAY_DEFAULT_TASK_STATUS_BADGE_CLASS = 'bg-muted text-muted-foreground';
