# binaural-server

Backend service that renders binaural beats (stereo tones) with an optional looping music bed, and streams a 48kHz/24‑bit WAV to the client.

It auto-detects bundled static binaries for ffmpeg/ffprobe and falls back to env vars or your system PATH.

## Features
- Generate stereo binaural tones with linear beat ramp (start→end Hz).
- Optionally loop and mix an uploaded music track with adjustable gain.
- Fade in/out to avoid clicks; limiter on the final mix.
- Streams WAV over HTTP with descriptive response headers and filename.

## Requirements
- Node.js 18+ recommended.
- ffmpeg/ffprobe not strictly required system-wide: the app prefers bundled binaries from `ffmpeg-static` and `ffprobe-static`.

## Install
- Install dependencies: `npm install`

## Run
- Dev: `npm run dev`
- Prod: `npm start`

On startup you’ll see which binaries are used, for example:
- Using ffmpeg: `node_modules/ffmpeg-static/ffmpeg`
- Using ffprobe: `node_modules/ffprobe-static/bin/<platform>/<arch>/ffprobe`

Set custom paths if needed:
- macOS/Linux example: `FFMPEG_PATH=...</ffmpeg> FFPROBE_PATH=...</ffprobe> PORT=3002 npm start`

## Configuration
- `PORT`: HTTP port (default `3002`).
- `FFMPEG_PATH`: Path to ffmpeg executable (optional).
- `FFPROBE_PATH`: Path to ffprobe executable (optional).

If not provided, the service attempts:
1) Bundled binaries (`ffmpeg-static`, `ffprobe-static`), then
2) The environment variables above, then
3) `ffmpeg`/`ffprobe` on your system `PATH`.

## API

### Health
- `GET /health` → `{ ok: true }`

### Generate
- `POST /generate` (multipart/form-data)
  - File (optional): `music` → audio file to loop/mix.
  - Fields (all optional unless noted):
    - `carrier` (Hz): Tone carrier frequency. Default 420, range 100..1000.
    - `beatStart` (Hz): Starting beat frequency. Default 12, range 0..40.
    - `beatEnd` (Hz): Ending beat frequency. Default 14, range 0..40.
    - `durationSec` (s): Total render length. If omitted and `music` present, auto‑probed from music length; otherwise default 1800. Clamped 60..7200.
    - `toneGain` (0..1): Gain for tones. Default 0.25.
    - `musicGain` (0..1): Gain for music bed. Default 0.35.
    - `fadeSec` (s): Fade in/out length. Default 3, range 0..10.
    - `filenameHint` (string): Alnum/underscore/hyphen only; used in the download filename.

Response
- Body: WAV stream (PCM 24‑bit, 48kHz, stereo).
- Headers:
  - `Content-Type: audio/wav`
  - `Content-Disposition: attachment; filename="..."`
  - `X-Beat-Start-Hz`, `X-Beat-End-Hz`, `X-Carrier-Hz`, `X-Duration-Sec`, `X-Sample-Rate`, `X-Bit-Depth`, `X-Session-Label`

Notes on synthesis/mix
- Tones are generated via `aevalsrc` with phase‑accurate right‑channel beat ramp.
- Music is demux‑looped (`-stream_loop -1`), resampled to 48k stereo, trimmed to exact duration, then gain‑adjusted.
- Final mix uses `amix` (no auto normalization) and an `alimiter` at 0.95.

## Examples

No music bed (tones only):

```
curl -X POST \
  -F carrier=420 -F beatStart=8 -F beatEnd=12 -F durationSec=600 \
  http://localhost:3002/generate --output session.wav
```

With music bed (loops as needed):

```
curl -X POST \
  -F music=@/path/to/music.mp3 \
  -F musicGain=0.35 -F toneGain=0.25 \
  -F beatStart=6 -F beatEnd=10 -F durationSec=1800 \
  http://localhost:3002/generate --output session_with_music.wav
```

Let duration auto‑match music length:

```
curl -X POST -F music=@/path/to/music.wav http://localhost:3002/generate --output full_length.wav
```

## Troubleshooting
- ENOENT / spawn errors: ensure the resolved ffmpeg/ffprobe paths exist and are executable. You can override with `FFMPEG_PATH`/`FFPROBE_PATH`.
- Very long renders: `durationSec` is clamped to 2 hours (7200s). For longer sessions, render in parts.
- Client disconnects: the server aborts ffmpeg and cleans up temporary uploads.
- Reverse proxy/timeouts: since audio streams over HTTP, make sure proxies allow long‑lived responses.

## Development
- Main entry: `server.js`
- Uploads: temporary files stored under `uploads/` by Multer; cleaned after each request.



## SAMPLE

curl -X POST -F music=@soft.mp3 -F musicGain=1 -F toneGain=0.1 -F carrier=400 -F beatStart=8 -F beatEnd=8 -F fadeSec=3 -F durationSec=1800 -F filenameHint=AlphaFixed http://localhost:3002/generate -o full_length.wav





consider 432hz for the carrier



What to set: Use a linear ramp from 14 → 18 Hz across your chosen duration by setting beatStart=14 and beatEnd=18. That creates a gentle, constant ramp for the whole session.

Recommended settings:

carrier=420 (comfortable base tone)
beatStart=14, beatEnd=18 (beta ramp)
durationSec=1800 (30 min, adjust as you like)
toneGain=0.25, musicGain=0.35 (tweak to taste)
fadeSec=5 (slightly gentler edges)
Sample commands

With your music file (root of repo):

curl -X POST -F "music=@soft-calm-piano-solo-music-398662.mp3" -F "carrier=420" -F "beatStart=14" -F "beatEnd=18" -F "durationSec=1800" -F "toneGain=0.25" -F "musicGain=0.35" -F "fadeSec=5" -F "filenameHint=BetaFocus" http://localhost:3002/generate -o beta_14to18_mix.wav
Tones only:

curl -X POST -F "carrier=420" -F "beatStart=14" -F "beatEnd=18" -F "durationSec=1800" -F "toneGain=0.25" -F "fadeSec=5" -F "filenameHint=BetaFocus" http://localhost:3002/generate -o beta_14to18.wav
Optional two-stage ramp (even gentler: 14→16 then 16→18)

Part 1 (15 min): curl -X POST -F "carrier=420" -F "beatStart=14" -F "beatEnd=16" -F "durationSec=900" -F "toneGain=0.25" -F "fadeSec=5" http://localhost:3002/generate -o part1.wav
Part 2 (15 min): curl -X POST -F "carrier=420" -F "beatStart=16" -F "beatEnd=18" -F "durationSec=900" -F "toneGain=0.25" -F "fadeSec=5" http://localhost:3002/generate -o part2.wav
Join with ffmpeg: printf "file 'part1.wav'\nfile 'part2.wav'\n" > list.txt && ffmpeg -f concat -safe 0 -i list.txt -c copy beta_14to18_2stage.wav



curl -X POST -F music=@soft.mp3 -F musicGain=1 -F toneGain=0.1 -F carrier=420 -F beatStart=14 -F beatEnd=18 -F fadeSec=3 -F durationSec=1800 -F filenameHint=AlphaFixed http://localhost:3002/generate -o piano-calm-beta.wav