import { useCallback, useEffect, useState } from 'react';

import {
  DEFAULT_MCP_NAVIGATION_POLICY,
  MCP_NAVIGATION_POLICY_STORAGE_KEY,
  isMcpNavigationPolicy,
  readMcpNavigationPolicy,
  writeMcpNavigationPolicy,
  type McpNavigationPolicy,
} from '@/shared/mcpNavigationPolicy';
import {
  MCP_DEVICE_NAME_STORAGE_KEY,
  readDeviceName,
  resolveDeviceName,
} from '@/shared/userSettings';

/**
 * The stored policy and its pure readers/writers belong to this device, not to the
 * settings UI: the chat module's navigation executor reads them too, and neither
 * feature module may import the other. They are re-exported here so this hook's
 * existing consumers (the settings section and its tests) keep one import site.
 */
export type { McpNavigationPolicy };
export { MCP_NAVIGATION_POLICY_STORAGE_KEY, readMcpNavigationPolicy, writeMcpNavigationPolicy };

/**
 * The policy and name the settings UI renders, plus the setters that persist them.
 */
type UseMcpNavigationSettingsResult = {
  policy: McpNavigationPolicy;
  deviceName: string;
  setPolicy: (policy: McpNavigationPolicy) => void;
  setDeviceName: (name: string) => void;
};

/**
 * Owns this device's MCP navigation policy and name for the settings UI: seeds them from
 * localStorage on first render, writes each change back, and mirrors changes made in the
 * browser's other tabs. Consumed by McpNavigationSection; non-component code (a WS reply, a
 * navigation executor) uses the pure readers above instead.
 */
export function useMcpNavigationSettings(): UseMcpNavigationSettingsResult {
  // The chosen policy this tab renders, seeded straight from storage so the first paint
  // already reflects the device's choice rather than flickering from the default.
  const [policy, setPolicyState] = useState<McpNavigationPolicy>(readMcpNavigationPolicy);
  // The name this tab renders: the stored name, or the derived default when none is set.
  const [deviceName, setDeviceNameState] = useState<string>(readDeviceName);

  // Another tab of this same browser changing either value fires a `storage` event here
  // (never in the tab that wrote it); without this listener the tabs would disagree until a
  // reload. The event carries the new value, so a removed key re-derives the default name
  // rather than keeping a stale one.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === MCP_NAVIGATION_POLICY_STORAGE_KEY) {
        setPolicyState(
          isMcpNavigationPolicy(event.newValue) ? event.newValue : DEFAULT_MCP_NAVIGATION_POLICY,
        );
      } else if (event.key === MCP_DEVICE_NAME_STORAGE_KEY) {
        setDeviceNameState(resolveDeviceName(event.newValue));
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setPolicy = useCallback((next: McpNavigationPolicy) => {
    setPolicyState(next);
    // One writer for the stored policy: the navigation executor writes it from the
    // other feature module, and both must keep the same failure semantics.
    writeMcpNavigationPolicy(next);
  }, []);

  const setDeviceName = useCallback((next: string) => {
    const trimmed = next.trim();
    setDeviceNameState(resolveDeviceName(trimmed));
    try {
      if (trimmed.length === 0) {
        localStorage.removeItem(MCP_DEVICE_NAME_STORAGE_KEY);
      } else {
        localStorage.setItem(MCP_DEVICE_NAME_STORAGE_KEY, trimmed);
      }
    } catch {
      // Keep the name for this session even when storage is unavailable.
    }
  }, []);

  return { policy, deviceName, setPolicy, setDeviceName };
}
