# Taglish video pipeline

One command turns a raw clip into a captioned, mixed video:

| Step | Tool | What it does |
|---|---|---|
| 1 | **FFmpeg** | Cuts the clip (`--start` / `--end`) and re-encodes it to clean H.264 |
| 2 | **Groq** | Transcribes the speech with Whisper large-v3, with word timings. A prompt keeps Taglish (Tagalog + English) as spoken instead of translating it |
| 3–4 | **HyperFrames** | Builds an HTML composition (title card + word-by-word highlighted captions) and renders it to MP4 |
| 5 | **FFmpeg** | Mixes background music under the voice (ducked automatically while someone talks) and normalizes loudness to -14 LUFS for TikTok, Reels and YouTube |

## Setup (once)

1. Install **FFmpeg**: `brew install ffmpeg` (Mac), `winget install ffmpeg` (Windows), `sudo apt install ffmpeg` (Linux)
2. Install **Node.js 22+** from https://nodejs.org
3. In this folder, run:
   ```
   npm install
   ```
   This installs HyperFrames and GSAP (the animation library) locally.
4. Get a free **Groq** API key at https://console.groq.com/keys and set it:
   ```
   export GROQ_API_KEY=gsk_...          # Mac/Linux
   setx GROQ_API_KEY gsk_...            # Windows (then reopen the terminal)
   ```

## Usage

```
node make-video.mjs my-vlog.mp4 --title "Bagong Recipe!" --subtitle "Episode 12" --music bgm.mp3
```

Output: `my-vlog-final.mp4`. The `work/my-vlog/` folder also gets `transcript.json`, a `.srt` subtitle file, and the editable HyperFrames project in `captions/`. To tweak it by hand, run `npx hyperframes preview` inside that folder.

### Options

| Option | Default | Meaning |
|---|---|---|
| `-o, --out <file>` | `<name>-final.mp4` | Output path |
| `--start <time>` / `--end <time>` | whole clip | Cut points, e.g. `--start 0:05 --end 1:30` |
| `--title <text>` | none | Animated title card for the first 3.5 s |
| `--subtitle <text>` | none | Smaller line under the title |
| `--music <file>` | none | Background music, looped and ducked under the voice |
| `--music-volume <0-1>` | `0.18` | Music level before ducking |
| `--language <code>` | auto | Force a language, e.g. `tl`. Auto-detect usually handles Taglish best |
| `--model <name>` | `whisper-large-v3` | Groq model. `whisper-large-v3-turbo` is faster and cheaper but less accurate on Tagalog |
| `--prompt <text>` | Taglish sample | Context for Whisper: put names, slang, or brand spellings here |
| `--transcript <file>` | none | Reuse a transcript JSON and skip Groq (e.g. after fixing a word in `transcript.json`) |
| `--words-per-caption <n>` | `4` | Maximum words per caption card |
| `--caption-color <css>` | `#FFFFFF` | Caption text color |
| `--highlight-color <css>` | `#FFD43B` | Color of the word being spoken, and the title accent |
| `--quality <q>` | `delivery` | HyperFrames render quality: `draft`, `looks`, `delivery` |
| `--work-dir <dir>` | `work/<name>` | Where intermediate files go |

### Fixing a misheard word

1. Edit the word in `work/<name>/transcript.json` (inside the `words` list).
2. Re-run with `--transcript work/<name>/transcript.json`. Groq is skipped, so it costs nothing.

### Limits

- Groq's free tier accepts audio up to 25 MB. The pipeline compresses audio to about 14 MB per hour, so roughly 1.5 hours fits.
- Captions are sized for vertical (9:16) and horizontal (16:9) video automatically.
