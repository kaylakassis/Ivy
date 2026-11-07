// /tools/intake-form-templates: ready-to-copy intake questions for eight
// kinds of service business. Every template is in the page (and in the
// pre-rendered HTML), each with Copy and Download.
import React from 'react';
import { usePageMeta, siteUrl } from '../../../lib/pageMeta.js';
import { TOOL_BY_SLUG } from './toolsData.js';
import { INTAKE_TEMPLATES, intakeTemplateText, intakeFileName } from './intakeTemplates.js';
import { ToolFrame, ToolHead, CopyDownload, IvyNote, MoreTools, FinalCta, toolJsonLd } from './toolsUi.jsx';

const TOOL = TOOL_BY_SLUG['intake-form-templates'];

const META = {
  title: TOOL.title,
  description: TOOL.description,
  canonical: siteUrl(TOOL.path),
  jsonLd: toolJsonLd(TOOL, {
    '@type': 'WebPage',
    name: 'Client intake form templates',
    description: TOOL.description,
    isAccessibleForFree: true,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: INTAKE_TEMPLATES.map((t, i) => ({
        '@type': 'ListItem', position: i + 1, name: t.title, url: siteUrl(`${TOOL.path}#${t.slug}`),
      })),
    },
  }),
};

const PAGE_CSS = `
.site-root .jump{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:28px}
.site-root .jump a{display:inline-flex;align-items:center;min-height:40px;padding:8px 15px;border:1px solid var(--border2);border-radius:999px;font-size:14px;color:var(--muted);background:var(--panel)}
.site-root .jump a:hover{border-color:var(--lime);color:var(--lime)}
.site-root .tpl-list{display:grid;gap:22px}
.site-root .tpl{scroll-margin-top:84px}
.site-root .tpl-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:6px}
.site-root .tpl-head h2{font-size:clamp(22px,2.6vw,28px);margin-bottom:2px}
.site-root .tpl-head .for{font-size:13.5px;color:var(--dim)}
.site-root .tpl-head .for a{color:var(--lime)}
.site-root .tpl-body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:18px}
.site-root .tpl-sec{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
.site-root .tpl-sec h3{font-size:15.5px;margin-bottom:8px}
.site-root .tpl-sec .note{font-size:12.5px;color:#E8D9A8;background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.2);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5}
.site-root .tpl-sec ul{list-style:none;display:grid;gap:7px}
.site-root .tpl-sec li{font-size:14px;color:var(--muted);display:flex;gap:9px;line-height:1.5}
.site-root .tpl-sec li::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--lime);flex-shrink:0;margin-top:8px}
@media(max-width:760px){.site-root .tpl-body{grid-template-columns:1fr}}
`;

export default function IntakeTemplatesTool() {
  usePageMeta(META);
  return (
    <ToolFrame css={PAGE_CSS}>
      <ToolHead
        name={TOOL.name}
        h1={TOOL.h1}
        lede="Ready-to-copy intake questions for eight kinds of service business. Pick yours, copy or download it, and change anything that does not fit how you work."
      />
      <div className="container">
        <nav className="jump" aria-label="Jump to a template">
          {INTAKE_TEMPLATES.map((t) => <a key={t.slug} href={`#${t.slug}`}>{t.profession}</a>)}
        </nav>
      </div>

      <section style={{ paddingTop: 40 }}>
        <div className="container tpl-list">
          {INTAKE_TEMPLATES.map((t) => (
            <article key={t.slug} id={t.slug} className="tpl panel" aria-labelledby={`${t.slug}-title`}>
              <div className="tpl-head">
                <div>
                  <h2 id={`${t.slug}-title`}>{t.title}</h2>
                  <div className="for">For {t.profession.toLowerCase()}. <a href={`/for/${t.slug}`}>See Ivy for {t.profession.toLowerCase()} →</a></div>
                </div>
              </div>
              <div className="tpl-body">
                {t.sections.map((s) => (
                  <div key={s.title} className="tpl-sec">
                    <h3>{s.title}</h3>
                    {s.note && <p className="note">{s.note}</p>}
                    <ul>{s.questions.map((q) => <li key={q}>{q}</li>)}</ul>
                  </div>
                ))}
              </div>
              <CopyDownload text={intakeTemplateText(t)} filename={intakeFileName(t)} what="questions"/>
            </article>
          ))}
          <p className="disclaimer" style={{ textAlign: 'center' }}><b>These are templates, not legal or medical advice.</b> Ask only what you need, keep answers private, and check the rules where you work, especially for health details.</p>
          <div style={{ maxWidth: 720, margin: '0 auto', width: '100%' }}>
            <IvyNote>
              <p><b>Send intake forms without lifting a finger.</b> In Ivy, turn any of these into a form, attach it to a service, and it is emailed to each client automatically when they book, ready to fill in and sign. The completed form is kept with that client in Ivy.</p>
            </IvyNote>
          </div>
        </div>
      </section>

      <MoreTools current="intake-form-templates"/>

      <FinalCta
        title="Intake, booking and payment in one flow."
        sub="Clients book, pay a deposit, fill in your intake form and sign, in one flow. Everything stays with their client record. Try it free for 14 days."
      />
    </ToolFrame>
  );
}
