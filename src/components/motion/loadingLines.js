// Playful loading lines. Plain JS (no JSX) so tests can import it under
// node; LoadingLine.jsx re-exports everything from here.
//
// Two sets: the OWNER set is about Ivy getting ready to work for the owner
// and only ever shows inside the business app. The CLIENT set is for the
// client portal and public pages (booking, invoice), where the reader is
// the owner's customer. Never show the owner set on a client surface.

export const LOADING_LINES = [
  'Loading… Ivy is making a coffee.',
  'Loading… Ivy is watering the plants.',
  'Loading… Ivy is untangling the charger cables.',
  'Loading… Ivy is finding a pen that works.',
  'Loading… Ivy is warming up her typing fingers.',
  'Loading… Ivy is alphabetizing the sticky notes.',
  'Loading… Ivy is putting on her reading glasses.',
  'Loading… Ivy is looking for where she left the stapler.',
  'Loading… Ivy is stretching. Big day.',
  'Loading… Ivy is doing one more lap of the inbox.',
  'Loading… Ivy is refilling the snack drawer.',
  'Loading… Ivy is straightening the picture frames.',
  'Loading… Ivy is counting to three. One. Two.',
  'Loading… Ivy is humming something.',
  'Loading… Ivy is practicing her "you\'ve got this" face.',
  'Loading… Ivy is making the coffee a little stronger.',
  'Loading… Ivy is putting the kettle on for round two.',
  'Loading… Ivy is tidying the desk. Again.',
  'Loading… Ivy is opening all the windows.',
  'Loading… Ivy is clicking refresh too.',
  'Loading… Ivy is fluffing the cushions.',
  'Loading… Ivy is looking for her other sock.',
  'Loading… Ivy is rearranging the desk plants.',
  'Loading… Ivy is topping up the coffee. Again.',
];

export const CLIENT_LOADING_LINES = [
  'Loading… pulling up your bookings.',
  'Loading… finding your next appointment.',
  "Loading… checking what's new from your provider.",
  'Loading… setting the table.',
  'Loading… warming up the calendar.',
  'Loading… getting your paperwork in order.',
  'Loading… polishing the invoice.',
  'Loading… lining up the open times.',
  'Loading… one sec, almost ready.',
  'Loading… rolling out the welcome mat.',
  'Loading… counting down to your next session.',
  'Loading… turning the lights on.',
  'Loading… fluffing the pillows in the waiting room.',
  'Loading… lighting a candle for you.',
  'Loading… saving you the good seat.',
  'Loading… putting your name on the door.',
  'Loading… straightening the welcome sign.',
  'Loading… holding the door open.',
  'Loading… writing your name on the schedule in nice handwriting.',
  'Loading… clearing a spot just for you.',
  'Loading… Ivy is counting to three. One. Two.',
  'Loading… Ivy is stretching. Big day.',
  'Loading… Ivy is warming up her typing fingers.',
  'Loading… Ivy is untangling the charger cables.',
  'Loading… Ivy is finding a pen that works.',
  'Loading… Ivy is making a coffee.',
];

export const SETS = { owner: LOADING_LINES, client: CLIENT_LOADING_LINES };

// Pick a random index that is never `prev` (for a list of 2+ lines). Pure:
// the component keeps the "last shown" index per set in a module variable
// below so a line never repeats back to back anywhere in the session.
export function pickNext(prev, lines = LOADING_LINES) {
  const n = lines.length;
  if (n <= 1) return 0;
  if (prev == null || prev < 0 || prev >= n) return Math.floor(Math.random() * n);
  // Draw from the n-1 other indexes, then skip over `prev`.
  const r = Math.floor(Math.random() * (n - 1));
  return r >= prev ? r + 1 : r;
}

const lastShown = { owner: null, client: null };

export function nextLine(set = 'owner') {
  const lines = SETS[set] || LOADING_LINES;
  const key = SETS[set] ? set : 'owner';
  const i = pickNext(lastShown[key], lines);
  lastShown[key] = i;
  return lines[i];
}
