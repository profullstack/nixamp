/**
 * The analyser: real audio in, spectrum bands out.
 *
 * An iterative radix-2 Cooley-Tukey FFT, which is enough for a visualiser and
 * small enough to read. No dependency, because pulling a DSP library in for
 * one transform would be the largest thing in the tree.
 */

/** Bit-reversal permutation table for a transform of size n (a power of two). */
function reversalTable(n: number): Uint32Array {
  const bits = Math.log2(n);
  const table = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let reversed = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) reversed |= 1 << (bits - 1 - b);
    table[i] = reversed;
  }
  return table;
}

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * A Hann window, precomputed.
 *
 * Without one, a tone that does not complete a whole number of cycles in the
 * frame leaks across every bin and the display turns to mush.
 */
export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export class Analyser {
  readonly size: number;
  readonly sampleRate: number;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly rev: Uint32Array;
  private readonly window: Float32Array;
  /** Magnitudes for bins 0..size/2, reused between frames. */
  readonly magnitudes: Float32Array;

  constructor(size = 2048, sampleRate = 44100) {
    if (!isPowerOfTwo(size)) throw new Error(`FFT size must be a power of two, got ${size}`);
    this.size = size;
    this.sampleRate = sampleRate;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.rev = reversalTable(size);
    this.window = hann(size);
    this.magnitudes = new Float32Array(size / 2 + 1);
  }

  /** Frequency at the centre of a bin. */
  frequencyOf(bin: number): number {
    return (bin * this.sampleRate) / this.size;
  }

  /**
   * Transform one frame of mono samples. Shorter input is zero padded; longer
   * is truncated, so a partial final frame still draws rather than throwing.
   */
  run(samples: Float32Array | number[]): Float32Array {
    const { size, re, im, rev, window } = this;
    for (let i = 0; i < size; i++) {
      const s = (samples[rev[i] as number] as number | undefined) ?? 0;
      re[i] = s * (window[rev[i] as number] as number);
      im[i] = 0;
    }

    for (let len = 2; len <= size; len <<= 1) {
      const step = (-2 * Math.PI) / len;
      const half = len >> 1;
      for (let i = 0; i < size; i += len) {
        for (let j = 0; j < half; j++) {
          const angle = step * j;
          const wr = Math.cos(angle);
          const wi = Math.sin(angle);
          const a = i + j;
          const b = a + half;
          const tr = (re[b] as number) * wr - (im[b] as number) * wi;
          const ti = (re[b] as number) * wi + (im[b] as number) * wr;
          re[b] = (re[a] as number) - tr;
          im[b] = (im[a] as number) - ti;
          re[a] = (re[a] as number) + tr;
          im[a] = (im[a] as number) + ti;
        }
      }
    }

    const half = size / 2;
    // 2/size normalises a full-scale sine to 1.0 in its bin; DC and Nyquist
    // appear once rather than twice, so they are not doubled.
    for (let k = 0; k <= half; k++) {
      const scale = k === 0 || k === half ? 1 / size : 2 / size;
      this.magnitudes[k] = Math.hypot(re[k] as number, im[k] as number) * scale;
    }
    return this.magnitudes;
  }

  /** The loudest bin, ignoring DC. Useful for tests and for a tuner readout. */
  peakBin(): number {
    let best = 1;
    for (let k = 2; k < this.magnitudes.length; k++) {
      if ((this.magnitudes[k] as number) > (this.magnitudes[best] as number)) best = k;
    }
    return best;
  }
}

/**
 * Edges of `count` logarithmically spaced bands between two frequencies.
 *
 * Linear bins would put nearly every bar above 10 kHz, where there is little to
 * see; hearing is roughly logarithmic and the display should match it.
 */
export function bandEdges(count: number, sampleRate: number, size: number, low = 40, high = 16000): number[] {
  const nyquist = sampleRate / 2;
  const top = Math.min(high, nyquist);
  const edges: number[] = [];
  for (let i = 0; i <= count; i++) {
    const hz = low * (top / low) ** (i / count);
    edges.push(Math.min(size / 2, Math.max(1, Math.round((hz * size) / sampleRate))));
  }
  return edges;
}

/** Peak magnitude in each band, in decibels, normalised to 0..1. */
export function bands(
  magnitudes: Float32Array,
  edges: number[],
  floorDb = -70,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i] as number;
    const hi = Math.max(lo + 1, edges[i + 1] as number);
    let peak = 0;
    for (let k = lo; k < hi && k < magnitudes.length; k++) {
      const m = magnitudes[k] as number;
      if (m > peak) peak = m;
    }
    const db = 20 * Math.log10(Math.max(peak, 1e-9));
    out.push(Math.max(0, Math.min(1, (db - floorDb) / -floorDb)));
  }
  return out;
}

/**
 * Bars fall smoothly and rise instantly.
 *
 * A spectrum drawn straight from each frame flickers badly at 30fps. Winamp's
 * analyser rose immediately and decayed, which is both prettier and easier to
 * read; this is that, as one pass over the previous frame.
 */
export function decay(previous: number[], next: number[], fall = 0.12): number[] {
  return next.map((value, i) => {
    const was = previous[i] ?? 0;
    return value >= was ? value : Math.max(value, was - fall);
  });
}
