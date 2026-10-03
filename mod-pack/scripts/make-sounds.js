// Generates assets/thunder.wav: mono, 16-bit, 22050 Hz, about 1.5 s.
// Low-passed noise with exponential decay, plus a low rumble, peak at -6 dBFS.
// Run from the repo root:  node scripts/make-sounds.js
// The noise uses a fixed seed, so each run writes the same file.

const fs = require('fs')
const path = require('path')

const RATE = 22050
const SECONDS = 1.5
const N = Math.floor(RATE * SECONDS)
const PEAK = Math.pow(10, -6 / 20) // -6 dBFS

let seed = 0x2f6e2b1
const noise = () => {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
}

// One-pole low-pass filter, applied in series.
const lowpass = (cutoffHz, input) => {
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / RATE)
  let y = 0
  return input.map(x => (y += a * (x - y)))
}

const raw = Array.from({ length: N }, noise)
const rumbleNoise = lowpass(300, lowpass(300, lowpass(300, raw)))
const crack = lowpass(900, lowpass(900, raw))

const out = new Float64Array(N)
for (let i = 0; i < N; i++) {
  const t = i / RATE
  const attack = Math.min(1, t / 0.008)
  const decay = Math.exp(-t / 0.4)
  // Noise body: low-passed noise under an exponential decay.
  const body = rumbleNoise[i] * 6 * attack * decay
  // Two later, quieter bursts, like the tail of a thunderclap.
  const burst =
    crack[i] * 2 * (Math.exp(-Math.max(0, t - 0.25) / 0.12) * (t > 0.25 ? 1 : 0) * 0.5 +
      Math.exp(-Math.max(0, t - 0.6) / 0.15) * (t > 0.6 ? 1 : 0) * 0.35)
  // Low rumble: two detuned sines with a slow decay and a slow wobble.
  const wobble = 1 + 0.25 * Math.sin(2 * Math.PI * 7 * t)
  const rumble =
    (Math.sin(2 * Math.PI * 48 * t) + 0.7 * Math.sin(2 * Math.PI * 63 * t + 1)) * 0.35 * wobble * attack * Math.exp(-t / 0.75)
  out[i] = body + burst + rumble
}

// 40 ms fade out so the file ends without a click.
const fade = Math.floor(RATE * 0.04)
for (let i = 0; i < fade; i++) out[N - 1 - i] *= i / fade

let max = 0
for (const v of out) max = Math.max(max, Math.abs(v))
const scale = PEAK / max

const pcm = Buffer.alloc(N * 2)
for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.round(out[i] * scale * 32767), i * 2)

const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + pcm.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20) // PCM
header.writeUInt16LE(1, 22) // mono
header.writeUInt32LE(RATE, 24)
header.writeUInt32LE(RATE * 2, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(pcm.length, 40)

const file = path.join(__dirname, '..', 'assets', 'thunder.wav')
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, Buffer.concat([header, pcm]))
console.log(`wrote ${file} (${header.length + pcm.length} bytes, ${SECONDS}s, ${RATE} Hz mono 16-bit)`)
