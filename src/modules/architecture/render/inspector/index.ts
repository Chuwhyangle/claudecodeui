/**
 * Inspector subpackage boundary: the selected-node/relation inspector, the selection tray and the
 * plantUML text panel — the surfaces a reader uses to inspect the current selection.
 */
export { ArchitectureInspector } from '@/modules/architecture/render/inspector/ArchitectureInspector';
export {
  ArchitectureSelectionTray,
  buildSelectionMessage,
} from '@/modules/architecture/render/inspector/ArchitectureSelectionTray';
export { ArchitectureTextPanel } from '@/modules/architecture/render/inspector/ArchitectureTextPanel';
