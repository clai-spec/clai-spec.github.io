#!/usr/bin/env node
// Taglish video pipeline: FFmpeg (cut + mix) -> Groq (transcribe) -> HyperFrames (captions + graphics).
//
//   node make-video.mjs input.mp4 [options]
//
// See README.md for every option. Requires ffmpeg/ffprobe, the hyperframes CLI, and GROQ_API_KEY
// (unless --transcript points at an existing transcript JSON).

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    start: { type: "string" },
    end: { type: "string" },
    title: { type: "string" },
    subtitle: { type: "string" },
    music: { type: "string" },
    "music-volume": { type: "string", default: "0.18" },
    language: { type: "string" },
    model: { type: "string", default: "whisper-large-v3" },
    prompt: { type: "string" },
    transcript: { type: "string" },
    "words-per-caption": { type: "string", default: "4" },
    "caption-color": { type: "string", default: "#FFFFFF" },
    "highlight-color": { type: "string", default: "#FFD43B" },
    quality: { type: "string", default: "delivery" },
    "work-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (opts.help || positionals.length !== 1) {
  console.log(readFileSync(new URL("./README.md", import.meta.url), "utf8"));
  process.exit(opts.help ? 0 : 1);
}

const input = resolve(positionals[0]);
if (!existsSync(input)) fail(`Input not found: ${input}`);
const name = basename(input, extname(input));
const work = resolve(opts["work-dir"] ?? join(process.cwd(), "work", name));
const project = join(work, "captions");
const out = resolve(opts.out ?? join(process.cwd(), `${name}-final.mp4`));
mkdirSync(project, { recursive: true });

// Default prompt nudges Whisper to keep code-switched English words instead of translating them.
const TAGLISH_PROMPT =
  "Taglish ito, halo ng Tagalog at English. Okay guys, so ayun, sobrang ganda talaga, " +
  "kasi you know, parang ang hirap i-explain pero sige, let's go!";

const ffmpeg = (...args) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

// 1. FFmpeg: cut the clip and re-encode to a clean H.264/AAC base.
step("1/5 FFmpeg: cutting video");
const cut = join(work, "cut.mp4");
const trim = [...(opts.start ? ["-ss", opts.start] : []), ...(opts.end ? ["-to", opts.end] : [])];
ffmpeg(...trim, "-i", input, "-c:v", "libx264", "-preset", "medium", "-crf", "18",
  "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", cut);

const { width, height, duration } = probe(cut);
console.log(`   ${width}x${height}, ${duration.toFixed(2)}s`);

// 2. Groq: transcribe (Taglish-aware) with word-level timestamps.
step("2/5 Groq: transcribing");
const transcriptPath = join(work, "transcript.json");
let transcript;
if (opts.transcript) {
  transcript = JSON.parse(readFileSync(resolve(opts.transcript), "utf8"));
  console.log(`   using existing transcript ${opts.transcript}`);
} else {
  const audio = join(work, "audio.mp3");
  // 16 kHz mono keeps an hour of speech well under Groq's upload limit.
  ffmpeg("-i", cut, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio);
  transcript = await transcribe(audio);
}
writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
const words = extractWords(transcript);
if (!words.length) fail("Transcript has no words; nothing to caption.");
console.log(`   ${words.length} words: "${transcript.text?.trim().slice(0, 80) ?? ""}..."`);

// 3. HyperFrames: build the caption + graphics composition.
step("3/5 HyperFrames: building composition");
copyFileSync(cut, join(project, "cut.mp4"));
// Ship GSAP inside the project so rendering never depends on a CDN being reachable.
copyFileSync(createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js"), join(project, "gsap.min.js"));
const captions = groupCaptions(words, Number(opts["words-per-caption"]));
writeFileSync(join(project, "index.html"), composition({ width, height, duration, captions }));
writeFileSync(join(project, "hyperframes.json"), JSON.stringify({
  $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
  paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
}, null, 2));
writeFileSync(join(project, "meta.json"), JSON.stringify({ id: `${name}-captions`, name }, null, 2));
console.log(`   ${captions.length} caption cards -> ${project}`);

// 4. HyperFrames: render.
step("4/5 HyperFrames: rendering");
const rendered = join(work, "captioned.mp4");
const localHf = join(dirname(new URL(import.meta.url).pathname), "node_modules", ".bin", "hyperframes");
run(existsSync(localHf) ? localHf : "hyperframes", ["render", project, "-o", rendered, "-q", opts.quality]);

// 5. FFmpeg: mix music under the voice (ducked) and normalize loudness for social platforms.
step("5/5 FFmpeg: mixing audio");
const loudnorm = "loudnorm=I=-14:TP=-1.5:LRA=11";
if (opts.music) {
  const vol = Number(opts["music-volume"]);
  ffmpeg("-i", rendered, "-stream_loop", "-1", "-i", resolve(opts.music), "-filter_complex",
    `[0:a]asplit=2[voice][key];` +
    `[1:a]volume=${vol},afade=t=out:st=${Math.max(0, duration - 2)}:d=2[bed];` +
    `[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked];` +
    `[voice][ducked]amix=inputs=2:duration=first:normalize=0,${loudnorm}[a]`,
    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-t", String(duration), "-movflags", "+faststart", out);
} else {
  ffmpeg("-i", rendered, "-af", loudnorm, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", out);
}

writeSrt(join(work, `${name}.srt`), captions);
console.log(`\nDone: ${out}\n   transcript: ${transcriptPath}\n   subtitles:  ${join(work, name + ".srt")}`);

// ---------------------------------------------------------------------------

async function transcribe(audioPath) {
  const key = process.env.GROQ_API_KEY;
  if (!key) fail("GROQ_API_KEY is not set. Get one at https://console.groq.com/keys");
  const mb = statSync(audioPath).size / 1e6;
  if (mb > 25) fail(`Audio is ${mb.toFixed(1)} MB; Groq's free tier accepts 25 MB. Cut the video shorter with --start/--end.`);

  const form = new FormData();
  form.append("file", new Blob([readFileSync(audioPath)], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", opts.model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  form.append("temperature", "0");
  form.append("prompt", opts.prompt ?? TAGLISH_PROMPT);
  if (opts.language) form.append("language", opts.language);

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) fail(`Groq ${res.status}: ${await res.text()}`);
  return res.json();
}

// Prefer Groq's word timestamps; fall back to spreading each segment's words evenly.
function extractWords(t) {
  if (Array.isArray(t.words) && t.words.length) {
    return t.words.map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })).filter((w) => w.text);
  }
  return (t.segments ?? []).flatMap((s) => {
    const parts = s.text.trim().split(/\s+/).filter(Boolean);
    const step = (s.end - s.start) / Math.max(parts.length, 1);
    return parts.map((text, i) => ({ text, start: s.start + i * step, end: s.start + (i + 1) * step }));
  });
}

// Short cards read best on phones: break on word count, sentence ends, pauses, or length.
function groupCaptions(list, maxWords) {
  const groups = [];
  let cur = [];
  list.forEach((w, i) => {
    cur.push(w);
    const next = list[i + 1];
    const pause = next ? next.start - w.end : Infinity;
    if (cur.length >= maxWords || /[.!?,]$/.test(w.text) || pause > 0.45 || w.end - cur[0].start > 2.5) {
      groups.push(cur);
      cur = [];
    }
  });
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => {
    const start = g[0].start;
    const nextStart = groups[i + 1]?.[0].start ?? Infinity;
    // Hold each card slightly past its last word, but never over the next one.
    const end = Math.min(g.at(-1).end + 0.3, nextStart, duration);
    return { start, end: Math.max(end, start + 0.2), words: g };
  });
}

function composition({ width, height, duration, captions }) {
  const unit = Math.min(width, height) / 1080;
  const px = (n) => `${Math.round(n * unit)}px`;
  const portrait = height > width;
  const f = (n) => n.toFixed(3);

  const cards = captions.map((c, i) => `
      <div id="cap${i}" class="clip caption" data-start="${f(c.start)}" data-duration="${f(c.end - c.start)}" data-track-index="2">
        <div class="line">${c.words.map((w, j) => `<span id="w${i}_${j}" class="word">${esc(w.text)}</span>`).join(" ")}</div>
      </div>`).join("");

  const anim = captions.map((c, i) => [
    `tl.from("#cap${i} .line", { scale: 0.85, opacity: 0, duration: 0.12, ease: "back.out(2)" }, ${f(c.start)});`,
    ...c.words.map((w, j) =>
      `tl.to("#w${i}_${j}", { color: HL, scale: 1.08, duration: 0.08 }, ${f(w.start)});` +
      `tl.to("#w${i}_${j}", { color: FG, scale: 1, duration: 0.08 }, ${f(Math.max(w.end, w.start + 0.1))});`),
  ].join("\n      ")).join("\n      ");

  const titleDur = Math.min(3.5, duration);
  const title = opts.title ? `
      <div id="title" class="clip" data-start="0" data-duration="${f(titleDur)}" data-track-index="1">
        <div class="title-card">
          <div class="title-bar"></div>
          <div class="title-text">${esc(opts.title)}</div>
          ${opts.subtitle ? `<div class="title-sub">${esc(opts.subtitle)}</div>` : ""}
        </div>
      </div>` : "";
  const titleAnim = opts.title ? `
      tl.from("#title .title-bar", { scaleX: 0, transformOrigin: "left", duration: 0.4, ease: "power3.out" }, 0.1);
      tl.from("#title .title-text", { y: ${Math.round(40 * unit)}, opacity: 0, duration: 0.5, ease: "power3.out" }, 0.25);
      tl.from("#title .title-sub", { y: ${Math.round(30 * unit)}, opacity: 0, duration: 0.5, ease: "power3.out" }, 0.4);
      tl.to("#title .title-card", { opacity: 0, y: ${Math.round(-30 * unit)}, duration: 0.4, ease: "power2.in" }, ${f(titleDur - 0.45)});` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
      body { font-family: "Montserrat", "Inter", "Arial Black", "Helvetica Neue", Arial, sans-serif; }
      .caption {
        position: absolute; left: 0; right: 0; bottom: ${portrait ? "26%" : "9%"};
        display: flex; justify-content: center; padding: 0 ${px(60)}; z-index: 3;
      }
      .line {
        max-width: ${px(portrait ? 960 : 1500)}; text-align: center; line-height: 1.15;
        font-size: ${px(portrait ? 84 : 72)}; font-weight: 900; text-transform: uppercase;
        color: ${opts["caption-color"]}; letter-spacing: 0.01em;
        -webkit-text-stroke: ${px(6)} #000; paint-order: stroke fill;
        text-shadow: 0 ${px(6)} ${px(18)} rgba(0, 0, 0, 0.55);
      }
      .word { display: inline-block; }
      .title-card { position: absolute; left: ${px(70)}; top: ${portrait ? "11%" : "9%"}; max-width: 80%; z-index: 2; }
      .title-bar { width: ${px(140)}; height: ${px(14)}; background: ${opts["highlight-color"]}; border-radius: ${px(7)}; margin-bottom: ${px(24)}; }
      .title-text {
        font-size: ${px(portrait ? 96 : 84)}; font-weight: 900; color: #fff; line-height: 1.05;
        text-shadow: 0 ${px(6)} ${px(24)} rgba(0, 0, 0, 0.6);
      }
      .title-sub { margin-top: ${px(18)}; font-size: ${px(44)}; font-weight: 700; color: rgba(255, 255, 255, 0.9); text-shadow: 0 ${px(4)} ${px(16)} rgba(0, 0, 0, 0.6); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${f(duration)}" data-width="${width}" data-height="${height}">
      <video id="a-roll" class="clip" src="cut.mp4" playsinline data-start="0" data-duration="${f(duration)}" data-track-index="0" data-has-audio="true"
        style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover"></video>
${title}
${cards}
    </div>
    <script>
      const FG = ${JSON.stringify(opts["caption-color"])};
      const HL = ${JSON.stringify(opts["highlight-color"])};
      const tl = gsap.timeline({ paused: true });
      ${titleAnim}
      ${anim}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

function writeSrt(path, caps) {
  const ts = (s) => {
    const ms = Math.round(s * 1000);
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  writeFileSync(path, caps.map((c, i) =>
    `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.words.map((w) => w.text).join(" ")}\n`).join("\n"));
}

function probe(file) {
  const json = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height:stream_side_data=rotation:format=duration", "-of", "json", file], true));
  let { width, height } = json.streams[0];
  // Phone footage is often stored landscape with a rotation tag.
  const rot = Math.abs(Number(json.streams[0].side_data_list?.[0]?.rotation ?? 0));
  if (rot === 90 || rot === 270) [width, height] = [height, width];
  return { width, height, duration: Number(json.format.duration) };
}

function run(cmd, args, capture = false) {
  try {
    return execFileSync(cmd, args, { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  } catch (e) {
    fail(e.code === "ENOENT" ? `${cmd} is not installed (see README.md).` : `${cmd} failed (exit ${e.status}).`);
  }
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function step(msg) {
  console.log(`\n▶ ${msg}`);
}

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}
