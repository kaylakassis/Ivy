// iPhone app: URLs handed to the app by iOS become in-app navigation.
//
//   • Home-screen quick actions (long-press the icon). SceneDelegate.swift
//     forwards each one as ivy://action/<name>, cold start included: the
//     App plugin keeps the event until this listener is attached.
//   • ivy://<screen> links, such as the "Open Ivy" button on the payment
//     return page (ivy://finance).
// The mapping lives in src/lib/quickActions.js; unknown URLs are ignored.
// Renders nothing; a no-op on the web.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { isNative } from '../lib/platform.js';
import { routeForAppUrl } from '../lib/quickActions.js';

export default function NativeUrlOpens() {
  const navigate = useNavigate();
  // One listener for the life of the app (useNavigate's identity changes
  // with the location; re-registering on every page would churn the bridge).
  const navRef = useRef(navigate);
  navRef.current = navigate;
  useEffect(() => {
    if (!isNative()) return undefined;
    let handle = null; let live = true;
    const onUrl = (ev) => {
      const to = routeForAppUrl(ev?.url);
      if (to) navRef.current(to);
    };
    import('@capacitor/app')
      .then(({ App }) => App.addListener('appUrlOpen', onUrl))
      .then((h) => { if (live) handle = h; else h?.remove?.(); })
      .catch(() => {});
    return () => { live = false; handle?.remove?.(); };
  }, []);
  return null;
}
