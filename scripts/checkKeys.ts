export {};
// npm run keys — tests every API key in .env and says what is left, so "no sounds" can be traced to the service
// that ran out (Freesound: 2000 searches/day + 60/min · ElevenLabs: monthly credits · Claude: account credits).
// Each check is one tiny request; nothing is generated or downloaded.

const env = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, (v ?? "").trim()]));
type Row = { service: string; status: string; detail: string };
const rows: Row[] = [];
const mark = (ok: boolean | null) => (ok === null ? "– not set" : ok ? "✓ OK" : "✗ PROBLEM");
const timeout = (ms: number) => AbortSignal.timeout(ms);

async function check(service: string, key: string | undefined, run: () => Promise<{ ok: boolean; detail: string }>) {
  if (!key) return rows.push({ service, status: mark(null), detail: "no key in .env" });
  try { const r = await run(); rows.push({ service, status: mark(r.ok), detail: r.detail }); }
  catch (e) { rows.push({ service, status: mark(false), detail: `request failed: ${(e as Error).message}` }); }
}
const body = async (res: Response) => (await res.text()).replace(/\s+/g, " ").slice(0, 160);

await Promise.all([
  check("Claude (planning + predictions)", env.ANTHROPIC_API_KEY, async () => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: timeout(15000),
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: env.CLAUDE_MODEL || "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    return res.ok ? { ok: true, detail: "key works" } : { ok: false, detail: `HTTP ${res.status}: ${await body(res)}` };
  }),
  check("Freesound (sound search)", env.FREESOUND_API_KEY, async () => {
    const res = await fetch(`https://freesound.org/apiv2/search/text/?query=rain&page_size=1&fields=id&token=${encodeURIComponent(env.FREESOUND_API_KEY)}`, { signal: timeout(15000) });
    let used = 0;
    try { const u = JSON.parse((await import("node:fs")).readFileSync(".cache/usage.json", "utf8")); if (u.date === new Date().toISOString().slice(0, 10)) used = u.freesound; } catch { }
    if (res.ok) return { ok: true, detail: `search works · ${used} of ~2000 searches used today by this project (limit also ~60/min)` };
    if (res.status === 429) return { ok: false, detail: `THROTTLED — ${await body(res)} (daily limit used up? make a 2nd key or wait)` };
    if (res.status === 401) return { ok: false, detail: "key rejected (401): wrong key, or it's the client id instead of the API key" };
    return { ok: false, detail: `HTTP ${res.status}: ${await body(res)}` };
  }),
  check("ElevenLabs (generated sounds)", env.ELEVENLABS_API_KEY, async () => {
    // permission probe: an empty request is rejected as invalid (422) when the key may generate, and as 401 when it may not — no credits used
    const probe = await fetch("https://api.elevenlabs.io/v1/sound-generation", { method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" }, body: "{}", signal: timeout(15000) });
    if (probe.status === 401 || probe.status === 403) {
      const t = await body(probe);
      return { ok: false, detail: /permission/i.test(t)
        ? "key is missing the Sound Effects permission → elevenlabs.io → Developers → API Keys → edit this key → set Sound Effects to Access (or make a new key with it on), paste it into .env"
        : `key rejected (${probe.status}): ${t} — wrong key or extra spaces/quotes in .env` };
    }
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": env.ELEVENLABS_API_KEY }, signal: timeout(15000) });
    if (!res.ok) {
      const t = await body(res);
      // a key without the "user read" permission can't read its own quota but may still generate
      if (res.status === 401 && /permission/i.test(t)) return { ok: true, detail: "key works, but it may not read its quota (missing user_read permission)" };
      return { ok: false, detail: `HTTP ${res.status}: ${t}` };
    }
    const s: any = await res.json();
    const used = Number(s.character_count ?? 0), limit = Number(s.character_limit ?? 0), left = limit - used;
    return { ok: left > 0, detail: `${s.tier ?? "?"} plan: ${left.toLocaleString()} of ${limit.toLocaleString()} credits left${left <= 0 ? " — OUT OF CREDITS (no generated sounds until it resets)" : ""}${s.tier === "free" ? " · music generation needs a paid plan" : ""}` };
  }),
  check("Deepgram (speech to text)", env.DEEPGRAM_API_KEY, async () => {
    const res = await fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` }, signal: timeout(15000) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${await body(res)}` };
    const p: any = await res.json();
    const id = p.projects?.[0]?.project_id;
    if (!id) return { ok: true, detail: "key works" };
    const b = await fetch(`https://api.deepgram.com/v1/projects/${id}/balances`, { headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` }, signal: timeout(15000) });
    const bal: any = b.ok ? await b.json() : null;
    const amt = bal?.balances?.[0];
    return { ok: amt ? amt.amount > 0 : true, detail: amt ? `balance ${amt.amount} ${amt.units}` : "key works" };
  }),
  check("Apify (2nd search, optional)", env.APIFY_TOKEN, async () => {
    const res = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(env.APIFY_TOKEN)}`, { signal: timeout(15000) });
    return res.ok ? { ok: true, detail: "token works (searches are off unless APIFY_ENABLE=1)" } : { ok: false, detail: `HTTP ${res.status}` };
  }),
]);

console.table(Object.fromEntries(rows.map(r => [r.service, { status: r.status, detail: r.detail }])));
const dupes = Object.entries((await import("node:fs")).readFileSync(".env", "utf8").split("\n").map(l => l.match(/^\s*([A-Z_]+)\s*=/)?.[1]).filter(Boolean)
  .reduce((m: Record<string, number>, k) => ({ ...m, [k!]: (m[k!] ?? 0) + 1 }), {})).filter(([, n]) => n > 1).map(([k]) => k);
if (dupes.length) console.log(`\n⚠ .env sets ${dupes.join(", ")} more than once — the LAST line wins. Delete the old line so the new key is used.`);
console.log("\nWith an exhausted service the talk still works: sounds are reused from your earlier sessions (sessions/*/sounds).");
