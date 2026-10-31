// "Get the free Ivy app" prompt for clients who open an Ivy page in a
// phone browser (an invoice, a booking page, a document to sign, the
// client portal). The page still opens in Safari or Chrome as normal;
// this is a dismissible strip at the top with an App Store link.
// Shown on iPhone and iPad only (the app is iOS), never inside the app,
// and hidden for 30 days once closed.
import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { isNative } from '../lib/platform.js';
import { APP_STORE_URL, isClientPath, isAppleMobile } from '../lib/getApp.js';

const KEY = 'ivy_get_app_dismissed_until';
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

function dismissed() {
  try { return Number(localStorage.getItem(KEY) || 0) > Date.now(); } catch { return false; }
}

export default function GetAppBanner() {
  const location = useLocation();
  const [hidden, setHidden] = useState(dismissed);
  if (hidden || isNative() || !isAppleMobile(navigator.userAgent, navigator.maxTouchPoints)) return null;
  if (!isClientPath(location.pathname)) return null;

  const close = () => {
    try { localStorage.setItem(KEY, String(Date.now() + SNOOZE_MS)); } catch { /* private mode */ }
    setHidden(true);
  };

  return (
    <div className="get-app" role="region" aria-label="Get the Ivy app">
      <img src="/icon-512.png" alt="" width="36" height="36" className="get-app-icon"/>
      <div className="get-app-text">
        <strong>Ivy is better in the app</strong>
        <span>Pay invoices, book and manage appointments, and message your providers, all in one place. Free for clients.</span>
      </div>
      <a className="get-app-cta" href={APP_STORE_URL} target="_blank" rel="noopener noreferrer">Get the app</a>
      <button type="button" className="get-app-x" aria-label="Close" onClick={close}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>
      </button>
    </div>
  );
}
