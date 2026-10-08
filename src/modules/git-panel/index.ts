export { default as GitPanel } from '@/modules/git-panel/GitPanel';
// The Changes view is the unit that owns the expanded-file state an external
// reveal drives (`data-git-expanded-file`, read by `ui_visible_context`), so it
// is exported as well: a caller outside this module that has to assert on that
// state composes it directly rather than reaching through GitPanel's git API.
export { default as ChangesView } from '@/modules/git-panel/changes/ChangesView';
