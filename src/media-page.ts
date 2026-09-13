/**
 * nixamp.com/hash/<id>, as a page: everything nixamp knows about one file,
 * for a person with a browser. The same facts as the OpenFile descriptor
 * beside it, laid out: what it is, how long, what is inside, who said what
 * it was, where it has been carried, and the transcript in every language
 * it has been written down in, with subtitle files to take away.
 *
 * Rendered on the server from a string, with the terminal's look, so a
 * crawler and a link preview read it and nothing has to load first.
 */
import type { MediaRecord, TranscriptRef } from "./media.ts";
import type { TranscriptLine } from "./transcripts.ts";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function bytes(size: number): string {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${size} B`;
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function when(iso: string): string {
  return iso ? esc(iso.replace("T", " ").replace(/\.\d+Z$/, " UTC")) : "";
}

const STYLE = `
  :root { color-scheme: dark; --bg:#080c09; --panel:#0c120e; --edge:#1d2c22; --green:#4af689; --dim:#227a4a; --fg:#cfe8d8; --muted:#6d8a79; --accent:#7ef0c4; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  main { max-width: 960px; margin: 0 auto; padding: 20px 16px 48px; }
  a { color: var(--accent); }
  .brand { color: var(--green); font-weight: 700; letter-spacing: .14em; text-decoration: none; }
  h1 { font-size: 20px; margin: 18px 0 4px; color: var(--green); overflow-wrap: anywhere; }
  .id { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .panel { position: relative; border: 1px solid var(--edge); border-radius: 6px; background: var(--panel); padding: 18px 12px 12px; margin-top: 16px; }
  .panel::before { content: attr(data-title); position: absolute; top: -9px; left: 10px; padding: 0 6px; background: var(--panel); color: var(--dim); font-size: 12px; letter-spacing: .06em; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 3px 8px 3px 0; vertical-align: top; overflow-wrap: anywhere; }
  td:first-child { color: var(--muted); white-space: nowrap; width: 11em; }
  .poster { float: right; max-width: 160px; margin: 0 0 8px 12px; border: 1px solid var(--edge); border-radius: 4px; }
  ul { margin: 0; padding-left: 1.2em; }
  .lines { list-style: none; padding: 0; max-height: 420px; overflow-y: auto; font-size: 13px; }
  .lines li { display: flex; gap: 8px; padding: 2px 0; border-bottom: 1px dotted var(--edge); }
  .lines .t { color: var(--muted); flex: 0 0 auto; }
  .chips a { display: inline-block; margin: 0 8px 6px 0; border: 1px solid var(--edge); border-radius: 999px; padding: 1px 10px; font-size: 12px; text-decoration: none; }
  .muted { color: var(--muted); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); font-size: 12px; }
`;

export interface PageTranscript extends TranscriptRef {
  /** The lines themselves, for the one transcript the page shows. */
  shown?: TranscriptLine[];
}

/** The page, whole. `transcripts[0]` carries the lines shown; the rest are offered as files. */
export function mediaPage(record: MediaRecord, site: string, transcripts: PageTranscript[] = []): string {
  const base = site.replace(/\/+$/, "");
  const f = record.facts;
  const title = f.enrichment?.title || f.tags?.title || record.name || record.id.slice(0, 12);
  const picture = f.enrichment?.image ?? null;
  const url = `${base}/hash/${record.id}`;
  const summary = f.enrichment?.summary ?? "";
  const description = summary || `${record.name}${f.duration ? `, ${clock(f.duration)}` : ""}${transcripts.length > 0 ? `, transcribed in ${transcripts.map((one) => one.language || "its own language").join(", ")}` : ""}`;

  const rows: [string, string][] = [];
  if (record.name) rows.push(["File", esc(record.name)]);
  if (record.size) rows.push(["Size", bytes(record.size)]);
  if (record.contentType) rows.push(["Type", esc(record.contentType)]);
  if (f.duration) rows.push(["Length", clock(f.duration)]);
  if (f.width && f.height) rows.push(["Picture", `${f.width}×${f.height}`]);
  if (f.codecs) rows.push(["Inside", esc([f.codecs.video, f.codecs.audio, f.codecs.container].filter(Boolean).join(" / "))]);
  if (f.tags?.artist || f.tags?.album) rows.push(["Tagged", esc([f.tags.artist, f.tags.album].filter(Boolean).join(" · "))]);
  if (record.updated) rows.push(["File changed", when(record.updated)]);
  if (f.checkedAt) rows.push(["Last checked", `${when(f.checkedAt)}${f.checkAfter ? `, next ${when(f.checkAfter)}` : ""}`]);
  if (f.fingerprint) rows.push(["Fingerprint", `<span class="id">${esc(f.fingerprint)}</span>`]);
  if (f.supersedes) rows.push(["Was", `<a href="${base}/hash/${esc(f.supersedes.replace(/^sha256:/, ""))}">${esc(f.supersedes)}</a>`]);
  if (f.supersededBy) rows.push(["Became", `<a href="${base}/hash/${esc(f.supersededBy.replace(/^sha256:/, ""))}">${esc(f.supersededBy)}</a>`]);
  rows.push(["Kept", `${when(record.createdAt)}${record.updatedAt !== record.createdAt ? `, last added to ${when(record.updatedAt)}` : ""}`]);

  const enrichment = f.enrichment
    ? `<section class="panel" data-title="What nichedb says it is">
      ${picture ? `<img class="poster" src="${esc(picture)}" alt="" />` : ""}
      <table>
        <tr><td>Title</td><td>${esc(f.enrichment.title ?? "")}${f.enrichment.year ? ` (${f.enrichment.year})` : ""}</td></tr>
        ${f.enrichment.kind ? `<tr><td>Kind</td><td>${esc(f.enrichment.kind)}</td></tr>` : ""}
        ${summary ? `<tr><td>About</td><td>${esc(summary)}</td></tr>` : ""}
        ${f.enrichment.page ? `<tr><td>Page</td><td><a href="${esc(f.enrichment.page)}">${esc(f.enrichment.page)}</a></td></tr>` : ""}
      </table>
    </section>`
    : "";

  const holders = record.holders.length > 0
    ? `<section class="panel" data-title="Carried by">
      <ul>${record.holders.map((h) => `<li><a href="${esc(h.url)}">${esc(h.name || h.url)}</a>${h.channel ? ` as <code>${esc(h.channel)}</code>` : ""} <span class="muted">${when(h.seenAt)}</span></li>`).join("")}</ul>
    </section>`
    : "";

  const shown = transcripts[0];
  const transcript = transcripts.length > 0
    ? `<section class="panel" data-title="Transcript">
      <p class="chips">${transcripts.map((one) => {
        const q = one.language ? `?language=${esc(one.language)}` : "";
        return `<a href="${url}.srt${q}">${esc(one.language || "as spoken")}${one.translatedFrom ? ` (from ${esc(one.translatedFrom)})` : ""} · ${one.lines} lines${one.complete ? "" : " so far"} · SRT</a> <a href="${url}.vtt${q}">VTT</a> <a href="${url}.txt${q}">text</a>`;
      }).join("<br />")}</p>
      ${shown?.shown && shown.shown.length > 0
        ? `<ul class="lines">${shown.shown.map((line) => `<li><span class="t">${clock(line.start)}</span><span>${esc(line.text)}</span></li>`).join("")}</ul>`
        : ""}
    </section>`
    : `<section class="panel" data-title="Transcript"><p class="muted">Not written down yet. <code>nixamp transcribe FILE</code> keeps it here, and a server captioning it does too.</p></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · nixamp</title>
<meta name="description" content="${esc(description.slice(0, 300))}" />
<link rel="canonical" href="${url}" />
<link rel="openfile" href="${url}.openfile.json" />
<link rel="alternate" type="application/json" href="${url}.json" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description.slice(0, 300))}" />
<meta property="og:url" content="${url}" />
<meta property="og:type" content="${record.contentType.startsWith("video/") ? "video.other" : record.contentType.startsWith("audio/") ? "music.song" : "website"}" />
${picture ? `<meta property="og:image" content="${esc(picture)}" />` : ""}
<style>${STYLE}</style>
</head>
<body>
<main>
  <a class="brand" href="${base}/">NIXAMP</a>
  <h1>${esc(title)}</h1>
  <div class="id">sha256:${esc(record.id)}</div>
  <section class="panel" data-title="The file">
    <table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
  </section>
  ${enrichment}
  ${holders}
  ${transcript}
  <section class="panel" data-title="For a program">
    <p class="muted">This page as <a href="${url}.openfile.json">OpenFile</a> (<a href="https://logicsrc.com/docs/openfile">the specification</a>) or <a href="${url}.json">JSON</a>. Every file nixamp.com knows: <a href="${base}/.well-known/openfile.json">/.well-known/openfile.json</a>.</p>
    <pre>nixamp hash FILE            the same address for a file of yours
nixamp transcribe FILE      and its transcript, kept here</pre>
  </section>
</main>
</body>
</html>
`;
}
