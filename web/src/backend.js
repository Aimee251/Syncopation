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
export const startSession = (theme) =>
  post('start', { theme }).then((j) => j.id).catch(() => {
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
export const startTalk = (id, minutes) => post('talk', { id, minutes });

/** Ends the talk (the report is printed in the backend terminal). */
export const stopTalk = () => post('stop', {}).catch(() => {});
