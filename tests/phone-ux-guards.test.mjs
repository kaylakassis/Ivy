// Guards for the phone UX pass (1.0.7). These are things a browser walk
// found; the checks keep them from quietly coming back.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const css = src('src/styles/global.css');
const touch = css.slice(css.indexOf('Touch targets'));
assert(/@media \(pointer: coarse\)/.test(touch), 'touch targets apply on touch screens only (nothing changes with a mouse)');
assert(/calc\(\(100% - 44px\) \/ 2\)/.test(touch) && /calc\(\(100% - 40px\) \/ 2\)/.test(touch), 'small buttons get a tap area of at least 44px tall and 40px wide');
assert(/min\(0px,/.test(touch), 'the tap area never shrinks or moves a control that is already big enough');
assert(/:where\(button, \[role="button"\], a\.btn, summary\):where\(:not\(\[style\*="all:"\]\)[^{]*::after/.test(touch), 'buttons, button-like elements and button links are all covered');
assert(/:not\(\[style\^="position:"\]\):not\(\[style\*="; position:"\]\)/.test(touch) && /position: relative/.test(touch),
  'every such control is positioned, so the tap area is anchored to the control itself and can never cover a whole panel');

const messages = src('src/features/messages/Messages.jsx');
assert(/gridTemplateColumns: isMobile \? 'minmax\(0, 1fr\)' : '320px minmax\(0, 1fr\)'/.test(messages), 'Messages: one long preview cannot push the list off the screen');
assert(/aria-label="New message"/.test(messages), 'Messages: the New message button has a name');

const shell = src('src/components/layout/AppShell.jsx');
assert(/!native && !viewport\.isMobile && <IvyDock\/>/.test(shell), 'the floating Ivy button is not shown on phones (the bottom bar has an Ivy tab)');

const clients = src('src/features/clients/Clients.jsx');
assert(/aria-label=\{`More actions for \$\{client\.name/.test(clients), 'Clients: the row menu button has a name');
assert(/<ClientMetricsChips metrics=\{metrics\} quiet\/>/.test(clients), 'Clients: the phone card shows nothing (not a dash) when there is nothing due');
assert(/className="grid-auto stat-grid"/.test(clients) && /\.stat-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css), 'Clients: summary cards sit two to a row on a phone');

const cal = src('src/features/calendar/Calendar.jsx');
assert((cal.match(/onClick=\{\(\) => nav\(-1\)\}[^>]*aria-label="Previous"/g) || []).length === 2 && (cal.match(/onClick=\{\(\) => nav\(1\)\}[^>]*aria-label="Next"/g) || []).length === 2, 'Calendar: every previous / next arrow has a name');

const goals = src('src/features/goals/Goals.jsx');
assert(/role="checkbox" aria-checked=\{!!task\.done\}/.test(goals) && /aria-label=\{`Delete task:/.test(goals) && /aria-label="Add task"/.test(goals), 'Tasks: tick, delete and add all have names');

// iPhone app: full-screen pop-ups stay between the clock and the home bar.
assert(/\[role="dialog"\]\[style\*="inset: 0"\] \{\s*padding-top: calc\(env\(safe-area-inset-top, 0px\) \+ 12px\) !important;\s*padding-bottom: calc\(env\(safe-area-inset-bottom, 0px\) \+ 12px\) !important;/.test(css),
  'full-screen pop-ups keep their panel below the iPhone clock and above the home bar');
assert(/\[role="dialog"\]\[style\*="inset: 0"\]:not\(\[style\*="overflow"\]\) > \* \{ max-height: 100% !important; margin-bottom: 0 !important; \}/.test(css),
  'a tall pop-up panel fits inside that space instead of sliding under the clock');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
