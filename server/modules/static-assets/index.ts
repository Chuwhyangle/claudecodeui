// createStaticAssetsMiddleware: used by the server entrypoint to mount the public/dist
// static assets and the SPA entry behind response compression, after every /api route.
export { createStaticAssetsMiddleware } from '@/modules/static-assets/static-assets.module.js';

// apiNoStoreMiddleware: used by the server entrypoint to mark every /api response
// uncacheable, and by this module's tests to assert that policy against the
// production middleware rather than a copy.
export { apiNoStoreMiddleware } from '@/modules/static-assets/api-no-store.middleware.js';
