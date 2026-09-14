// "Download on the App Store" badge. One constant controls it everywhere:
// while APP_STORE_URL is empty (the app is still in review) the badge is
// not rendered at all, so no visitor ever lands on a dead link. Paste the
// App Store URL here once Apple approves and every placement lights up.
import React from 'react';

export const APP_STORE_URL = '';

export default function AppStoreBadge({ height = 40, className = '' }) {
  if (!APP_STORE_URL) return null;
  return (
    <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer"
      className={`app-badge ${className}`.trim()}
      aria-label="Download Ivy on the App Store">
      <img src="/badges/app-store.svg" alt="Download on the App Store"
        width={Math.round(height * 3)} height={height} loading="lazy"/>
    </a>
  );
}
