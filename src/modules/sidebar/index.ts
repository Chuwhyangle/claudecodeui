export { default as Sidebar } from '@/modules/sidebar/Sidebar';
export { default as ResidentMark } from '@/modules/sidebar/ResidentMark';
// The Conversations/sidebar controller, exported so the module's own tests can
// drive the live feed through the same entry point the barrel exposes (tests
// import cross-module symbols through barrels; see AGENTS.md).
export { useSidebarController } from '@/modules/sidebar/hooks/useSidebarController';
// Browser-local "show hidden sessions" preference, read by project-workspace when it loads session pages.
export { readShownHiddenProjectIds, writeShownHiddenProjectIds } from '@/modules/sidebar/utils/sidebarStoredPreferences';
// The running-turn reading and its one-second clock, exported so the landing
// overview draws a running session with the SAME phase vocabulary and elapsed
// wording the sidebar row does — one reduction for both surfaces rather than a
// second copy that could drift.
export { presentSessionActivity } from '@/modules/sidebar/utils/sessionActivityPresentation';
export { useTickingNow } from '@/modules/sidebar/hooks/useTickingNow';
