/**
 * Viewport subpackage boundary: the minimap, the PlantUML drawing surface and its canvas
 * interaction hooks, plus the viewport-shaped panel chrome (dock, sheet, legend, refresh and
 * chrome controllers). The panel imports these through this barrel so the internal file layout
 * stays private to the subpackage.
 */
export { ArchitectureMinimap } from '@/modules/architecture/render/viewport/ArchitectureMinimap';
export { PlantUmlGraph } from '@/modules/architecture/render/viewport/PlantUmlGraph';
export { ArchitectureDock } from '@/modules/architecture/render/viewport/ArchitectureDock';
export { ArchitectureSheet } from '@/modules/architecture/render/viewport/ArchitectureSheet';
export { LegendSwatch } from '@/modules/architecture/render/viewport/LegendSwatch';
export {
  formatRefreshElapsed,
  useArchitectureRefresh,
} from '@/modules/architecture/render/viewport/useArchitectureRefresh';
export { createArchitectureChromeController } from '@/modules/architecture/render/viewport/architectureChromeController';
