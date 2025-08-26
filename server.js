/* eslint-disable no-console */
const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

app.use(express.json());

// temp upload dir (multer will create files here)
const upload = multer({ dest: 'uploads/' });

/** Clamp & parse numeric field. Returns def if NaN/invalid. */
function num(value, def, min, max) {
  const v = Number(value);
  if (!Number.isFinite(v)) return def;
  return Math.min(Math.max(v, min), max);
}

/** Label for filename based on average beat Hz. */
function bandLabel(beatHz) {
  if (beatHz >= 12 && beatHz <= 20) return 'Beta';
  if (beatHz >= 8 && beatHz < 12) return 'Alpha';
  if (beatHz >= 4 && beatHz < 8) return 'Theta';
  if (beatHz < 4) return 'Delta';
  return 'Custom';
}

/** Probe audio duration (seconds) using ffprobe. */
function probeDurationSec(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ];
    const p = spawn(FFPROBE, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err || 'ffprobe failed'));
      const sec = parseFloat(out.trim());
      if (!Number.isFinite(sec)) return reject(new Error('No duration'));
      resolve(sec);
    });
    p.on('error', reject);
  });
}

/** Health check */
app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * POST /generate  (multipart/form-data)
 * Fields:
 *  - carrier (Hz)             default 420 (100..1000)
 *  - beatStart (Hz)           default 12 (0..40)
 *  - beatEnd (Hz)             default 14 (0..40)
 *  - durationSec (seconds)    optional; if omitted & music present → auto from music length; else default 1800
 *  - toneGain (0..1)          default 0.25
 *  - musicGain (0..1)         default 0.35
 *  - fadeSec (seconds)        default 3 (0..10)
 *  - filenameHint (string)    optional (alnum, _, -)
 * File:
 *  - music (optional)         user music to loop & mix
 *
 * Response:
 *  - Streams WAV (48k/24-bit) with headers:
 *      Content-Type: audio/wav
 *      Content-Disposition: attachment; filename="..."
 *      X-Beat-Start-Hz, X-Beat-End-Hz, X-Carrier-Hz, X-Duration-Sec,
 *      X-Sample-Rate, X-Bit-Depth, X-Session-Label
 */
app.post('/generate', upload.single('music'), async (req, res) => {
  // ensure uploaded file is cleaned up on any exit path
  const hasMusic = !!req.file;
  const cleanup = () => {
    if (hasMusic && req.file && req.file.path) {
      fs.rm(req.file.path, { force: true }, () => {});
    }
  };

  try {
    // ---- Parse inputs ----
    const carrier     = num(req.body.carrier, 420, 100, 1000);
    const beatStart   = num(req.body.beatStart, 12, 0, 40);
    const beatEnd     = num(req.body.beatEnd, 14, 0, 40);
    // IMPORTANT: default to NaN so we can detect "not provided"
    let durationSec   = num(req.body.durationSec, NaN, 60, 7200);
    const toneGain    = num(req.body.toneGain, 0.25, 0, 1);
    const musicGain   = num(req.body.musicGain, 0.35, 0, 1);
    const fadeSec     = num(req.body.fadeSec, 3, 0, 10);

    // If duration not provided but music uploaded, probe its length
    if (!Number.isFinite(durationSec) && hasMusic) {
      try {
        const probed = await probeDurationSec(req.file.path);
        durationSec = Math.min(Math.max(Math.round(probed), 60), 7200);
      } catch {
        durationSec = 1800; // fallback 30 min
      }
    }
    // If still not set (no music + no duration), default 30 min
    if (!Number.isFinite(durationSec)) durationSec = 1800;

    const sr = 48000; // fixed render sample rate
    const fc = carrier;
    const bs = beatStart;
    const be = beatEnd;
    const dur = durationSec;
    const k = (be - bs) / dur; // Hz/sec slope for linear ramp

    // ---- Tone synthesis (phase-accurate) ----
    // Left channel:  sin(2*pi*fc*t)
    // Right channel: sin(2*pi*((fc + bs)*t + 0.5*k*t^2))
    const leftExpr  = `${toneGain}*sin(2*PI*${fc}*t)`;
    const rightExpr = `${toneGain}*sin(2*PI*((${fc}+${bs})*t + 0.5*${k}*t*t))`;
    const toneGen   = `aevalsrc=exprs=${leftExpr}\\|${rightExpr}:s=${sr}:d=${dur}`;

    // Tone processing: reset PTS, fade in/out to avoid clicks
    const toneFilters = [
      'asetpts=N/SR/TB',
      `afade=t=in:st=0:d=${fadeSec}`,
      `afade=t=out:st=${Math.max(0, dur - fadeSec)}:d=${fadeSec}`
    ].join(',');

    // Music processing: loop indefinitely, resample to 48k, reset PTS, trim to exact dur, apply gain
    const musicFilters = [
      `aresample=${sr}:ocl=stereo`,
      `asetpts=N/SR/TB`,
      `atrim=0:${dur}`,
      `volume=${musicGain}`
    ].join(',');

    // ---- Filename & headers ----
    const avgBeat = (bs + be) / 2;
    const label   = bandLabel(avgBeat);
    const prettyBeat = (bs === be)
      ? `${be.toFixed(2)}Hz`
      : `${bs.toFixed(2)}-${be.toFixed(2)}Hz`;
    const hint = (req.body.filenameHint || label)
      .toString()
      .replace(/[^\w\-]+/g, '')
      .slice(0, 40) || label;
    const filename = `${hint}_${prettyBeat.replace(/\./g, 'p')}_${Math.round(dur/60)}min_${uuidv4()}.wav`;

    // Metadata headers + attachment
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Beat-Start-Hz', String(bs));
    res.setHeader('X-Beat-End-Hz', String(be));
    res.setHeader('X-Carrier-Hz', String(fc));
    res.setHeader('X-Duration-Sec', String(dur));
    res.setHeader('X-Sample-Rate', String(sr));
    res.setHeader('X-Bit-Depth', '24');
    res.setHeader('X-Session-Label', label);

    // ---- Build ffmpeg args ----
    const args = ['-hide_banner', '-loglevel', 'error'];

    if (hasMusic) {
      // Loop the music at demux level; safer for long sessions than aloop
      args.push('-stream_loop', '-1', '-i', req.file.path);
    }

    // Tones input via lavfi
    args.push('-f', 'lavfi', '-i', toneGen);

    // Build filter graph
    // Inputs:
    //   if music: [0:a] = music, [1:a] = tones
    //   else:     [0:a] = tones
    let filterComplex = '';
    if (hasMusic) {
      filterComplex += `[0:a]${musicFilters}[m];`;
      filterComplex += `[1:a]${toneFilters}[t];`;
      filterComplex += `[m][t]amix=inputs=2:normalize=0:dropout_transition=0[mix];`;
      filterComplex += `[mix]alimiter=limit=0.95[out]`;
    } else {
      filterComplex += `[0:a]${toneFilters}[t];`;
      filterComplex += `[t]alimiter=limit=0.95[out]`;
    }

    args.push('-filter_complex', filterComplex);
    args.push('-map', '[out]');
    args.push('-ar', String(sr), '-ac', '2', '-c:a', 'pcm_s24le'); // 48k / 24-bit WAV
    args.push('-f', 'wav', 'pipe:1'); // stream to stdout

    // ---- Spawn ffmpeg and stream ----
    const ff = spawn(FFMPEG, args, { windowsHide: true });

    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });

    // Kill ffmpeg if client disconnects
    const abort = () => {
      try { ff.kill('SIGKILL'); } catch (_) {}
      cleanup();
    };
    res.on('close', abort);
    res.on('error', abort);

    // Pipe audio to client
    ff.stdout.pipe(res);

    ff.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Render failed', details: stderr });
        }
      }
    });

    ff.on('error', (err) => {
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({ error: 'FFmpeg spawn failed', details: String(err) });
      }
    });
  } catch (err) {
    cleanup();
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Binaural renderer listening on http://localhost:${PORT}`);
  console.log('Ensure ffmpeg & ffprobe are installed (or set FFMPEG_PATH / FFPROBE_PATH).');
});
