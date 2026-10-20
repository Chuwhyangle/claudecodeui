/**
 * The shared layer's public surface for consumers outside `src/shared`.
 *
 * Nothing re-exported here may import a feature module: that is what keeps
 * `shared` loadable on its own (see `src/shared/tests/sharedLayerIsolation.test.tsx`).
 */
export { readDeviceName } from '@/shared/userSettings';
