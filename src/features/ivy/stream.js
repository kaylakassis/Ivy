// Ivy's reply, streamed. POSTs to /api/ivy/stream and relays its Server-Sent
// Events to the caller as they arrive:
//
//   delta  → onDelta(text)   a chunk of the reply, in order
//   reset  → onReset()       forget the text shown so far (a tool turn's preamble)
//   done   → resolves { event: 'done', payload }   the plain endpoint's body
//   error  → resolves { event: 'error', payload }  message + (usually) that body
//
// fetch + ReadableStream rather than EventSource: EventSource cannot POST,
// cannot carry a body or the native Bearer header, and so cannot work inside
// the Capacitor WebView. When the body is not readable as a stream (an older
// WebView), the whole response is read at once and parsed the same way, so the
// reply still arrives; it just does not grow.
//
// Throws the same errors api.* throws (err.status: 0 for network, the HTTP
// status otherwise) when the request itself fails, and a `cutOff` error when
// the connection ends before a terminal event. Every error carries
// err.textArrived so the caller knows whether the owner saw anything.
import { apiFetch, httpError } from '../../lib/api.js';

export async function streamReply(body, { onDelta, onReset, signal } = {}) {
  let textArrived = false;
  const tag = (err) => Object.assign(err, { textArrived });

  let res;
  try {
    res = await apiFetch('POST', '/ivy/stream', body, { signal });
  } catch (e) {
    throw tag(e);
  }
  if (!res.ok) throw tag(await httpError(res));

  // A runtime that answered with plain JSON (no streaming): that body is the
  // done payload.
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json')) {
    return { event: 'done', payload: await res.json() };
  }

  let terminal = null;
  const parser = sseParser((event, data) => {
    if (terminal) return;
    if (event === 'delta') {
      if (data && typeof data.text === 'string' && data.text) {
        textArrived = true;
        onDelta?.(data.text);
      }
    } else if (event === 'reset') {
      textArrived = false;
      onReset?.();
    } else if (event === 'done' || event === 'error') {
      terminal = { event, payload: data || {} };
    }
  });

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
        if (terminal) { try { reader.cancel(); } catch { /* already closed */ } break; }
      }
      parser.push(decoder.decode());
    } catch (e) {
      // The server had accepted the turn (headers arrived), so this is a
      // cut-off, never a reason to resend: the owner's message is saved.
      if (!terminal) {
        throw tag(Object.assign(
          new Error("Ivy's reply was cut off before it finished. Please try again."),
          { cutOff: true, cause: e?.message || 'stream read failed' },
        ));
      }
    }
  } else {
    parser.push(await res.text());
  }
  parser.end();

  if (!terminal) {
    throw tag(Object.assign(
      new Error("Ivy's reply was cut off before it finished. Please try again."),
      { cutOff: true },
    ));
  }
  return terminal;
}

// Minimal SSE framing: events are separated by a blank line; each line is
// "field: value"; comment lines start with ":"; several data lines join with
// a newline. Every data payload here is JSON.
function sseParser(onEvent) {
  let buf = '';
  const frame = (raw) => {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line[0] === ':') continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (!dataLines.length) return;
    let data;
    try { data = JSON.parse(dataLines.join('\n')); } catch { return; }
    onEvent(event, data);
  };
  return {
    push(chunk) {
      buf += chunk;
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        frame(raw);
      }
    },
    end() {
      if (buf.trim()) frame(buf);
      buf = '';
    },
  };
}
