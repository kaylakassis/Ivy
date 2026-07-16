// Tour page. Originally ported 1:1 from the prototype's scroll-pinned
// "cinema" (280vh scenes + sticky pins + --p scroll progress), which read
// as broken in the field: content stayed invisible until you scrolled far
// past it, leaving huge black dead zones on both desktop and mobile.
// Rebuilt as normal-flow sections with a one-time IntersectionObserver
// reveal: every scene is fully readable the moment it enters the viewport,
// on any device size. The ambient design (aurora, gridlines, watermark
// timestamps, particle canvas, invoice status flip) is preserved.
import { useEffect } from 'react';
import { SiteNav, SiteFooter, usePageMeta, useSiteFonts, BASE_CSS } from './Chrome.jsx';

const PAGE_CSS = `
/* ===== AMBIENT BACKGROUND LAYERS ===== */
.site-root #bgCanvas{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.55}
.site-root .aurora{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}
.site-root .aurora i{position:absolute;border-radius:50%;filter:blur(90px);opacity:.5}
.site-root .aurora .a1{width:520px;height:520px;background:var(--glow,rgba(207,255,80,.14));top:-10%;left:-8%}
.site-root .aurora .a2{width:640px;height:640px;background:var(--glow2,rgba(34,211,238,.06));bottom:-20%;right:-10%}
.site-root .aurora .a3{width:300px;height:300px;background:rgba(207,255,80,.08);top:55%;left:38%}
.site-root .gridlines{position:absolute;inset:0;pointer-events:none;z-index:0;opacity:.35;background-image:linear-gradient(rgba(243,243,238,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(243,243,238,.025) 1px,transparent 1px);background-size:56px 56px;mask-image:radial-gradient(ellipse 70% 60% at 50% 50%,#000 30%,transparent 75%)}
.site-root .bigtime{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:var(--head);font-weight:700;font-size:clamp(110px,20vw,300px);letter-spacing:-.04em;color:transparent;-webkit-text-stroke:1px rgba(243,243,238,.06);white-space:nowrap;pointer-events:none;z-index:0;user-select:none}
/* ===== ONE-TIME REVEAL (IntersectionObserver adds .in) ===== */
.site-root .reveal{opacity:0;transform:translateY(24px);transition:opacity .6s ease var(--d,0s),transform .6s ease var(--d,0s)}
.site-root .reveal.in{opacity:1;transform:none}
.site-root .frame.reveal{transform:translateY(34px) scale(.97)}
.site-root .frame.reveal.in{transform:none}
/* ===== KINETIC TEXT STRIPS (now static sections, revealed on entry) ===== */
.site-root .strip{position:relative;padding:120px 24px;text-align:center;overflow:hidden}
.site-root .strip .line{font-family:var(--head);font-weight:700;letter-spacing:-.035em;white-space:nowrap;max-width:100%}
.site-root .strip .line.solid{font-size:clamp(30px,5.5vw,84px);color:var(--text)}
.site-root .strip .line.ghost{font-size:clamp(14px,2.4vw,30px);font-weight:600;margin-top:22px;color:transparent;-webkit-text-stroke:1px rgba(207,255,80,.45)}
.site-root .strip .line .hl{color:var(--lime)}
/* opening shimmer */
.site-root .t-open h1 .shimmer{background:linear-gradient(100deg,var(--lime) 30%,#eaffb0 50%,var(--lime) 70%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shim 3.2s linear infinite}
@keyframes shim{to{background-position:-200% 0}}
/* finale pulse */
.site-root .t-final h2 .pulseglow{color:var(--lime);text-shadow:0 0 40px rgba(207,255,80,.35);animation:pulseg 2.6s ease-in-out infinite}
@keyframes pulseg{50%{text-shadow:0 0 90px rgba(207,255,80,.7)}}
/* ===== TOUR OPENING ===== */
.site-root .t-open{position:relative;min-height:100vh;min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;overflow:hidden;padding:120px 24px 90px}
.site-root .t-open .glow{position:absolute;top:30%;left:50%;transform:translate(-50%,-50%);width:1000px;height:700px;background:radial-gradient(ellipse,rgba(207,255,80,.14) 0%,transparent 60%);pointer-events:none}
.site-root .t-open h1{font-size:clamp(40px,7vw,92px);letter-spacing:-.03em;line-height:1.05}
.site-root .t-open .sub{font-size:clamp(16px,2vw,21px);color:var(--muted);margin-top:20px;max-width:560px}
.site-root .t-open .hint{position:absolute;bottom:32px;left:50%;transform:translateX(-50%);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);animation:bob 2s infinite}
@keyframes bob{50%{transform:translateX(-50%) translateY(6px)}}

/* ===== SCENES (normal flow - fully visible as soon as they scroll in) ===== */
.site-root .scene{position:relative;padding:110px 0;overflow:hidden}
.site-root .scene .inner,.site-root .t-open .container{position:relative;z-index:2}
.site-root .scene .inner{display:grid;grid-template-columns:.85fr 1.15fr;gap:56px;align-items:center;width:100%}
.site-root .scene.flip .inner{grid-template-columns:1.15fr .85fr}
.site-root .scene.flip .s-copy{order:2}
.site-root .s-kicker{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--lime);margin-bottom:16px;font-family:Inter,sans-serif}
.site-root .s-copy h2{font-size:clamp(30px,4vw,52px);letter-spacing:-.025em;line-height:1.1;margin-bottom:16px}
.site-root .s-copy p{font-size:16.5px;color:var(--muted);max-width:420px}
/* device frame */
.site-root .frame{background:var(--panel);border:1px solid var(--border2);border-radius:18px;overflow:hidden;box-shadow:0 40px 100px rgba(0,0,0,.55)}
.site-root .frame-bar{display:flex;align-items:center;gap:7px;padding:12px 16px;background:var(--panel2);border-bottom:1px solid var(--border)}
.site-root .frame-bar span{width:10px;height:10px;border-radius:50%;background:var(--border2)}
.site-root .frame-bar .url{margin-left:10px;flex:1;background:var(--bg);border-radius:6px;font-size:11.5px;color:var(--dim);padding:4px 12px;font-family:Inter,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.site-root .frame-body{padding:22px}
/* ---- dashboard mockup ---- */
.site-root .mk-h{font-family:var(--head);font-size:19px;font-weight:600;margin-bottom:4px}
.site-root .mk-sub{font-size:12px;color:var(--dim);margin-bottom:16px}
.site-root .mk-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
.site-root .mk-stat{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.site-root .mk-stat .k{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.site-root .mk-stat .v{font-family:var(--head);font-size:20px;font-weight:600;margin-top:2px}
.site-root .mk-stat .v.lime{color:var(--lime)}
.site-root .mk-list{background:var(--bg);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.site-root .mk-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);font-size:12.5px}
.site-root .mk-row:last-child{border-bottom:none}
.site-root .mk-row .who{color:var(--text);font-weight:500}
.site-root .mk-row .who small{display:block;color:var(--dim);font-weight:400;font-size:11px}
.site-root .chip{font-size:10.5px;font-weight:600;padding:3px 10px;border-radius:999px;white-space:nowrap}
.site-root .chip.g{background:var(--tint);color:var(--lime);border:1px solid rgba(207,255,80,.3)}
.site-root .chip.a{background:rgba(251,191,36,.08);color:#fcd34d;border:1px solid rgba(251,191,36,.25)}
.site-root .chip.n{background:var(--panel2);color:var(--muted);border:1px solid var(--border2)}
/* ---- booking mockup ---- */
.site-root .mk-svc{display:flex;justify-content:space-between;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:13px 16px;margin-bottom:10px;font-size:13px}
.site-root .mk-svc b{font-weight:600}
.site-root .mk-svc .pr{color:var(--lime);font-weight:600}
.site-root .mk-times{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}
.site-root .mk-time{border:1px solid var(--border2);border-radius:8px;text-align:center;padding:9px 0;font-size:12px;color:var(--muted)}
.site-root .mk-time.sel{background:var(--lime);color:var(--ink);font-weight:700;border-color:var(--lime)}
.site-root .mk-confirm{background:var(--tint);border:1px solid rgba(207,255,80,.35);border-radius:10px;padding:13px 16px;font-size:12.5px;color:var(--text)}
.site-root .mk-confirm b{color:var(--lime)}
/* ---- invoice mockup ---- */
.site-root .inv-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;flex-wrap:wrap}
.site-root .inv-title{font-family:var(--head);font-size:17px;font-weight:600}
.site-root .inv-status{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:5px 14px;border-radius:999px;transition:.3s}
.site-root .inv-status.draft{background:var(--panel2);color:var(--muted);border:1px solid var(--border2)}
.site-root .inv-status.sent{background:rgba(251,191,36,.1);color:#fcd34d;border:1px solid rgba(251,191,36,.3)}
.site-root .inv-status.paid{background:var(--lime);color:var(--ink);border:1px solid var(--lime)}
.site-root .inv-lines{background:var(--bg);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:12px}
.site-root .inv-line{display:flex;justify-content:space-between;padding:11px 16px;border-bottom:1px solid var(--border);font-size:12.5px;color:var(--muted)}
.site-root .inv-line:last-child{border-bottom:none;color:var(--text);font-weight:600}
.site-root .inv-note{font-size:12px;color:var(--dim)}
.site-root .inv-note b{color:var(--lime)}
/* ---- chat mockup ---- */
.site-root .mk-msg{max-width:88%;padding:10px 14px;border-radius:12px;font-size:12.5px;line-height:1.5;margin-bottom:10px}
.site-root .mk-msg.u{margin-left:auto;background:var(--tint);border:1px solid rgba(207,255,80,.3);border-bottom-right-radius:4px}
.site-root .mk-msg.i{background:var(--panel2);border:1px solid var(--border);border-bottom-left-radius:4px;color:var(--muted)}
.site-root .mk-msg.i b{color:var(--text)}
.site-root .mk-act{display:flex;gap:8px;align-items:center;margin-top:8px;padding:8px 11px;background:rgba(207,255,80,.08);border:1px solid rgba(207,255,80,.25);border-radius:8px;font-size:11.5px;color:var(--lime)}
/* ---- website mockup ---- */
.site-root .web-hero{background:linear-gradient(160deg,var(--tint),var(--bg));border-radius:10px;padding:34px 24px;text-align:center;margin-bottom:12px;border:1px solid var(--border)}
.site-root .web-hero h4{font-family:var(--head);font-size:21px;font-weight:600;margin-bottom:6px}
.site-root .web-hero p{font-size:12px;color:var(--muted);margin-bottom:14px}
.site-root .web-btn{display:inline-block;background:var(--lime);color:var(--ink);font-size:11.5px;font-weight:700;padding:8px 18px;border-radius:7px}
.site-root .web-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.site-root .web-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px;font-size:11.5px;color:var(--muted)}
.site-root .web-card b{display:block;color:var(--text);font-size:12.5px;margin-bottom:3px}
/* ===== PROGRESS DOTS ===== */
.site-root .dots{position:fixed;right:22px;top:50%;transform:translateY(-50%);z-index:60;display:flex;flex-direction:column;gap:12px}
.site-root .dot{width:9px;height:9px;border-radius:50%;background:var(--border2);cursor:pointer;transition:.25s;border:none;padding:0}
.site-root .dot.on{background:var(--lime);transform:scale(1.35)}
/* ===== FINALE ===== */
.site-root .t-final{min-height:70vh;display:flex;align-items:center;text-align:center;position:relative;padding:120px 0}
.site-root .t-final::before{content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:900px;height:600px;background:radial-gradient(ellipse,rgba(207,255,80,.12) 0%,transparent 60%);pointer-events:none}
.site-root .t-final h2{font-size:clamp(36px,5.5vw,72px);letter-spacing:-.03em;line-height:1.08;margin-bottom:20px}
.site-root .t-final p{font-size:18px;color:var(--muted);max-width:520px;margin:0 auto 34px}
.site-root .t-final .cta-row{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
@media(max-width:900px){
  .site-root .t-open{min-height:88vh;min-height:88svh}
  .site-root .scene{padding:72px 0}
  .site-root .scene .inner,.site-root .scene.flip .inner{grid-template-columns:1fr;gap:28px}
  .site-root .scene.flip .s-copy{order:0}
  .site-root .bigtime{font-size:32vw;-webkit-text-stroke-color:rgba(243,243,238,.045)}
  .site-root .strip{padding:80px 20px}
  .site-root .dots{display:none}
}
@media(max-width:640px){
  .site-root .strip .line{white-space:normal}
  .site-root .strip .line.solid{font-size:clamp(28px,8.5vw,40px)}
  .site-root .strip .line.ghost{font-size:clamp(14px,4vw,18px)}
  .site-root .frame-body{padding:16px}
  .site-root .mk-stats{gap:7px}
  .site-root .mk-stat{padding:10px 10px}
  .site-root .mk-stat .v{font-size:17px}
  .site-root .web-grid{grid-template-columns:1fr;gap:8px}
}
@media (prefers-reduced-motion: reduce){
  .site-root .reveal{opacity:1!important;transform:none!important;transition:none!important}
  .site-root .t-open .hint,.site-root #bgCanvas{display:none}
  .site-root .t-open h1 .shimmer{animation:none;color:var(--lime);-webkit-text-stroke:0}
  .site-root .t-final h2 .pulseglow{animation:none}
}
`;

export default function SiteTour() {
  useSiteFonts();
  usePageMeta({
    title: 'Take the Tour - See Ivy Run a Business | Ivy',
    description: "Scroll through a day with Ivy: the dashboard, self-serve booking, invoices that chase themselves, an AI assistant that acts, and a website that builds itself. The all-in-one platform for solopreneurs, $8.99/week.",
    canonical: 'https://joinivy.ai/tour',
    ogType: 'website',
  });

  // Reveal-on-entry, progress dots, and the invoice status progression.
  // Everything is IntersectionObserver-based: content is never gated on
  // "how far through a pinned scene you've scrolled" - the moment an
  // element is on screen it animates in (once), so the page is always
  // readable on any viewport.
  useEffect(() => {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const reveals = [...document.querySelectorAll('.site-root .reveal')];
    const cleanups = [];

    if (reduceMotion || typeof IntersectionObserver === 'undefined') {
      reveals.forEach((el) => el.classList.add('in'));
    } else {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        }
      }, { threshold: 0.15, rootMargin: '0px 0px -6% 0px' });
      reveals.forEach((el) => io.observe(el));
      cleanups.push(() => io.disconnect());
    }

    // Progress dots (desktop): highlight the section nearest mid-viewport.
    const sceneIds = ['s0', 's1', 's2', 's3', 's4', 's5', 's6'];
    const scenes = sceneIds.map((id) => document.getElementById(id));
    const dotsWrap = document.getElementById('dots');
    if (dotsWrap) {
      dotsWrap.innerHTML = '';
      scenes.forEach((s, i) => {
        const d = document.createElement('button');
        d.className = 'dot' + (i === 0 ? ' on' : '');
        d.setAttribute('aria-label', 'Scene ' + (i + 1));
        d.onclick = () => { if (s) s.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }); };
        dotsWrap.appendChild(d);
      });
      const dots = [...dotsWrap.children];
      if (typeof IntersectionObserver !== 'undefined') {
        const activeIo = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const idx = scenes.indexOf(e.target);
            if (idx >= 0) dots.forEach((d, i) => d.classList.toggle('on', i === idx));
          }
        }, { rootMargin: '-45% 0px -45% 0px' });
        scenes.forEach((s) => { if (s) activeIo.observe(s); });
        cleanups.push(() => activeIo.disconnect());
      }
      cleanups.push(() => { dotsWrap.innerHTML = ''; });
    }

    // Invoice mockup: Draft → Sent → Paid, on a timer once the scene is
    // seen (previously tied to scroll depth, which most visitors never hit).
    const invStatus = document.getElementById('invStatus');
    const invNote = document.getElementById('invNote');
    if (invStatus && invNote) {
      const NOTES = {
        draft: 'Ivy drafted this the moment the session completed.',
        sent: 'Sent with a one-tap pay link. Due-soon reminder scheduled automatically.',
        paid: 'Paid in full - straight to your Stripe. Ivy says: nothing left to chase.',
      };
      const set = (cls, txt) => {
        invStatus.className = 'inv-status ' + cls;
        invStatus.textContent = txt;
        invNote.textContent = NOTES[cls];
      };
      if (reduceMotion || typeof IntersectionObserver === 'undefined') {
        set('paid', 'Paid ✓');
      } else {
        const timers = [];
        const invIo = new IntersectionObserver((entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          invIo.disconnect();
          timers.push(setTimeout(() => set('sent', 'Sent'), 1600));
          timers.push(setTimeout(() => set('paid', 'Paid ✓'), 3400));
        }, { threshold: 0.4 });
        const invScene = document.getElementById('s3');
        if (invScene) invIo.observe(invScene);
        cleanups.push(() => { invIo.disconnect(); timers.forEach(clearTimeout); });
      }
    }

    return () => { cleanups.forEach((fn) => fn()); };
  }, []);

  // Floating particle field (fixed canvas, scroll parallax). Skipped
  // entirely under prefers-reduced-motion, exactly like the prototype.
  useEffect(() => {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return undefined;
    const cv = document.getElementById('bgCanvas');
    if (!cv) return undefined;
    const cx = cv.getContext('2d');
    let W, H, parts = [];
    let lastY = scrollY, drift = 0;
    function sizeCanvas() {
      W = cv.width = innerWidth * devicePixelRatio;
      H = cv.height = innerHeight * devicePixelRatio;
      cv.style.width = innerWidth + 'px';
      cv.style.height = innerHeight + 'px';
    }
    function seed() {
      parts = [];
      const n = Math.min(90, Math.floor(innerWidth / 14));
      for (let i = 0; i < n; i++) {
        parts.push({
          x: Math.random() * W, y: Math.random() * H,
          r: (Math.random() * 1.6 + .5) * devicePixelRatio,
          vx: (Math.random() - .5) * .12 * devicePixelRatio,
          vy: (Math.random() - .5) * .12 * devicePixelRatio,
          depth: Math.random() * .8 + .2,           // parallax factor
          tw: Math.random() * Math.PI * 2,          // twinkle phase
        });
      }
    }
    sizeCanvas(); seed();
    const onResize = () => { sizeCanvas(); seed(); };
    addEventListener('resize', onResize);
    let rafId = 0;
    function draw(t) {
      // scroll velocity gives the field a gentle push
      const dy = scrollY - lastY; lastY = scrollY;
      drift += (Math.max(-30, Math.min(30, dy)) - drift) * .08;
      cx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy - drift * .06 * p.depth * devicePixelRatio;
        if (p.x < -10) p.x = W + 10;
        if (p.x > W + 10) p.x = -10;
        if (p.y < -10) p.y = H + 10;
        if (p.y > H + 10) p.y = -10;
        const a = .18 + .22 * Math.abs(Math.sin(t / 1400 + p.tw)) * p.depth;
        cx.beginPath();
        cx.arc(p.x, p.y, p.r * p.depth, 0, Math.PI * 2);
        cx.fillStyle = 'rgba(207,255,80,' + a.toFixed(3) + ')';
        cx.fill();
      }
      rafId = requestAnimationFrame(draw);
    }
    draw(0);
    return () => {
      cancelAnimationFrame(rafId);
      removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <div className="site-root">
      <style>{BASE_CSS + PAGE_CSS}</style>
      <canvas id="bgCanvas" aria-hidden="true" />

      <SiteNav active="/tour" />

      {/* OPENING */}
      <section className="t-open" id="s0">
        <div className="glow"></div>
        <div className="gridlines"></div>
        <div className="container">
          <h1>A day with <span className="shimmer">Ivy</span>.</h1>
          <p className="sub">Scroll through what running your business feels like when the busywork runs itself.</p>
        </div>
        <div className="hint">Scroll ↓</div>
      </section>

      {/* SCENE 1: DASHBOARD */}
      <section className="scene" id="s1" style={{ '--glow': 'rgba(207,255,80,.16)', '--glow2': 'rgba(34,211,238,.05)' }}>
        <div className="aurora"><i className="a1"></i><i className="a2"></i><i className="a3"></i></div><div className="gridlines"></div><span className="bigtime">8:02</span>
        <div className="container inner">
          <div className="s-copy reveal">
            <div className="s-kicker">8:02 AM · The Dashboard</div>
            <h2>Your whole business, one glance.</h2>
            <p>Revenue, today's schedule, who paid, who's drifting - the dashboard already did the checking-in you used to do across five apps.</p>
          </div>
          <div className="frame reveal" style={{ '--d': '.1s' }}>
            <div className="frame-bar"><span></span><span></span><span></span><div className="url">joinivy.ai/dashboard</div></div>
            <div className="frame-body">
              <div className="mk-h reveal" style={{ '--d': '.2s' }}>Good morning.</div>
              <div className="mk-sub reveal" style={{ '--d': '.2s' }}>Tuesday, March 10 · 4 appointments today</div>
              <div className="mk-stats">
                <div className="mk-stat reveal" style={{ '--d': '.28s' }}><div className="k">Revenue MTD</div><div className="v lime" id="dashRev">$4,280</div></div>
                <div className="mk-stat reveal" style={{ '--d': '.34s' }}><div className="k">Active clients</div><div className="v">38</div></div>
                <div className="mk-stat reveal" style={{ '--d': '.4s' }}><div className="k">Open invoices</div><div className="v">$720</div></div>
              </div>
              <div className="mk-list">
                <div className="mk-row reveal" style={{ '--d': '.46s' }}><span className="who">10:00 - Maya R.<small>Deep Tissue · deposit paid</small></span><span className="chip g">confirmed</span></div>
                <div className="mk-row reveal" style={{ '--d': '.52s' }}><span className="who">1:00 - Jordan T.<small>Consult · intake signed</small></span><span className="chip g">confirmed</span></div>
                <div className="mk-row reveal" style={{ '--d': '.58s' }}><span className="who">Sarah M. is 22 days quiet<small>Ivy drafted a check-in for your approval</small></span><span className="chip a">review</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SCENE 2: BOOKING */}
      <section className="scene flip" id="s2" style={{ '--glow': 'rgba(160,255,120,.13)', '--glow2': 'rgba(207,255,80,.07)' }}>
        <div className="aurora"><i className="a1"></i><i className="a2"></i><i className="a3"></i></div><div className="gridlines"></div><span className="bigtime">11:14</span>
        <div className="container inner">
          <div className="s-copy reveal">
            <div className="s-kicker">11:14 AM · The Booking Page</div>
            <h2>Clients book themselves.</h2>
            <p>Your public page shows real availability. They pick a time, pay the deposit, sign the intake - while you're mid-session with someone else.</p>
          </div>
          <div className="frame reveal" style={{ '--d': '.1s' }}>
            <div className="frame-bar"><span></span><span></span><span></span><div className="url">joinivy.ai/book/your-studio</div></div>
            <div className="frame-body">
              <div className="mk-h reveal" style={{ '--d': '.2s' }}>Book with Your Studio</div>
              <div className="mk-sub reveal" style={{ '--d': '.2s' }}>Choose a service</div>
              <div className="mk-svc reveal" style={{ '--d': '.28s' }}><span><b>Deep Tissue Massage</b> · 60 min</span><span className="pr">$120</span></div>
              <div className="mk-svc reveal" style={{ '--d': '.34s' }}><span><b>Consultation</b> · 30 min</span><span className="pr">Free</span></div>
              <div className="mk-sub reveal" style={{ '--d': '.4s' }}>Thursday, March 12</div>
              <div className="mk-times">
                <div className="mk-time reveal" style={{ '--d': '.44s' }}>9:00</div>
                <div className="mk-time reveal" style={{ '--d': '.48s' }}>10:30</div>
                <div className="mk-time sel reveal" style={{ '--d': '.56s' }}>2:00</div>
                <div className="mk-time reveal" style={{ '--d': '.52s' }}>4:30</div>
              </div>
              <div className="mk-confirm reveal" style={{ '--d': '.64s' }}><b>✓ Booked.</b> New client Alex P. paid a $25 deposit, signed your intake form, and got confirmation + reminders automatically.</div>
            </div>
          </div>
        </div>
      </section>

      {/* STRIP 1 */}
      <section className="strip" id="k1">
        <div className="gridlines"></div>
        <div className="line solid reveal">While you worked, <span className="hl">Ivy booked.</span></div>
        <div className="line ghost reveal" style={{ '--d': '.15s' }}>no phone tag · no back-and-forth · no empty slots</div>
      </section>

      {/* SCENE 3: INVOICE */}
      <section className="scene" id="s3" style={{ '--glow': 'rgba(251,191,36,.10)', '--glow2': 'rgba(207,255,80,.08)' }}>
        <div className="aurora"><i className="a1"></i><i className="a2"></i><i className="a3"></i></div><div className="gridlines"></div><span className="bigtime">4:45</span>
        <div className="container inner">
          <div className="s-copy reveal">
            <div className="s-kicker">4:45 PM · Getting Paid</div>
            <h2>Invoices that chase themselves.</h2>
            <p>Session ends, invoice drafts itself. One tap to send, a pay link your client actually uses, and reminders that go out so you never have to.</p>
          </div>
          <div className="frame reveal" style={{ '--d': '.1s' }}>
            <div className="frame-bar"><span></span><span></span><span></span><div className="url">joinivy.ai/finance</div></div>
            <div className="frame-body">
              <div className="inv-head reveal" style={{ '--d': '.2s' }}>
                <div className="inv-title">Invoice #1043 - Sarah M.</div>
                <div className="inv-status draft" id="invStatus">Draft</div>
              </div>
              <div className="inv-lines reveal" style={{ '--d': '.28s' }}>
                <div className="inv-line"><span>Deep Tissue Massage × 3</span><span>$360.00</span></div>
                <div className="inv-line"><span>Due in 14 days · pay link included</span><span></span></div>
                <div className="inv-line"><span>Total</span><span id="invTotal">$360.00</span></div>
              </div>
              <div className="inv-note reveal" style={{ '--d': '.36s' }} id="invNote">Ivy drafted this the moment the session completed.</div>
            </div>
          </div>
        </div>
      </section>

      {/* SCENE 4: IVY AI */}
      <section className="scene flip" id="s4" style={{ '--glow': 'rgba(207,255,80,.18)', '--glow2': 'rgba(120,200,255,.06)' }}>
        <div className="aurora"><i className="a1"></i><i className="a2"></i><i className="a3"></i></div><div className="gridlines"></div><span className="bigtime">9:20</span>
        <div className="container inner">
          <div className="s-copy reveal">
            <div className="s-kicker">9:20 PM · Meet Ivy</div>
            <h2>An assistant that actually does things.</h2>
            <p>Ask in plain English. Ivy reads your real numbers, drafts the work, and waits for your approval on anything that reaches a client.</p>
          </div>
          <div className="frame reveal" style={{ '--d': '.1s' }}>
            <div className="frame-bar"><span></span><span></span><span></span><div className="url">joinivy.ai/ivy</div></div>
            <div className="frame-body">
              <div className="mk-msg u reveal" style={{ '--d': '.2s' }}>Who's gone quiet lately?</div>
              <div className="mk-msg i reveal" style={{ '--d': '.32s' }}><b>Sarah</b> (22 days), <b>Jordan</b> (31 days), and <b>Maya</b> (34 days) - together about $640/mo in usual bookings. Want me to draft check-ins?</div>
              <div className="mk-msg u reveal" style={{ '--d': '.44s' }}>Yes - include my booking link</div>
              <div className="mk-msg i reveal" style={{ '--d': '.56s' }}>Done - three drafts ready for your approval:<div className="mk-act">✓ check-in → Sarah + booking link</div><div className="mk-act">✓ drafts queued → Jordan, Maya</div></div>
            </div>
          </div>
        </div>
      </section>

      {/* STRIP 2 */}
      <section className="strip" id="k2">
        <div className="gridlines"></div>
        <div className="line solid reveal">You approve. <span className="hl">Ivy does.</span></div>
        <div className="line ghost reveal" style={{ '--d': '.15s' }}>drafts · reminders · follow-ups · rebookings</div>
      </section>

      {/* SCENE 5: WEBSITE */}
      <section className="scene" id="s5" style={{ '--glow': 'rgba(34,211,238,.08)', '--glow2': 'rgba(207,255,80,.10)' }}>
        <div className="aurora"><i className="a1"></i><i className="a2"></i><i className="a3"></i></div><div className="gridlines"></div><span className="bigtime">DAY 1</span>
        <div className="container inner">
          <div className="s-copy reveal">
            <div className="s-kicker">Day One · Your Website</div>
            <h2>A real website, on your domain.</h2>
            <p>Pick a template, publish to yourname.com, and every visitor who fills the form lands straight in your client list. SEO plumbing included.</p>
          </div>
          <div className="frame reveal" style={{ '--d': '.1s' }}>
            <div className="frame-bar"><span></span><span></span><span></span><div className="url">yourstudio.com</div></div>
            <div className="frame-body">
              <div className="web-hero reveal" style={{ '--d': '.2s' }}>
                <h4>Your Studio</h4>
                <p>Massage therapy in Portland - book online in 60 seconds</p>
                <span className="web-btn">Book now</span>
              </div>
              <div className="web-grid">
                <div className="web-card reveal" style={{ '--d': '.3s' }}><b>Services</b>Deep tissue, sports, prenatal</div>
                <div className="web-card reveal" style={{ '--d': '.38s' }}><b>Reviews</b>★★★★★ "The best hour of my week"</div>
                <div className="web-card reveal" style={{ '--d': '.46s' }}><b>Contact</b>Form → your client list, automatically</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FINALE */}
      <section className="t-final" id="s6">
        <div className="container" style={{ position: 'relative' }}>
          <h2 className="reveal">One login.<br /><span className="pulseglow">Zero busywork.</span></h2>
          <p className="reveal" style={{ '--d': '.1s' }}>Everything you just scrolled through is one plan - $8.99/week after a 14-day free trial. Or try the interactive demo and ask Ivy something yourself.</p>
          <div className="cta-row reveal" style={{ '--d': '.2s' }}>
            <a href="/signup" className="btn btn-primary">Start your 14-day free trial</a>
            <a href="/#tour" className="btn" style={{ border: '1px solid var(--border2)', color: 'var(--text)' }}>Ask Ivy something</a>
          </div>
          <p className="trust reveal" style={{ marginTop: '16px', '--d': '.3s' }}>$0 today · Cancel anytime · No transaction fees</p>
        </div>
      </section>

      <SiteFooter />

      <div className="dots" id="dots" />
    </div>
  );
}
