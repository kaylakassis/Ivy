// Browser speech-input hooks for the messages composer.
//
//   useDictation()   – live transcription, fills the composer with text.
//                       No recording, no upload. Tap mic, talk, tap again
//                       to stop. Sends as a normal text message.
//
//   useVoiceMemo()   – records an audio blob AND captures a transcript
//                       simultaneously by running SpeechRecognition and
//                       MediaRecorder against the same mic stream. The
//                       sent message has both the audio attachment and
//                       the transcript as the visible text.
//
// Both rely on Web APIs that ship with every modern browser:
//   • SpeechRecognition / webkitSpeechRecognition - Chrome desktop +
//     Android, Safari iOS 14.5+, Edge. Firefox doesn't ship it.
//   • MediaRecorder + getUserMedia - universal in 2026.
//
// Running both in parallel works in Chrome and Safari today; I've
// tested it. If a browser only supports one, the hooks degrade
// gracefully (`supported` flag flips so the UI can hide the button).
import { useEffect, useRef, useState, useCallback } from 'react';

const SR = (typeof window !== 'undefined')
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;
const MR = (typeof window !== 'undefined') ? window.MediaRecorder : null;

// Pick the first MIME type the browser actually supports. webm/opus is
// universal in Chromium; Safari prefers mp4. The recorder will throw if
// we hand it an unsupported type.
function pickAudioMime() {
  if (!MR) return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const t of candidates) {
    if (MR.isTypeSupported && MR.isTypeSupported(t)) return t;
  }
  return '';
}

function newRecognition() {
  if (!SR) return null;
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  return r;
}

// ── useDictation - live transcript only ────────────────────────────
//
//   { supported, listening, error, start, stop, transcript }
//
//   start(onTranscript)  fires onTranscript(fullText) on every interim/
//                        final update so callers can do controlled
//                        input replacement. Returns once recognition
//                        has actually started.
export function useDictation() {
  const recRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const [transcript, setTranscript] = useState('');

  const start = useCallback((onTranscript) => {
    if (!SR) {
      setError('Voice input not supported in this browser');
      return;
    }
    setError(null);
    setTranscript('');
    const r = newRecognition();
    let final = '';
    r.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) final += t;
        else interim += t;
      }
      const all = (final + interim).replace(/\s+/g, ' ').trim();
      setTranscript(all);
      onTranscript?.(all);
    };
    r.onerror = (ev) => {
      // 'no-speech' just means quiet - not an error worth surfacing.
      if (ev.error && ev.error !== 'no-speech') setError(ev.error);
    };
    r.onend = () => setListening(false);
    try {
      r.start();
      recRef.current = r;
      setListening(true);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* already stopped */ }
    setListening(false);
  }, []);

  useEffect(() => () => { try { recRef.current?.abort(); } catch {} }, []);

  return { supported: !!SR, listening, error, start, stop, transcript };
}

// ── useVoiceMemo - audio blob + parallel transcript ─────────────────
//
//   start()  → opens the mic, starts MediaRecorder + SpeechRecognition
//              against the same input. Both run until stop().
//   stop()   → resolves to { blob, mime, transcript, durationMs }
//   cancel() → aborts both, throws away the audio. No upload.
export function useVoiceMemo() {
  const recorderRef = useRef(null);
  const recognitionRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startTsRef = useRef(0);
  const transcriptRef = useRef('');
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const supported = !!MR && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  // Tick the elapsed counter once a second so the UI can show "0:13" etc.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsedMs(Date.now() - startTsRef.current), 250);
    return () => clearInterval(t);
  }, [recording]);

  const teardown = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch {}
    recognitionRef.current = null;
    try { recorderRef.current?.stop(); } catch {}
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    streamRef.current = null;
    chunksRef.current = [];
  }, []);

  const start = useCallback(async () => {
    if (!supported) { setError('Recording not supported in this browser'); return false; }
    setError(null);
    setTranscript('');
    setElapsedMs(0);
    transcriptRef.current = '';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickAudioMime();
      const recorder = mime ? new MR(stream, { mimeType: mime }) : new MR(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      recorder.start();

      // Spin up SpeechRecognition in parallel - it ignores our stream
      // and opens its own mic capture under the hood, which on every
      // browser I've tested is fine alongside MediaRecorder. If it
      // fails we still get the audio.
      if (SR) {
        const rec = newRecognition();
        rec.onresult = (ev) => {
          let final = '';
          let interim = '';
          for (let i = 0; i < ev.results.length; i++) {
            const t = ev.results[i][0].transcript;
            if (ev.results[i].isFinal) final += t;
            else interim += t;
          }
          const all = (final + interim).replace(/\s+/g, ' ').trim();
          transcriptRef.current = all;
          setTranscript(all);
        };
        // Don't surface SR errors as fatal - the audio recording is
        // the primary artifact; transcription is best-effort.
        rec.onerror = () => {};
        try { rec.start(); recognitionRef.current = rec; } catch {/* ignored */}
      }

      startTsRef.current = Date.now();
      setRecording(true);
      return true;
    } catch (e) {
      setError(e.message || 'Microphone access denied');
      teardown();
      return false;
    }
  }, [supported, teardown]);

  const stop = useCallback(() => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder) { resolve(null); return; }
      const finishedAt = Date.now();
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const out = {
          blob,
          mime: recorder.mimeType || 'audio/webm',
          transcript: transcriptRef.current,
          durationMs: finishedAt - startTsRef.current,
        };
        teardown();
        setRecording(false);
        resolve(out);
      };
      try { recognitionRef.current?.stop(); } catch {}
      try { recorder.stop(); } catch { teardown(); setRecording(false); resolve(null); }
    });
  }, [teardown]);

  const cancel = useCallback(() => { teardown(); setRecording(false); }, [teardown]);

  useEffect(() => () => teardown(), [teardown]);

  return { supported, recording, error, start, stop, cancel, transcript, elapsedMs };
}
