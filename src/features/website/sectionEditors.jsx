// One plain-language editor per section type. Every type in sections.js
// has an entry here (tests/website-editors.test.mjs asserts it), except
// the legacy code types, which get LegacyCodePanel instead.
//
// Each editor receives { data, update } where update(patch) merges into
// section.data. Lists use Repeater (Add / Remove / up / down), images use
// ImageInput, links use LinkField. Nothing here ever shows raw data.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import { SECTION_TYPES, LEGACY_CODE_TYPES } from './sections.js';
import { videoEmbedUrl, VIDEO_HOSTS_LABEL } from '../../lib/videoEmbed.js';
import { hoursText, normalizeDay } from './hoursText.js';
import { normalizeInstagram, SOCIAL_PLATFORMS, normalizeSocialUrl, normalizeSocialPlatform } from './socialLinks.js';
import { CancellationPolicyEditor } from './CancellationPolicySection.jsx';
import {
  Row, Hint, Note, TextInput, TextArea, Toggle, Segmented, Select, Repeater, ImageInput, GalleryPhotos,
  LinkField, DateTimeInput, DateInput, newItemId, inputS, useEditorCtx,
} from './editorKit.jsx';

const str = (v) => (v == null ? '' : String(v));

function Headline({ data, update, label = 'Headline' }) {
  return <Row label={label}><TextInput value={str(data.headline)} onChange={(e) => update({ headline: e.target.value })} /></Row>;
}
function Sub({ data, update, label = 'Short line under the headline', rows = 2 }) {
  return <Row label={label}><TextArea rows={rows} value={str(data.sub)} onChange={(e) => update({ sub: e.target.value })} /></Row>;
}

// ---------- Hero ----------
function HeroEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update} rows={3}/>
      <Row label="Button text"><TextInput value={str(data.cta)} onChange={(e) => update({ cta: e.target.value })} /></Row>
      {data.cta ? <LinkField value={data.ctaLink} onChange={(v) => update({ ctaLink: v })} label="Button opens" emptyMeans="booking"/> : null}
      <Row label="Alignment" as="div">
        <Segmented value={data.align || 'center'} onChange={(a) => update({ align: a })}
          options={[{ id: 'left', label: 'Left' }, { id: 'center', label: 'Center' }]}/>
      </Row>
      <Row label="Photo (used by the photo layouts)" as="div">
        <ImageInput value={data.imgUrl} onChange={(v) => update({ imgUrl: v })}/>
      </Row>
    </>
  );
}

// ---------- Services ----------
function ServicesEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Services" as="div">
        <Repeater items={data.items || []} onChange={(items) => update({ items })} addLabel="Add service"
          itemLabel={(it, i) => it.name || `Service ${i + 1}`}
          make={() => ({ id: newItemId('i'), name: 'New service', desc: '', price: '', duration: '', imgUrl: '' })}>
          {(item, setItem) => (
            <>
              <TextInput placeholder="Name" value={str(item.name)} onChange={(e) => setItem({ name: e.target.value })} />
              <TextArea rows={2} placeholder="What it includes" value={str(item.desc)} onChange={(e) => setItem({ desc: e.target.value })} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <TextInput placeholder="Price, e.g. $85" value={str(item.price)} onChange={(e) => setItem({ price: e.target.value })} />
                <TextInput placeholder="Length, e.g. 60 min" value={str(item.duration)} onChange={(e) => setItem({ duration: e.target.value })} />
              </div>
              <Row label="Photo (optional)" as="div"><ImageInput value={item.imgUrl} onChange={(v) => setItem({ imgUrl: v })}/></Row>
            </>
          )}
        </Repeater>
      </Row>
    </>
  );
}

// ---------- About ----------
function AboutEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Row label="Your story"><TextArea rows={6} value={str(data.body)} onChange={(e) => update({ body: e.target.value })} /></Row>
      <Row label="Photo" as="div"><ImageInput value={data.imgUrl} onChange={(v) => update({ imgUrl: v })}/></Row>
    </>
  );
}

// ---------- Booking ----------
function BookingEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Booking page to show (optional)" hint="Leave blank to use your main booking page.">
        <TextInput value={str(data.handle)} placeholder="Leave blank for your main booking page" onChange={(e) => update({ handle: e.target.value })} />
      </Row>
      <Note>Visitors pick a time right here, from the same calendar you use in Ivy.</Note>
    </>
  );
}

// ---------- Reviews ----------
function TestimonialsEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Row label="Reviews" as="div">
        <Repeater items={data.items || []} onChange={(items) => update({ items })} addLabel="Add review"
          itemLabel={(it, i) => it.name || `Review ${i + 1}`}
          make={() => ({ id: newItemId('t'), name: '', role: '', text: '', rating: 5 })}>
          {(item, setItem) => (
            <>
              <TextInput placeholder="Name" value={str(item.name)} onChange={(e) => setItem({ name: e.target.value })} />
              <TextInput placeholder="Who they are, e.g. Client since 2023" value={str(item.role)} onChange={(e) => setItem({ role: e.target.value })} />
              <TextArea rows={3} placeholder="What they said" value={str(item.text)} onChange={(e) => setItem({ text: e.target.value })} />
              <Row label="Stars" as="div">
                <Segmented value={String(item.rating || 5)} onChange={(v) => setItem({ rating: Number(v) })}
                  options={[1, 2, 3, 4, 5].map((n) => ({ id: String(n), label: String(n) }))}/>
              </Row>
            </>
          )}
        </Repeater>
      </Row>
    </>
  );
}

// ---------- FAQ / Accordion ----------
function QaEditor({ data, update, addLabel = 'Add question', qLabel = 'Question', aLabel = 'Answer' }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Row label={qLabel === 'Question' ? 'Questions' : 'Items'} as="div">
        <Repeater items={data.items || []} onChange={(items) => update({ items })} addLabel={addLabel}
          itemLabel={(it, i) => it.q || `${qLabel} ${i + 1}`}
          make={() => ({ id: newItemId('q'), q: '', a: '' })}>
          {(item, setItem) => (
            <>
              <TextInput placeholder={qLabel} value={str(item.q)} onChange={(e) => setItem({ q: e.target.value })} />
              <TextArea rows={3} placeholder={aLabel} value={str(item.a)} onChange={(e) => setItem({ a: e.target.value })} />
            </>
          )}
        </Repeater>
      </Row>
    </>
  );
}
const FaqEditor = (p) => <QaEditor {...p}/>;
const AccordionEditor = (p) => <QaEditor {...p} addLabel="Add item" qLabel="Title" aLabel="Text shown when opened"/>;

// ---------- Gallery ----------
function GalleryEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Row label="Photos" as="div"><GalleryPhotos photos={data.photos || []} onChange={(photos) => update({ photos })} /></Row>
    </>
  );
}

// ---------- Contact ----------
function ContactEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Email"><TextInput type="email" value={str(data.email)} onChange={(e) => update({ email: e.target.value })} /></Row>
      <Row label="Phone"><TextInput type="tel" value={str(data.phone)} onChange={(e) => update({ phone: e.target.value })} /></Row>
      <Toggle checked={data.showForm !== false} onChange={(v) => update({ showForm: v })} label="Show a contact form" hint="Messages arrive in your Ivy inbox and by email."/>
    </>
  );
}

// ---------- Footer ----------
function FooterEditor({ data, update }) {
  return (
    <>
      <Row label="Business name"><TextInput value={str(data.businessName)} onChange={(e) => update({ businessName: e.target.value })} /></Row>
      <Row label="Tagline"><TextInput value={str(data.tagline)} onChange={(e) => update({ tagline: e.target.value })} /></Row>
    </>
  );
}

// ---------- Shop ----------
function ShopEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Toggle checked={!!data.showOutOfStock} onChange={(v) => update({ showOutOfStock: v })} label="Show sold-out products too" hint="Off: only products in stock appear."/>
      <Note>Your products, prices and photos come from <a href="/finance" style={{ color: 'var(--accent)' }}>Finance, Products</a>. Changes there show here automatically.</Note>
    </>
  );
}

// ---------- Stats ----------
function StatsEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update} label="Headline (optional)"/>
      <Sub data={data} update={update}/>
      <Row label="Numbers" as="div">
        <Repeater items={data.items || []} onChange={(items) => update({ items })} addLabel="Add a number" max={8}
          itemLabel={(it, i) => it.label || `Number ${i + 1}`}
          make={() => ({ id: newItemId('s'), value: '', label: '' })}>
          {(item, setItem) => (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 6 }}>
              <TextInput placeholder="500+" value={str(item.value)} onChange={(e) => setItem({ value: e.target.value })} />
              <TextInput placeholder="What it counts, e.g. Sessions" value={str(item.label)} onChange={(e) => setItem({ label: e.target.value })} />
            </div>
          )}
        </Repeater>
      </Row>
    </>
  );
}

// ---------- Call to action ----------
function CtaBannerEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Button text"><TextInput value={str(data.cta)} onChange={(e) => update({ cta: e.target.value })} /></Row>
      {data.cta ? <LinkField value={data.ctaLink} onChange={(v) => update({ ctaLink: v })} label="Button opens" emptyMeans="booking"/> : null}
    </>
  );
}

// ---------- Team ----------
function TeamEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Row label="People" as="div">
        <Repeater items={data.members || []} onChange={(members) => update({ members })} addLabel="Add a person"
          itemLabel={(it, i) => it.name || `Person ${i + 1}`}
          make={() => ({ id: newItemId('m'), name: '', role: '', bio: '', imgUrl: '', link: '' })}>
          {(item, setItem) => (
            <>
              <Row label="Photo" as="div"><ImageInput value={item.imgUrl} onChange={(v) => setItem({ imgUrl: v })}/></Row>
              <TextInput placeholder="Name" value={str(item.name)} onChange={(e) => setItem({ name: e.target.value })} />
              <TextInput placeholder="Role, e.g. Lead practitioner" value={str(item.role)} onChange={(e) => setItem({ role: e.target.value })} />
              <TextArea rows={3} placeholder="Short bio" value={str(item.bio)} onChange={(e) => setItem({ bio: e.target.value })} />
              <LinkField value={item.link} onChange={(v) => setItem({ link: v })} label="Their name opens (optional)" emptyMeans="none"/>
            </>
          )}
        </Repeater>
      </Row>
    </>
  );
}

// ---------- Pricing tiers ----------
function featuresToText(f) { return Array.isArray(f) ? f.join('\n') : str(f); }
function textToFeatures(t) { return String(t || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 30); }

function PricingEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Plans" as="div">
        <Repeater items={data.tiers || []} onChange={(tiers) => update({ tiers })} addLabel="Add a plan" max={6}
          itemLabel={(it, i) => it.name || `Plan ${i + 1}`}
          make={() => ({ id: newItemId('p'), name: 'New plan', price: '', description: '', features: [], featured: false, ctaText: 'Choose', ctaLink: '' })}>
          {(item, setItem) => <PlanFields item={item} setItem={setItem}/>}
        </Repeater>
      </Row>
    </>
  );
}

function PlanFields({ item, setItem }) {
  // Keep the features text as typed (blank lines included) until blur, so
  // the textarea does not fight the cursor.
  const [draft, setDraft] = useState(() => featuresToText(item.features));
  const lastSaved = useRef(featuresToText(item.features));
  useEffect(() => {
    const now = featuresToText(item.features);
    if (now !== lastSaved.current) { lastSaved.current = now; setDraft(now); }
  }, [item.features]);
  const commit = () => { lastSaved.current = textToFeatures(draft).join('\n'); setItem({ features: textToFeatures(draft) }); };
  return (
    <>
      <TextInput placeholder="Plan name" value={str(item.name)} onChange={(e) => setItem({ name: e.target.value })} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <TextInput placeholder="Price, e.g. $99" value={str(item.price).replace(/\/.*$/, '')} onChange={(e) => setItem({ price: [e.target.value.trim(), (str(item.price).match(/\/(.*)$/) || [])[1]].filter(Boolean).join('/') })} />
        <TextInput placeholder="Per, e.g. month" value={(str(item.price).match(/\/(.*)$/) || [])[1] || ''} onChange={(e) => setItem({ price: [str(item.price).replace(/\/.*$/, '').trim(), e.target.value.trim()].filter(Boolean).join('/') })} />
      </div>
      <TextInput placeholder="One line about who it is for" value={str(item.description)} onChange={(e) => setItem({ description: e.target.value })} />
      <Row label="What is included (one per line)">
        <TextArea rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} placeholder={'Three sessions a month\nEmail support'}/>
      </Row>
      <Toggle checked={!!item.featured} onChange={(v) => setItem({ featured: v })} label="Highlight this plan" hint="Shown in your accent color, a little larger."/>
      <TextInput placeholder="Button text, e.g. Choose plan" value={str(item.ctaText)} onChange={(e) => setItem({ ctaText: e.target.value })} />
      {item.ctaText ? <LinkField value={item.ctaLink} onChange={(v) => setItem({ ctaLink: v })} label="Button opens" emptyMeans="booking"/> : null}
    </>
  );
}

// ---------- Newsletter ----------
function NewsletterEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Button text"><TextInput value={str(data.buttonText)} onChange={(e) => update({ buttonText: e.target.value })} /></Row>
      <Row label="Hint inside the email box"><TextInput value={str(data.placeholder)} onChange={(e) => update({ placeholder: e.target.value })} /></Row>
      <Row label="Thank-you message after they sign up"><TextInput value={str(data.successMessage)} placeholder="You're subscribed - thanks!" onChange={(e) => update({ successMessage: e.target.value })} /></Row>
      <Note>Sign-ups land in your Ivy inbox and in Clients, marked as a newsletter lead.</Note>
    </>
  );
}

// ---------- Video ----------
function VideoEditor({ data, update }) {
  const v = str(data.videoUrl).trim();
  const ok = v ? !!videoEmbedUrl(v) : true;
  return (
    <>
      <Headline data={data} update={update} label="Headline (optional)"/>
      <Sub data={data} update={update}/>
      <Row label={`Paste a link to your video (${VIDEO_HOSTS_LABEL})`}
        hint={ok ? 'Copy the link from the Share button on the video page. The normal watch link is fine.' : null}>
        <TextInput type="url" inputMode="url" value={str(data.videoUrl)} placeholder="https://www.youtube.com/watch?v=…"
          onChange={(e) => update({ videoUrl: e.target.value })}
          style={ok ? undefined : { borderColor: 'var(--danger)' }}/>
      </Row>
      {!ok && (
        <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.5 }}>
          That does not look like a {VIDEO_HOSTS_LABEL} link. Open the video there, tap Share and copy the link.
        </div>
      )}
      {ok && v && <Hint>Looks good. The video will play right on your page.</Hint>}
    </>
  );
}

// ---------- Logos ----------
function LogosEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update} label="Small heading above the logos"/>
      <Row label="Logos" as="div">
        <Repeater items={data.logos || []} onChange={(logos) => update({ logos })} addLabel="Add a logo" max={12}
          itemLabel={(it, i) => it.name || `Logo ${i + 1}`}
          make={() => ({ id: newItemId('l'), name: '', imgUrl: '', link: '' })}>
          {(item, setItem) => (
            <>
              <TextInput placeholder="Name (shown when there is no image)" value={str(item.name)} onChange={(e) => setItem({ name: e.target.value })} />
              <Row label="Logo image" as="div"><ImageInput value={item.imgUrl} onChange={(v) => setItem({ imgUrl: v })}/></Row>
              <LinkField value={item.link} onChange={(v) => setItem({ link: v })} label="Opens (optional)" emptyMeans="none"/>
            </>
          )}
        </Repeater>
      </Row>
    </>
  );
}

// ---------- Pricing comparison table ----------
function PricingTableEditor({ data, update }) {
  const tiers = Array.isArray(data.tiers) ? data.tiers.map(str) : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const setTier = (i, v) => update({ tiers: tiers.map((t, x) => (x === i ? v : t)) });
  const addTier = () => {
    if (tiers.length >= 5) return;
    update({ tiers: [...tiers, `Plan ${tiers.length + 1}`], rows: rows.map((r) => ({ ...r, values: [...(r.values || []), ''] })) });
  };
  const removeTier = (i) => update({ tiers: tiers.filter((_, x) => x !== i), rows: rows.map((r) => ({ ...r, values: (r.values || []).filter((_, x) => x !== i) })) });
  const { mobile } = useEditorCtx();
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Plans (the columns)" as="div">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {tiers.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 6 }}>
              <TextInput value={t} placeholder={`Plan ${i + 1}`} onChange={(e) => setTier(i, e.target.value)} />
              <button type="button" className="btn btn-ghost" onClick={() => removeTier(i)} title="Remove plan" aria-label={`Remove plan ${t || i + 1}`}
                style={{ width: mobile ? 44 : 34, padding: 0, flexShrink: 0, color: 'var(--danger)', justifyContent: 'center' }}><Icons.Trash size={13}/></button>
            </div>
          ))}
          {tiers.length < 5 && (
            <button type="button" className="btn btn-outline" onClick={addTier} style={{ justifyContent: 'center', fontSize: 12.5, minHeight: mobile ? 44 : undefined }}>
              <Icons.Plus size={13}/>Add a plan
            </button>
          )}
        </div>
      </Row>
      <Row label="Features (the rows)" as="div">
        <Repeater items={rows} onChange={(next) => update({ rows: next })} addLabel="Add a feature" max={30}
          itemLabel={(it, i) => it.label || `Feature ${i + 1}`}
          make={() => ({ id: newItemId('r'), label: '', values: tiers.map(() => '') })}>
          {(item, setItem) => (
            <>
              <TextInput placeholder="Feature, e.g. Sessions per month" value={str(item.label)} onChange={(e) => setItem({ label: e.target.value })} />
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, Math.min(tiers.length, mobile ? 2 : 3))}, 1fr)`, gap: 6 }}>
                {tiers.map((t, i) => (
                  <label key={i} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    <span style={{ fontSize: 10.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t || `Plan ${i + 1}`}</span>
                    <TextInput value={str((item.values || [])[i])} placeholder="✓, a number, or blank"
                      onChange={(e) => { const vals = tiers.map((_, x) => str((item.values || [])[x])); vals[i] = e.target.value; setItem({ values: vals }); }}/>
                  </label>
                ))}
              </div>
            </>
          )}
        </Repeater>
      </Row>
      <Hint>Type a check mark (✓), a number, or leave a box blank for "not included".</Hint>
    </>
  );
}

// ---------- Blog / posts ----------
function BlogEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Posts" as="div">
        <Repeater items={data.posts || []} onChange={(posts) => update({ posts })} addLabel="Add a post" max={12}
          itemLabel={(it, i) => it.title || `Post ${i + 1}`}
          make={() => ({ id: newItemId('b'), title: '', excerpt: '', url: '', date: new Date().toISOString().slice(0, 10) })}>
          {(item, setItem) => (
            <>
              <TextInput placeholder="Title" value={str(item.title)} onChange={(e) => setItem({ title: e.target.value })} />
              <TextArea rows={2} placeholder="A short preview" value={str(item.excerpt)} onChange={(e) => setItem({ excerpt: e.target.value })} />
              <Row label="Date" as="div"><DateInput value={item.date} onChange={(v) => setItem({ date: v })}/></Row>
              <LinkField value={item.url === '#' ? '' : item.url} onChange={(v) => setItem({ url: v })} label="Read more opens" emptyMeans="top"/>
            </>
          )}
        </Repeater>
      </Row>
    </>
  );
}

// ---------- Instagram ----------
function InstagramEditor({ data, update }) {
  const [draft, setDraft] = useState(() => str(data.url));
  useEffect(() => { setDraft(str(data.url)); }, [data.url]);
  const isPost = /instagram\.com\/(p|reel)\//i.test(str(data.url));
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Your Instagram username, or a link to a post"
        hint="Your username (like @yourstudio) shows a Follow button. A link to a post or reel shows that post right on the page.">
        <TextInput value={draft} placeholder="@yourstudio"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => update({ url: normalizeInstagram(draft) })}/>
      </Row>
      {data.url && <Hint>{isPost ? 'This post will show on your page.' : 'A "View on Instagram" button will open your profile.'}</Hint>}
    </>
  );
}

// ---------- Countdown ----------
function CountdownEditor({ data, update }) {
  const past = data.endDate && new Date(data.endDate).getTime() < Date.now();
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update} label="What it is counting down to"/>
      <Row label="Counts down to (date and time)" as="div" hint={past ? 'That time has passed, so the counter shows zero.' : 'Shown in each visitor\'s own time zone.'}>
        <DateTimeInput value={data.endDate} onChange={(v) => update({ endDate: v })}/>
      </Row>
      <Row label="Button text (optional)"><TextInput value={str(data.cta)} onChange={(e) => update({ cta: e.target.value })} /></Row>
      {data.cta ? <LinkField value={data.ctaLink} onChange={(v) => update({ ctaLink: v })} label="Button opens" emptyMeans="top"/> : null}
    </>
  );
}

// ---------- Hours ----------
const WEEKDAY_RE = /^(mon|tue|wed|thu|fri)/i;
function HoursEditor({ data, update }) {
  const { mobile } = useEditorCtx();
  const days = (Array.isArray(data.days) ? data.days : []).map(normalizeDay);
  const setDay = (i, patch) => update({ days: days.map((d, x) => (x === i ? normalizeDay({ ...d, ...patch }) : d)) });
  const copyMonday = () => {
    const mon = days.find((d) => /^mon/i.test(d.label)) || days[0];
    if (!mon) return;
    update({ days: days.map((d) => (WEEKDAY_RE.test(d.label) ? normalizeDay({ ...d, open: mon.open, close: mon.close, closed: mon.closed }) : d)) });
  };
  return (
    <>
      <Headline data={data} update={update}/>
      <Row label="Note under the heading (optional)" hint="For example: All times Eastern.">
        <TextInput value={str(data.timezone)} placeholder="All times Eastern" onChange={(e) => update({ timezone: e.target.value })} />
      </Row>
      <Row label="Each day" as="div">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {days.map((d, i) => (
            <div key={d.id || i} style={{ padding: 10, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <TextInput value={str(d.label)} aria-label="Day" onChange={(e) => setDay(i, { label: e.target.value })} style={{ flex: 1, fontWeight: 600 }}/>
                <Toggle checked={!!d.closed} onChange={(v) => setDay(i, { closed: v })} label="Closed"/>
              </div>
              {!d.closed && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 6, alignItems: 'center' }}>
                  <input type="time" value={str(d.open)} aria-label="Opens at" onChange={(e) => setDay(i, { open: e.target.value })} style={{ ...inputS, minHeight: mobile ? 44 : undefined }}/>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
                  <input type="time" value={str(d.close)} aria-label="Closes at" onChange={(e) => setDay(i, { close: e.target.value })} style={{ ...inputS, minHeight: mobile ? 44 : undefined }}/>
                </div>
              )}
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Shows as: {hoursText(d) || 'nothing yet'}</div>
            </div>
          ))}
        </div>
      </Row>
      <button type="button" className="btn btn-outline" onClick={copyMonday} style={{ justifyContent: 'center', fontSize: 12.5, minHeight: mobile ? 44 : undefined }}>
        <Icons.Copy size={13}/> Copy Monday to all weekdays
      </button>
    </>
  );
}

// ---------- Map ----------
function MapEditor({ data, update }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [draft, setDraft] = useState(() => str(data.address));
  const lastLooked = useRef(str(data.address));
  useEffect(() => { setDraft(str(data.address)); }, [data.address]);
  const hasPin = Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.lng)) && data.lat != null && data.lng != null;
  const { mobile } = useEditorCtx();

  const lookup = async (address) => {
    const a = str(address).trim();
    if (a.length < 3) { setMsg(null); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await api.post('/geocode', { address: a });
      lastLooked.current = a;
      if (!r.match) { setMsg({ err: true, text: "We couldn't find that address. Try adding the city or postcode." }); return; }
      update({ address: a, lat: r.match.lat, lng: r.match.lng });
      setMsg({ err: false, text: `Pinned: ${r.match.displayName}` });
    } catch {
      setMsg({ err: true, text: "We couldn't reach the map service just now. Your address is saved; try the lookup again in a moment." });
    } finally { setBusy(false); }
  };
  const commitAddress = () => {
    const a = draft.trim();
    if (a !== str(data.address)) update({ address: a });
    if (a && a !== lastLooked.current) lookup(a);
  };
  return (
    <>
      <Headline data={data} update={update}/>
      <Row label="Address" hint="Shown under the heading. We find it on the map for you.">
        <TextArea rows={2} value={draft} placeholder="123 Main St, Austin, TX 78701"
          onChange={(e) => setDraft(e.target.value)} onBlur={commitAddress}/>
      </Row>
      <button type="button" className="btn btn-outline" disabled={busy || draft.trim().length < 3} onClick={() => lookup(draft)}
        style={{ justifyContent: 'center', fontSize: 12.5, minHeight: mobile ? 44 : undefined }}>
        <Icons.Globe size={13}/> {busy ? 'Finding…' : 'Find this address on the map'}
      </button>
      {msg && <div style={{ fontSize: 12, color: msg.err ? 'var(--danger)' : 'var(--muted)', lineHeight: 1.5 }}>{msg.text}</div>}
      {!msg && hasPin && <Hint>Pinned on the map.</Hint>}
      {!msg && !hasPin && data.address && <Hint>No pin yet. Tap "Find this address on the map".</Hint>}
      <Toggle checked={data.showMap !== false} onChange={(v) => update({ showMap: v })} label="Show the map" hint="Off: only the heading and address show."/>
      {data.showMap !== false && (
        <Row label="How close the map zooms in" as="div">
          <Segmented value={Number(data.zoom) >= 16 ? 'street' : Number(data.zoom) <= 12 ? 'city' : 'area'}
            onChange={(z) => update({ zoom: z === 'street' ? 17 : z === 'city' ? 12 : 14 })}
            options={[{ id: 'street', label: 'Street' }, { id: 'area', label: 'Neighborhood' }, { id: 'city', label: 'City' }]}/>
        </Row>
      )}
    </>
  );
}

// ---------- Process / How it works ----------
const pad2 = (n) => String(n).padStart(2, '0');
const looksNumbered = (steps) => steps.every((s) => /^\d{1,2}$/.test(str(s.number).trim()) || !str(s.number).trim());
function renumber(steps) { return steps.map((s, i) => ({ ...s, number: pad2(i + 1) })); }

function ProcessEditor({ data, update }) {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const onChange = (next) => update({ steps: looksNumbered(next) ? renumber(next) : next });
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Steps" as="div" hint="Steps are numbered for you. Change a number if you want something else there.">
        <Repeater items={steps} onChange={onChange} addLabel="Add a step" max={12}
          itemLabel={(it, i) => `Step ${i + 1}${it.title ? `: ${it.title}` : ''}`}
          make={() => ({ id: newItemId('p'), number: pad2(steps.length + 1), title: '', desc: '' })}>
          {(item, setItem) => (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: 6 }}>
                <TextInput value={str(item.number)} aria-label="Step number" placeholder="01" maxLength={4}
                  onChange={(e) => update({ steps: steps.map((s) => (s.id === item.id ? { ...s, number: e.target.value } : s)) })}/>
                <TextInput placeholder="Step title" value={str(item.title)} onChange={(e) => setItem({ title: e.target.value })} />
              </div>
              <TextArea rows={3} placeholder="What happens in this step" value={str(item.desc)} onChange={(e) => setItem({ desc: e.target.value })} />
            </>
          )}
        </Repeater>
      </Row>
    </>
  );
}

// ---------- Before / after ----------
function BeforeAfterEditor({ data, update }) {
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Before photo" as="div"><ImageInput value={data.beforeUrl} onChange={(v) => update({ beforeUrl: v })}/></Row>
      <Row label="Label on the before photo"><TextInput value={str(data.beforeLabel)} placeholder="Before" onChange={(e) => update({ beforeLabel: e.target.value })} /></Row>
      <Row label="After photo" as="div"><ImageInput value={data.afterUrl} onChange={(v) => update({ afterUrl: v })}/></Row>
      <Row label="Label on the after photo"><TextInput value={str(data.afterLabel)} placeholder="After" onChange={(e) => update({ afterLabel: e.target.value })} /></Row>
    </>
  );
}

// ---------- Social feed ----------
function SocialFeedEditor({ data, update }) {
  const platform = normalizeSocialPlatform(data.platform) || 'tiktok';
  const [draft, setDraft] = useState(() => str(data.url));
  useEffect(() => { setDraft(str(data.url)); }, [data.url]);
  const p = SOCIAL_PLATFORMS.find((x) => x.id === platform);
  return (
    <>
      <Headline data={data} update={update}/>
      <Sub data={data} update={update}/>
      <Row label="Which network" as="div">
        <Select value={platform} onChange={(v) => update({ platform: v })}>
          {SOCIAL_PLATFORMS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </Select>
      </Row>
      <Row label="Your username or profile link" hint={`Visitors see a "View on ${p?.label || 'social'}" button that opens your profile.`}>
        <TextInput value={draft} placeholder={p?.example || 'https://…'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => update({ url: normalizeSocialUrl(platform, draft) })}/>
      </Row>
    </>
  );
}

// ---------- Legacy code sections ----------
// Shown instead of an editor for sections that were added with code
// before Ivy stopped offering them. They keep rendering exactly as they
// are; the owner can only remove them or pick a section from the library.
export function LegacyCodePanel({ onDelete }) {
  const { onOpenLibrary, mobile } = useEditorCtx();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Note>
        This section was added with code. Ivy no longer uses code sections. You can remove it, or replace it with a section from the library.
      </Note>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-outline" onClick={onDelete}
          style={{ flex: 1, justifyContent: 'center', color: 'var(--danger)', minHeight: mobile ? 44 : undefined }}>
          <Icons.Trash size={13}/> Remove
        </button>
        {onOpenLibrary && (
          <button type="button" className="btn btn-primary" onClick={onOpenLibrary}
            style={{ flex: 1, justifyContent: 'center', minHeight: mobile ? 44 : undefined }}>
            <Icons.Plus size={13}/> Open section library
          </button>
        )}
      </div>
    </div>
  );
}

// Last resort for a type nobody knows. Never shows raw data.
export function NoSettingsEditor() {
  return <Note>This section has no settings.</Note>;
}

export const EDITORS = {
  hero: HeroEditor,
  shop: ShopEditor,
  services: ServicesEditor,
  about: AboutEditor,
  booking: BookingEditor,
  testimonials: TestimonialsEditor,
  cancellation_policy: CancellationPolicyEditor,
  faq: FaqEditor,
  gallery: GalleryEditor,
  contact: ContactEditor,
  footer: FooterEditor,
  stats: StatsEditor,
  cta_banner: CtaBannerEditor,
  team: TeamEditor,
  pricing: PricingEditor,
  newsletter: NewsletterEditor,
  video: VideoEditor,
  logos: LogosEditor,
  pricing_table: PricingTableEditor,
  blog: BlogEditor,
  instagram: InstagramEditor,
  countdown: CountdownEditor,
  hours: HoursEditor,
  map: MapEditor,
  accordion: AccordionEditor,
  process: ProcessEditor,
  before_after: BeforeAfterEditor,
  social_feed: SocialFeedEditor,
};

// Every non-legacy type must have an editor; the test suite checks this,
// and so does this guard in development.
export const EDITOR_COVERAGE = Object.keys(SECTION_TYPES).filter((t) => !LEGACY_CODE_TYPES.has(t) && !EDITORS[t]);
