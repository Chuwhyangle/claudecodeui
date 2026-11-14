/**
 * Curation/export subpackage boundary: pin/exclude/hidden-edge curation, the export menu and the
 * shared export mechanics (artifact naming, text/blob downloads and PNG rasterisation).
 */
export { ArchitectureCurationManager } from '@/modules/architecture/render/curation/ArchitectureCurationManager';
export type { ArchitectureCurationPage } from '@/modules/architecture/render/curation/ArchitectureCurationManager';
export { ArchitectureExportMenu } from '@/modules/architecture/render/curation/ArchitectureExportMenu';
export { CurationToast } from '@/modules/architecture/render/curation/CurationToast';
export { createArchitectureCurationController } from '@/modules/architecture/render/curation/architectureCurationController';
export { createArchitectureFitExportController } from '@/modules/architecture/render/curation/architectureFitExportController';
export type {
  ArchitectureExportNotice,
  ArchitectureFitExportController,
} from '@/modules/architecture/render/curation/architectureFitExportController';
