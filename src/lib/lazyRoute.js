// React.lazy with a preload() handle, for the pre-rendered public pages.
//
// The marketing and legal pages are saved as static HTML at build time
// (scripts/prerender.mjs) so crawlers that do not run JavaScript still see
// the page. When React then boots on one of those pages, a plain
// React.lazy() route would suspend on its first render, even if the chunk
// is already cached, because import() always resolves asynchronously, and
// React would commit the Suspense fallback (a spinner) over the content the
// visitor is already reading. lazyRoute() fixes that: main.jsx preloads the
// current route's chunk before mounting, and once the module is loaded the
// factory returns a thenable that settles synchronously, so React's first
// render commits the real page and the static content is replaced by its
// identical React-rendered twin in one step, with no intermediate frame.
import { lazy } from 'react';

export function lazyRoute(importer) {
  let mod = null;
  let promise = null;
  const load = () => {
    if (!promise) {
      promise = importer().then((m) => { mod = m; return m; }, (err) => { promise = null; throw err; });
    }
    return promise;
  };
  const Component = lazy(() => (mod ? { then: (resolve) => resolve(mod) } : load()));
  Component.preload = load;
  return Component;
}
