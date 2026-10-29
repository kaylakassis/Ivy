// "Download on the App Store" badge. One constant controls it everywhere
// on the marketing site (top bar, phone menu, footer): Ivy's own App Store
// listing, live since approval.
import React from 'react';

export const APP_STORE_URL = 'https://apps.apple.com/us/app/ivy-for-solo-businesses/id6808542331';

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
