// Talks to the backend (server.ts in the repo root).
//   · localhost: Vite forwards /api to it (vite.config.js), nothing to set
//   · deployed page (Vercel): open it ONCE with ?api=<your laptop's tunnel URL>, e.g.
//       https://syncopation-peach.vercel.app/?api=https://xxxx.trycloudflare.com
//     the address is remembered on that phone/browser until you open it with a new ?api=

const API = (() => {
  const fromUrl = new URLSearchParams(window.location.search).get('api');
  try {
    if (fromUrl) localStorage.setItem('syncopation-api', fromUrl.replace(/\/+$/, ''));
    return (localStorage.getItem('syncopation-api') || '').replace(/\/+$/, '');
  } catch {
    return (fromUrl || '').replace(/\/+$/, '');
  }
})();
const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname);
const base = isLocal && !new URLSearchParams(window.location.search).get('api') ? '' : API;
const headers = { 'ngrok-skip-browser-warning': '1' }; // harmless elsewhere; lets an ngrok tunnel answer directly

const post = async (path, body) => {
  const r = await fetch(`${base}/api/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

/** The theme is in: planning and scraping start now. Resolves with the session id. */
export const startSession = (theme, room) =>
  post('start', { theme, room }).then((j) => j.id).catch(() => {
    throw new Error(base || isLocal
      ? 'Backend not reachable. Is npm run app (and the tunnel) running on the laptop?'
      : 'No backend set. Open this page once with ?api=<your laptop tunnel URL>');
  });

/** Polls until the first sounds are ready; `onProgress(done, total)` along the way. */
export async function whenReady(id, onProgress) {
  for (;;) {
    const r = await fetch(`${base}/api/status?id=${encodeURIComponent(id)}`, { headers });
    const s = await r.json().catch(() => ({}));
    if (s.state === 'ready') return;
    if (s.state === 'error' || !r.ok) throw new Error(s.error || "Couldn't load the sounds.");
    onProgress?.(s.done || 0, s.total || 0);
    await new Promise((res) => setTimeout(res, 600));
  }
}

/** Starts the live talk: the laptop's mic listens, sounds play from the laptop. */
export const startTalk = (id, minutes, room) => post('talk', { id, minutes, room });

/** Ends the talk (the report is printed in the backend terminal). */
export const stopTalk = (room) => post('stop', { room }).catch(() => {});

// ---- story rooms: one person creates a story and gets a code; others join with it and follow along ----

/** Creates a room on the backend; resolves with its code (random, made by the server). */
export const createRoom = () =>
  post('room', {}).then((j) => j.code).catch(() => {
    throw new Error(base || isLocal ? 'Backend not reachable. Is it running on the laptop?' : 'No backend set for this page.');
  });

/** A room's state: { state: 'waiting' | 'live' | 'ended', startedAt, serverNow }, or null if the code doesn't exist. */
export async function getRoom(code) {
  const r = await fetch(`${base}/api/room/${encodeURIComponent(code.trim().toUpperCase())}`, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
