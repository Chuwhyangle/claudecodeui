import { api } from '@/shared/api';
import { CODE_EDITOR_STORAGE_KEYS } from '@/shared/constants';

/**
 * The one reader and writer for the settings that used to live in browser
 * localStorage and now live in `auth.db`.
 *
 * The server is the source of truth — that is what makes a setting follow the
 * user from a laptop to a phone. localStorage keeps a mirror of the last known
 * server state purely so the very first paint is synchronous: without it the
 * app would flash the default light theme, the default language and a
 * collapsed sidebar on every load while the fetch was in flight.
 *
 * Reads are therefore synchronous against the mirror, and writes go to the
 * mirror immediately and to the server on a short debounce.
 */

/** Every setting the server stores for a user. */
export type UserPreferences = {
  theme: 'light' | 'dark';
  userLanguage: string;
  tasksEnabled: boolean;
  projectSortOrder: 'name' | 'date';
  claudePermissions: unknown;
  cursorPermissions: unknown;
  codexPermissions: unknown;
  opencodePermissions: unknown;
  codeEditorSettings: unknown;
  uiPreferences: unknown;
  selectedProvider: string;
};

export type UserPreferenceKey = keyof UserPreferences;

/** Fired after any preference changes, from a local write or from a hydrate. */
export const USER_PREFERENCES_CHANGED_EVENT = 'user-preferences:changed';

/** The single localStorage blob mirroring the server's copy. */
const MIRROR_STORAGE_KEY = 'user-preferences';


/**
 * Long enough to collapse a burst of edits (dragging the font-size select,
 * toggling several switches) into one request, short enough that closing the
 * tab right after a change almost never loses it.
 */
const SERVER_WRITE_DEBOUNCE_MS = 400;

/**
 * The localStorage keys each preference was read from before this module.
 *
 * Kept so an existing install does not lose its settings on upgrade: on the
 * first hydrate, any key the server has never seen is seeded from its legacy
 * location and pushed up. Removing an entry here silently resets that setting
 * for every user who has not opened the app since the migration.
 */
const LEGACY_STORAGE_KEYS: Record<UserPreferenceKey, string> = {
  theme: 'theme',
  userLanguage: 'userLanguage',
  tasksEnabled: 'tasks-enabled',
  projectSortOrder: 'claude-settings',
  claudePermissions: 'claude-settings',
  cursorPermissions: 'cursor-tools-settings',
  codexPermissions: 'codex-settings',
  opencodePermissions: 'opencode-settings',
  // Unused: the four code-editor settings never shared one key, so they are
  // read by readLegacyCodeEditorSettings instead.
  codeEditorSettings: '',
  uiPreferences: 'uiPreferences',
  selectedProvider: 'selected-provider',
};

const PREFERENCE_KEYS = Object.keys(LEGACY_STORAGE_KEYS) as UserPreferenceKey[];

type PreferenceRecord = Partial<Record<UserPreferenceKey, unknown>>;

const listeners = new Set<() => void>();

let preferences: PreferenceRecord = {};
let pendingServerWrites: PreferenceRecord = {};
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;
let hasHydrated = false;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

function readMirror(): PreferenceRecord {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as PreferenceRecord) : {};
  } catch {
    return {};
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A full or unavailable localStorage costs the first-paint optimization,
    // not the setting itself — the server copy is authoritative.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(USER_PREFERENCES_CHANGED_EVENT));
  }
}

function flushServerWrites(): void {
  serverWriteTimer = null;
  const updates = pendingServerWrites;
  pendingServerWrites = {};

  if (Object.keys(updates).length === 0) {
    return;
  }

  // A save that fails must never surface as an unhandled rejection out of a
  // timer callback: the mirror already holds the value, and the next write
  // re-sends it.
  try {
    void api.user.savePreferences(updates as Record<string, unknown>).catch((error: unknown) => {
      console.error('Failed to save user preferences:', error);
    });
  } catch (error) {
    console.error('Failed to save user preferences:', error);
  }
}

function queueServerWrite(updates: PreferenceRecord): void {
  pendingServerWrites = { ...pendingServerWrites, ...updates };

  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
  }
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

/**
 * Reads one preference, or `fallback` when the user has never set it.
 *
 * Synchronous by design: callers include module-level initializers and
 * `useState` initial values that run before any fetch could resolve.
 */
export function readUserPreference<T>(key: UserPreferenceKey, fallback: T): T {
  const value = preferences[key];
  return value === undefined || value === null ? fallback : (value as T);
}

/** Writes one preference through to the mirror, the listeners and the server. */
export function writeUserPreference(key: UserPreferenceKey, value: unknown): void {
  if (JSON.stringify(preferences[key]) === JSON.stringify(value)) {
    return;
  }

  preferences = { ...preferences, [key]: value };
  writeMirror();
  queueServerWrite({ [key]: value });
  notifyListeners();
}

/** Writes several preferences as one change, so listeners re-render once. */
export function writeUserPreferences(updates: PreferenceRecord): void {
  const changed: PreferenceRecord = {};
  for (const [key, value] of Object.entries(updates) as Array<[UserPreferenceKey, unknown]>) {
    if (JSON.stringify(preferences[key]) !== JSON.stringify(value)) {
      changed[key] = value;
    }
  }

  if (Object.keys(changed).length === 0) {
    return;
  }

  preferences = { ...preferences, ...changed };
  writeMirror();
  queueServerWrite(changed);
  notifyListeners();
}

/** Subscribes to any preference change; returns the unsubscribe function. */
export function subscribeToUserPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reads what a preference was stored under before this module existed.
 *
 * `claude-settings` held four settings in one blob, so `projectSortOrder` and
 * `claudePermissions` are pulled out of it separately.
 */
function readLegacyPreference(key: UserPreferenceKey): unknown {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEYS[key]);
  } catch {
    return undefined;
  }

  if (raw === null) {
    return undefined;
  }

  if (key === 'theme' || key === 'userLanguage' || key === 'selectedProvider') {
    return raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (key === 'projectSortOrder') {
    return isRecord(parsed) ? parsed.projectSortOrder : undefined;
  }

  if (key === 'claudePermissions') {
    if (!isRecord(parsed)) {
      return undefined;
    }
    // The sort order rides along in the same legacy blob but is its own
    // preference now, so it is deliberately not copied into the permissions.
    const { allowedTools, disallowedTools, skipPermissions } = parsed;
    return { allowedTools, disallowedTools, skipPermissions };
  }

  return parsed;
}

/**
 * Reads the four code-editor settings, which never shared a single key.
 *
 * They were stored as four separate strings, so unlike every other legacy
 * value there is nothing to `JSON.parse` — hence the dedicated reader.
 */
function readLegacyCodeEditorSettings(): unknown {
  try {
    const wordWrap = localStorage.getItem(CODE_EDITOR_STORAGE_KEYS.wordWrap);
    const showMinimap = localStorage.getItem(CODE_EDITOR_STORAGE_KEYS.showMinimap);
    const lineNumbers = localStorage.getItem(CODE_EDITOR_STORAGE_KEYS.lineNumbers);
    const fontSize = localStorage.getItem(CODE_EDITOR_STORAGE_KEYS.fontSize);

    if (wordWrap === null && showMinimap === null && lineNumbers === null && fontSize === null) {
      return undefined;
    }

    const settings: Record<string, unknown> = {};
    if (wordWrap !== null) settings.wordWrap = wordWrap !== 'false';
    if (showMinimap !== null) settings.showMinimap = showMinimap !== 'false';
    if (lineNumbers !== null) settings.lineNumbers = lineNumbers !== 'false';
    if (fontSize !== null) settings.fontSize = fontSize;
    return settings;
  } catch {
    return undefined;
  }
}

/**
 * Loads the server's copy and adopts it as the source of truth.
 *
 * Called once the user is authenticated. Any key the server has never seen is
 * seeded from wherever it used to live in localStorage and pushed up, so the
 * settings an existing install already had survive the move.
 */
export async function hydrateUserPreferences(): Promise<void> {
  let serverPreferences: PreferenceRecord = {};

  try {
    const response = await api.user.preferences();
    if (response.ok) {
      const payload = (await response.json()) as { preferences?: unknown };
      if (isRecord(payload.preferences)) {
        serverPreferences = payload.preferences as PreferenceRecord;
      }
    }
  } catch (error) {
    // Keep whatever the mirror holds; an offline load must still render the
    // user's own theme and language rather than snapping back to defaults.
    console.error('Failed to load user preferences:', error);
    return;
  }

  const migrated: PreferenceRecord = {};
  for (const key of PREFERENCE_KEYS) {
    if (serverPreferences[key] !== undefined) {
      continue;
    }

    const legacyValue = key === 'codeEditorSettings'
      ? readLegacyCodeEditorSettings()
      : readLegacyPreference(key);

    if (legacyValue !== undefined) {
      migrated[key] = legacyValue;
    }
  }

  // Anything still queued for a key the server just answered for was computed
  // from pre-hydrate state and is now stale. Letting it flush would push this
  // device's start-up value over the one that was just fetched — the exact
  // shape of a preference silently resetting itself on a second device.
  for (const key of Object.keys(serverPreferences) as UserPreferenceKey[]) {
    delete pendingServerWrites[key];
  }

  preferences = { ...serverPreferences, ...migrated };
  hasHydrated = true;
  writeMirror();

  if (Object.keys(migrated).length > 0) {
    queueServerWrite(migrated);
  }

  notifyListeners();
}

/** True once the server's copy has been read at least one time this session. */
export function hasHydratedUserPreferences(): boolean {
  return hasHydrated;
}

/**
 * Drops the in-memory and mirrored copies on sign-out, so the next user on
 * this device does not start out looking at the previous user's settings.
 */
export function resetUserPreferences(): void {
  preferences = {};
  pendingServerWrites = {};
  hasHydrated = false;
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // Nothing to do: the in-memory copy is already cleared.
  }
  notifyListeners();
}

// The mirror is read at module load rather than on first use because the theme
// and language readers run during module initialization, before any component
// has mounted.
if (typeof localStorage !== 'undefined') {
  preferences = readMirror();
}

// ----------------------------- this device's name ----------------------------

/**
 * localStorage key holding this browser's user-editable device name.
 *
 * It lives here, not in the MCP navigation settings hook, because the shared
 * websocket provider reads the name to announce the connection — and `shared`
 * must not import a feature module to obtain it. The MCP settings UI is one
 * consumer of this preference, not its owner.
 */
export const MCP_DEVICE_NAME_STORAGE_KEY = 'mcpNavigationDeviceName';

/** The User-Agent of the browser this code runs in, or '' outside a browser. */
const readUserAgent = (): string => (typeof navigator === 'undefined' ? '' : navigator.userAgent);

/**
 * The browser family named in a User-Agent string, at the coarsest granularity that stays
 * recognisable to a person. Ordered so the specific tokens win: Edge and Opera also say
 * "Chrome", and every Chromium browser also says "Safari".
 */
const detectBrowserName = (userAgent: string): string => {
  if (/Edg[eo]?\/|Edge\//.test(userAgent)) {
    return 'Edge';
  }
  if (/OPR\/|Opera/.test(userAgent)) {
    return 'Opera';
  }
  if (/Firefox\/|FxiOS/.test(userAgent)) {
    return 'Firefox';
  }
  if (/Chrome\/|CriOS/.test(userAgent)) {
    return 'Chrome';
  }
  if (/Safari\//.test(userAgent)) {
    return 'Safari';
  }
  return 'Browser';
};

/**
 * The operating-system family named in a User-Agent string. Android and iOS are matched
 * before Linux and macOS, because their User-Agents also contain "Linux" / "Mac OS X".
 */
const detectOsName = (userAgent: string): string => {
  if (/Android/.test(userAgent)) {
    return 'Android';
  }
  if (/iPhone|iPad|iPod/.test(userAgent)) {
    return 'iOS';
  }
  if (/Windows/.test(userAgent)) {
    return 'Windows';
  }
  if (/Mac OS X|Macintosh/.test(userAgent)) {
    return 'macOS';
  }
  if (/Linux|X11/.test(userAgent)) {
    return 'Linux';
  }
  return 'Unknown system';
};

/**
 * Derives a human-readable default device name from a User-Agent string, e.g. "Chrome · Linux".
 * Deliberately coarse — the browser family and the OS family only — so the name carries
 * neither a version number nor anything that identifies the machine, which is what makes it
 * safe to publish to the server when the user never names the device themselves.
 */
const deriveDefaultDeviceName = (userAgent: string): string =>
  `${detectBrowserName(userAgent)} · ${detectOsName(userAgent)}`;

/** The effective name for a stored value: the trimmed stored name, or the derived default. */
export const resolveDeviceName = (stored: string | null): string =>
  stored !== null && stored.trim().length > 0
    ? stored.trim()
    : deriveDefaultDeviceName(readUserAgent());

/**
 * Reads this device's name straight from localStorage, without React. An unset or blank
 * stored name answers the User-Agent-derived default, so the device always has a name.
 */
export const readDeviceName = (): string => {
  try {
    return resolveDeviceName(localStorage.getItem(MCP_DEVICE_NAME_STORAGE_KEY));
  } catch {
    return resolveDeviceName(null);
  }
};
