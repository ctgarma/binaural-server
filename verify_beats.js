/* eslint-disable no-console */
const fs = require('fs');
const wav = require('wav');
const { fft, util } = require('fft-js');

// Convert a concatenated PCM buffer to deinterleaved Float32 arrays for L/R.
function deinterleaveToFloatStereo(buf, format) {
  const { sampleRate, channels, bitDepth, audioFormat } = format;
  if (channels !== 2) throw new Error('Only stereo WAV is supported');

  // audioFormat: 1 = PCM (int), 3 = IEEE float
  const isFloat = audioFormat === 3;
  const bytesPerSample = isFloat ? (bitDepth / 8 || 4) : (bitDepth / 8);
  const frameSize = bytesPerSample * channels;
  const totalFrames = Math.floor(buf.length / frameSize);

  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);

  const readSample = (offset) => {
    if (isFloat && bytesPerSample === 4) {
      return buf.readFloatLE(offset); // already -1..1
    }
    // Integer PCM
    if (bitDepth === 8) {
      // 8-bit PCM is unsigned
      return (buf.readUInt8(offset) - 128) / 128;
    }
    if (bitDepth === 16) {
      return buf.readInt16LE(offset) / 32768;
    }
    if (bitDepth === 24) {
      // Use readIntLE for proper sign extension
      const v = buf.readIntLE(offset, 3); // range ~ [-8388608, 8388607]
      return v / 8388608;
    }
    if (bitDepth === 32) {
      return buf.readInt32LE(offset) / 2147483648;
    }
    throw new Error(`Unsupported bit depth: ${bitDepth}`);
  };

  for (let i = 0; i < totalFrames; i++) {
    const base = i * frameSize;
    left[i] = readSample(base);
    right[i] = readSample(base + bytesPerSample);
  }

  return { left, right, sampleRate };
}

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

function dominantFreqInBand(samples, sampleRate, bandMin = 100, bandMax = 1000) {
  // Use a power-of-two slice up to 65536 to keep it fast
  const N = Math.min(65536, 1 << Math.floor(Math.log2(samples.length)));
  const window = hannWindow(N);
  const x = new Array(N);
  for (let i = 0; i < N; i++) x[i] = samples[i] * window[i];

  const ph = fft(x);
  const freqs = util.fftFreq(ph, sampleRate);
  const mags = ph.map((c) => Math.hypot(c[0], c[1]));

  // Search only positive frequencies within band
  let peakIdx = 0;
  let peakMag = -Infinity;
  for (let i = 0; i < N / 2; i++) {
    const f = freqs[i];
    if (f >= bandMin && f <= bandMax) {
      const m = mags[i];
      if (m > peakMag) { peakMag = m; peakIdx = i; }
    }
  }
  return Math.abs(freqs[peakIdx] || 0);
}

async function analyzeWavFile(filePath, opts = {}) {
  const {
    seconds = 10, // analyze first N seconds to avoid huge memory use
    bandMin = 100,
    bandMax = 1000,
    minBeat = 1,
    maxBeat = 40,
  } = opts;

  try {
    const file = fs.createReadStream(filePath);
    const reader = new wav.Reader();

    let fmt = null;
    let targetBytes = Infinity;
    const chunks = [];
    let collected = 0;
    let analyzed = false;

    const tryAnalyze = () => {
      if (analyzed || !fmt) return;
      analyzed = true;
      try {
        const buf = Buffer.concat(chunks);
        const { left, right, sampleRate } = deinterleaveToFloatStereo(buf, fmt);

        const leftFreq = dominantFreqInBand(left, sampleRate, bandMin, bandMax);
        const rightFreq = dominantFreqInBand(right, sampleRate, bandMin, bandMax);
        const beatHz = Math.abs(leftFreq - rightFreq);

        const bytesPerSample = (fmt.audioFormat === 3 ? (fmt.bitDepth / 8 || 4) : (fmt.bitDepth / 8));
        const approxSeconds = (buf.length / (fmt.channels * bytesPerSample * fmt.sampleRate)) || seconds;

        console.log('\n--- Binaural Beat Analysis ---');
        console.log(`Analyzed duration: ~${approxSeconds.toFixed(1)} s`);
        console.log(`Dominant Left Frequency (band ${bandMin}-${bandMax} Hz): ${leftFreq.toFixed(2)} Hz`);
        console.log(`Dominant Right Frequency (band ${bandMin}-${bandMax} Hz): ${rightFreq.toFixed(2)} Hz`);
        console.log(`Calculated Beat Frequency: ${beatHz.toFixed(2)} Hz`);

        const isBinaural = beatHz >= minBeat && beatHz <= maxBeat;
        if (isBinaural) {
          console.log(`\n✅ Result: Likely binaural beat (${minBeat}-${maxBeat} Hz).`);
        } else {
          console.log(`\n❌ Result: No clear binaural beat in ${minBeat}-${maxBeat} Hz.`);
        }
      } catch (e) {
        console.error('Analysis error:', e.message || e);
      } finally {
        try { file.destroy(); } catch {}
      }
    };

    reader.on('format', (format) => {
      fmt = format;
      console.log('\n--- WAV File Details ---');
      console.log(`Sample Rate: ${format.sampleRate} Hz`);
      console.log(`Channels: ${format.channels}`);
      console.log(`Bit Depth: ${format.bitDepth} bits`);
      if (format.channels !== 2) {
        console.error('Error: This script only supports stereo WAV files.');
      }
      const bps = (format.audioFormat === 3 ? (format.bitDepth / 8 || 4) : (format.bitDepth / 8));
      targetBytes = Math.ceil(format.sampleRate * seconds) * format.channels * bps;
    });

    reader.on('data', (chunk) => {
      if (analyzed) return;
      const remaining = Math.max(0, targetBytes - collected);
      const slice = remaining && remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      collected += slice.length;
      if (collected >= targetBytes) {
        tryAnalyze();
      }
    });

    reader.on('end', () => {
      if (!analyzed) tryAnalyze();
    });

    file.pipe(reader);
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

// Minimal CLI arg parser to avoid ESM-only yargs
function parseArgs(argv) {
  const out = { seconds: 10, bandMin: 100, bandMax: 1000, minBeat: 1, maxBeat: 40 };
  const it = argv[Symbol.iterator]();
  let cur = it.next();
  while (!cur.done) {
    let a = cur.value;
    if (a.startsWith('--')) {
      const [k, vRaw] = a.split('=', 2);
      const key = k.replace(/^--/, '');
      let v = vRaw;
      if (v === undefined) {
        const n = it.next();
        if (!n.done && !String(n.value).startsWith('-')) v = n.value; else v = 'true';
      }
      out[key] = isNaN(Number(v)) ? v : Number(v);
    } else if (a.startsWith('-')) {
      const key = a.replace(/^-+/, '');
      const n = it.next();
      const v = n.done ? 'true' : n.value;
      if (key === 'f') out.file = v;
      else if (key === 's') out.seconds = Number(v);
      else out[key] = isNaN(Number(v)) ? v : Number(v);
    } else {
      // positional -> treat as file if not set
      if (!out.file) out.file = a;
    }
    cur = it.next();
  }
  return out;
}

function printHelp() {
  console.log('Usage: node verify_beats.js -f <file.wav> [options]');
  console.log('Options:');
  console.log('  -f, --file <path>       WAV file to analyze');
  console.log('  -s, --seconds <n>       Seconds from start to analyze (default 10)');
  console.log('      --bandMin <Hz>      Min frequency for peak search (default 100)');
  console.log('      --bandMax <Hz>      Max frequency for peak search (default 1000)');
  console.log('      --minBeat <Hz>      Min beat frequency to consider (default 1)');
  console.log('      --maxBeat <Hz>      Max beat frequency to consider (default 40)');
}

(async () => {
  const argv = parseArgs(process.argv.slice(2));
  if (!argv.file || argv.help || argv.h) {
    printHelp();
    if (!argv.file) process.exit(1);
  }
  await analyzeWavFile(argv.file, argv);
})();
