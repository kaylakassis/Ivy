// The 30-second product video, placed once on the home page just under
// the hero stats. Plays silently on its own when scrolled into view (the
// film reads without sound), and "Watch with sound" restarts it with
// audio. The hero's "Watch the video" link scrolls here and does the
// same. One asset, two ways in.
import { useEffect, useRef, useState } from 'react';

export const VIDEO_SRC = '/video/ivy-product.mp4';
export const VIDEO_SRC_WEBM = '/video/ivy-product.webm';
export const VIDEO_POSTER = '/video/ivy-product-poster.jpg';
const PLAY_EVENT = 'ivy:play-product-video';

// Called by the hero link: scroll to the player and play with sound.
export function playProductVideo(e) {
  if (e) e.preventDefault();
  window.dispatchEvent(new CustomEvent(PLAY_EVENT));
}

const CSS = `
.site-root .pv{padding:72px 0 24px}
.site-root .pv-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px}
.site-root .pv-head h2{margin:0}
.site-root .pv-head p{margin:6px 0 0;color:var(--muted);max-width:52ch}
.site-root .pv-frame{position:relative;border-radius:18px;overflow:hidden;background:#0B1F1A;border:1px solid var(--border2);box-shadow:0 30px 80px rgba(0,0,0,.45);aspect-ratio:16/9;max-width:100%}
.site-root .pv-frame video{display:block;width:100%;height:100%;object-fit:cover;background:#0B1F1A}
.site-root .pv-cta{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(to top,rgba(0,0,0,.35),rgba(0,0,0,0) 45%);border:0;cursor:pointer;padding:0;font:inherit;color:#fff}
.site-root .pv-cta span{display:inline-flex;align-items:center;gap:10px;padding:12px 20px 12px 16px;border-radius:999px;background:rgba(15,35,30,.82);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(8px);font-size:15px;font-weight:600;letter-spacing:.01em;transition:transform .15s ease,background .15s ease}
.site-root .pv-cta:hover span,.site-root .pv-cta:focus-visible span{transform:scale(1.03);background:rgba(15,35,30,.95)}
.site-root .pv-cta i{display:inline-flex;width:30px;height:30px;border-radius:50%;background:#4CBA7F;color:#06261A;align-items:center;justify-content:center;font-style:normal;font-size:12px}
.site-root .pv-cta:focus-visible{outline:2px solid #4CBA7F;outline-offset:-4px}
@media(max-width:560px){.site-root .pv{padding:48px 0 0}.site-root .pv-frame{border-radius:12px}}
`;

export default function ProductVideo() {
  const wrapRef = useRef(null);
  const vidRef = useRef(null);
  const [withSound, setWithSound] = useState(false);

  // Autoplay silently while at least half the frame is on screen; pause
  // when it leaves. Skipped for people who asked for less motion, and
  // once the viewer has chosen sound (the native controls take over).
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return undefined;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (withSound) return;
        if (e.isIntersecting && !reduce) v.play().catch(() => {});
        else v.pause();
      });
    }, { threshold: 0.5 });
    obs.observe(v);
    return () => obs.disconnect();
  }, [withSound]);

  const playWithSound = () => {
    const v = vidRef.current;
    if (!v) return;
    setWithSound(true);
    v.muted = false;
    v.loop = false;
    v.currentTime = 0;
    v.play().catch(() => {});
  };

  // The hero link: scroll here, then play with sound.
  useEffect(() => {
    const onPlay = () => {
      wrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(playWithSound, 450);
    };
    window.addEventListener(PLAY_EVENT, onPlay);
    return () => window.removeEventListener(PLAY_EVENT, onPlay);
  }, []);

  return (
    <section className="pv" id="video" ref={wrapRef}>
      <style>{CSS}</style>
      <div className="container">
        <div className="pv-head">
          <div>
            <span className="eyebrow">See it in 30 seconds</span>
            <h2>Everything you need, all in one place.</h2>
            <p>Watch Ivy take the admin overwhelm and confusion off your plate.</p>
          </div>
        </div>
        <div className="pv-frame">
          <video
            ref={vidRef}
            poster={VIDEO_POSTER}
            muted={!withSound}
            loop={!withSound}
            playsInline
            preload="metadata"
            controls={withSound}
            aria-label="Ivy product video, 30 seconds"
            onEnded={() => { if (withSound) setWithSound(false); }}
          >
            <source src={VIDEO_SRC} type="video/mp4"/>
            <source src={VIDEO_SRC_WEBM} type="video/webm"/>
          </video>
          {!withSound && (
            <button type="button" className="pv-cta" onClick={playWithSound} aria-label="Watch the video with sound">
              <span><i>▶</i> Watch with sound · 0:30</span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
