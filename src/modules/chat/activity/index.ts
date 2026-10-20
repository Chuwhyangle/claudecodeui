/**
 * The chat activity surfaces: the dock's status line and the panel it opens.
 *
 * They live in their own package because both the composer and the transcript
 * render them — the dock is the turn's reading, mounted from the transcript, and
 * the panel is its expanded list. Keeping them in either half made the two halves
 * import each other; this package imports neither.
 */
export { default as ActivityIndicator } from '@/modules/chat/activity/ActivityIndicator';
export { default as ActivityDockPanel } from '@/modules/chat/activity/ActivityDockPanel';
