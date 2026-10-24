// Step 1 of the user flow: keywords, theme, layers, density, optional script → Start.
// Start creates the session; the Scrape job runs in Convex and this page shows its
// progress live, then the pairing code once the library is ready.

import { useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { THEMES } from "../themes";

type Density = "subtle" | "normal" | "expressive";

export default function Setup() {
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [themeId, setThemeId] = useState(THEMES[0].id);
  const [layers, setLayers] = useState({ music: true, sfx: true, voice: false });
  const [density, setDensity] = useState<Density>("normal");
  const [script, setScript] = useState("");
  const [session, setSession] = useState<{ sessionId: Id<"sessions">; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation(api.sessions.create);
  const rerun = useMutation(api.scrape.rerun);
  const job = useQuery(api.scrape.status, session ? { sessionId: session.sessionId } : "skip");
  const theme = THEMES.find((t) => t.id === themeId)!;

  const addKeywords = (text: string) => {
    const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) setKeywords((k) => Array.from(new Set([...k, ...parts])).slice(0, 15));
    setDraft("");
  };

  const start = async () => {
    setError(null);
    const all = draft.trim() ? Array.from(new Set([...keywords, ...draft.split(",").map((s) => s.trim()).filter(Boolean)])) : keywords;
    try {
      const res = await create({
        prompt,
        keywords: all,
        theme: theme.id,
        moods: theme.moods,
        themeSfx: layers.sfx ? theme.sfx : [],
        layers,
        density,
        script: script.trim() || undefined,
      });
      setKeywords(all);
      setDraft("");
      setSession(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (session) {
    const pct = job && job.total ? Math.round((job.completed / job.total) * 100) : 0;
    const done = job?.status === "done";
    const failed = job?.status === "failed";
    return (
      <main style={S.page}>
        <h1 style={S.h1}>{done ? "Ready to pair" : failed ? "Couldn't build the library" : "Building your sound library…"}</h1>
        <div style={S.bar}><div style={{ ...S.fill, width: `${done ? 100 : pct}%` }} /></div>
        <p style={S.muted}>{job?.message ?? "Starting"}{job && job.total > 0 && !done ? ` · ${job.completed}/${job.total}` : ""}</p>
        {done && (
          <>
            <p style={S.label}>Pairing code</p>
            <p style={S.code}>{session.code}</p>
            <p style={S.muted}>Open /input on the speaker's phone and /output on the speaker-system phone, then enter this code.</p>
            {job.missing.length > 0 && <p style={S.warn}>No sound found for: {job.missing.join(", ")}. The tracker won't propose those.</p>}
          </>
        )}
        {(done || failed) && (
          <button style={S.secondary} onClick={() => rerun({ sessionId: session.sessionId })}>Rebuild library</button>
        )}
        {job?.log?.length ? (
          <details style={{ marginTop: 16 }}>
            <summary style={S.muted}>Details</summary>
            <pre style={S.pre}>{job.log.join("\n")}</pre>
          </details>
        ) : null}
      </main>
    );
  }

  return (
    <main style={S.page}>
      <h1 style={S.h1}>New session</h1>

      <label style={S.label}>What's the talk about?</label>
      <input style={S.input} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A ghost story set in my grandmother's farmhouse" />

      <label style={S.label}>Keywords</label>
      <div style={S.chips}>
        {keywords.map((k) => (
          <button key={k} style={S.chip} onClick={() => setKeywords(keywords.filter((x) => x !== k))} aria-label={`Remove ${k}`}>
            {k} ×
          </button>
        ))}
      </div>
      <input
        style={S.input}
        value={draft}
        onChange={(e) => (e.target.value.endsWith(",") ? addKeywords(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => e.key === "Enter" && addKeywords(draft)}
        onBlur={() => draft && addKeywords(draft)}
        placeholder={theme.keywordHint}
      />

      <label style={S.label}>Theme</label>
      <div style={S.row}>
        {THEMES.map((t) => (
          <button key={t.id} style={t.id === themeId ? S.on : S.off} onClick={() => setThemeId(t.id)}>{t.label}</button>
        ))}
      </div>
      <p style={S.muted}>Moods: {theme.moods.join(" → ")}</p>

      <label style={S.label}>Layers</label>
      <div style={S.row}>
        {(["music", "sfx", "voice"] as const).map((l) => (
          <button key={l} style={layers[l] ? S.on : S.off} onClick={() => setLayers({ ...layers, [l]: !layers[l] })}>
            {l === "sfx" ? "SFX" : l[0].toUpperCase() + l.slice(1)}
          </button>
        ))}
      </div>

      <label style={S.label}>Density</label>
      <div style={S.row}>
        {(["subtle", "normal", "expressive"] as const).map((d) => (
          <button key={d} style={density === d ? S.on : S.off} onClick={() => setDensity(d)}>{d[0].toUpperCase() + d.slice(1)}</button>
        ))}
      </div>

      <label style={S.label}>Script or slide notes (optional)</label>
      <textarea style={{ ...S.input, minHeight: 80 }} value={script} onChange={(e) => setScript(e.target.value)} />

      {error && <p style={S.warn}>{error}</p>}
      <button style={S.primary} onClick={start} disabled={!keywords.length && !draft.trim()}>Start</button>
    </main>
  );
}

const S: Record<string, CSSProperties> = {
  page: { maxWidth: 480, margin: "0 auto", padding: "24px 16px", fontFamily: "system-ui, sans-serif" },
  h1: { fontSize: 24, margin: "0 0 16px" },
  label: { display: "block", fontWeight: 600, margin: "18px 0 6px" },
  input: { width: "100%", boxSizing: "border-box", padding: 10, fontSize: 16, borderRadius: 8, border: "1px solid #ccc" },
  row: { display: "flex", gap: 8, flexWrap: "wrap" },
  chips: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 },
  chip: { padding: "4px 10px", borderRadius: 999, border: "1px solid #999", background: "#f2f2f2", fontSize: 14 },
  on: { padding: "8px 12px", borderRadius: 8, border: "1px solid #222", background: "#222", color: "#fff" },
  off: { padding: "8px 12px", borderRadius: 8, border: "1px solid #ccc", background: "#fff", color: "#222" },
  primary: { width: "100%", marginTop: 24, padding: 14, fontSize: 17, borderRadius: 10, border: 0, background: "#3b5bdb", color: "#fff" },
  secondary: { marginTop: 16, padding: "10px 14px", borderRadius: 8, border: "1px solid #ccc", background: "#fff" },
  muted: { color: "#666", fontSize: 14 },
  warn: { color: "#b02a37", fontSize: 14 },
  bar: { height: 8, background: "#eee", borderRadius: 4, overflow: "hidden" },
  fill: { height: "100%", background: "#3b5bdb", transition: "width .3s" },
  code: { fontSize: 48, letterSpacing: 8, fontWeight: 700, margin: "4px 0" },
  pre: { whiteSpace: "pre-wrap", fontSize: 12, background: "#f6f6f6", padding: 8, borderRadius: 6 },
};
