// Bundle entry for tests/website-editors.test.mjs: the Inspector and the
// per-type editors, built with esbuild so a node test can render them.
export { default as Inspector } from '../../src/features/website/Inspector.jsx';
export { EDITORS, EDITOR_COVERAGE, LegacyCodePanel, NoSettingsEditor } from '../../src/features/website/sectionEditors.jsx';
export { EditorContext, LinkField } from '../../src/features/website/editorKit.jsx';
// React and the server renderer ship inside the bundle so the editors'
// hooks and the renderer share one React instance.
export { default as React } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';
