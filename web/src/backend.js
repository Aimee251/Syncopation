// Talks to the backend (server.ts in the repo root). Vite forwards /api there (vite.config.js).

const post = async (path, body) => {
  const r = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

/** The theme is in: planning and scraping start now. Resolves with the session id. */
export const startSession = (theme) =>
  post('start', { theme }).then((j) => j.id).catch(() => {
    throw new Error('Backend not running. Start it with: npm run app');
  });

/** Polls until the first sounds are ready; `onProgress(done, total)` along the way. */
export async function whenReady(id, onProgress) {
  for (;;) {
    const r = await fetch(`/api/status?id=${encodeURIComponent(id)}`);
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
