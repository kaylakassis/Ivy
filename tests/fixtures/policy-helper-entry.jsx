// Bundle entry for tests/policy-generator.test.mjs: the "Help me write it"
// panel body, built with esbuild so a node test can render it.
export { HelperBody } from '../../src/features/finance/CancellationPolicyHelper.jsx';
export { default as React } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';
