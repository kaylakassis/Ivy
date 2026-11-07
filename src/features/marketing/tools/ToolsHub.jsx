// /tools: the free tools hub.
import React from 'react';
import { usePageMeta, siteUrl, breadcrumbs } from '../../../lib/pageMeta.js';
import { TOOLS_HUB, TOOLS, NO_SHOW_CALCULATOR } from './toolsData.js';
import { ToolFrame, ToolHead, ToolCard, allToolCards, FinalCta } from './toolsUi.jsx';

const crumbs = breadcrumbs([['Home', '/'], ['Free tools', '/tools']]);
const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'CollectionPage',
      name: 'Free tools for solo service businesses',
      url: siteUrl('/tools'),
      description: TOOLS_HUB.description,
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: [...TOOLS, NO_SHOW_CALCULATOR].map((t, i) => ({
          '@type': 'ListItem', position: i + 1, name: t.name, url: siteUrl(t.path),
        })),
      },
    },
    { '@type': crumbs['@type'], itemListElement: crumbs.itemListElement },
  ],
};

const META = {
  title: TOOLS_HUB.title,
  description: TOOLS_HUB.description,
  canonical: siteUrl('/tools'),
  jsonLd: JSON_LD,
};

export default function ToolsHub() {
  usePageMeta(META);
  return (
    <ToolFrame>
      <ToolHead
        eyebrow="Free tools"
        h1={<>Free tools for your <span className="lime">business of one.</span></>}
        lede="Small, practical helpers for the business side of your work: a cancellation policy, a deposit that makes sense, and intake questions you can send today. Free, no signup, and everything stays in your browser."
      />

      <section style={{ paddingTop: 16 }}>
        <div className="container">
          <div className="tool-cards">
            {allToolCards().map(({ key, ...c }) => <ToolCard key={key} {...c}/>)}
          </div>
        </div>
      </section>

      <section className="alt center">
        <div className="container">
          <span className="eyebrow">How these work</span>
          <h2>Use them as a starting point.</h2>
          <div className="tips">
            <div className="tip"><h3>Private by design</h3><p>Everything happens in your browser. Nothing you type or pick is sent to us or saved anywhere.</p></div>
            <div className="tip"><h3>Your numbers, not ours</h3><p>The calculators use only what you enter. No made-up averages, and every step of the math is shown.</p></div>
            <div className="tip"><h3>Make them yours</h3><p>Templates are a first draft, not legal advice. Change the wording to fit how you work and check your local rules.</p></div>
          </div>
        </div>
      </section>

      <FinalCta
        title="Want it all to run itself?"
        sub="Ivy is one place for booking, deposits, intake forms, policies, invoices and client messages, with an assistant that does the busywork. Try it free for 14 days."
      />
    </ToolFrame>
  );
}
