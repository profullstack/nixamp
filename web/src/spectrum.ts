/**
 * The analyser, browser side.
 *
 * The terminal app runs its own FFT over the samples on their way to the
 * speakers; in a browser the AnalyserNode has already done that, so the work
 * left is the part that makes the picture readable: logarithmic bands, because
 * hearing is logarithmic, and a fall that decays with a peak that sinks —
 * the detail that made Winamp's analyser readable rather than merely busy.
 */

/** Fall per frame, and how fast a held peak sinks. */
export const FALL = 0.14;
export const PEAK_FALL = 0.02;

/**
 * Bin indexes splitting `binCount` FFT bins into `count` logarithmic bands.
 * Returns count + 1 edges, each at least one bin wider than the last so no
 * band comes out empty at the bottom where the bins are dense.
 */
export function bandEdges(count: number, binCount: number): number[] {
  const edges: number[] = [];
  const lowest = 1;
  for (let i = 0; i <= count; i++) {
    const ratio = i / count;
    const bin = Math.round(lowest * Math.pow(binCount / lowest, ratio));
    const previous = edges[edges.length - 1];
    edges.push(previous === undefined ? bin : Math.max(bin, previous + 1));
  }
  return edges;
}

/**
 * Byte frequency data (0..255, already in decibels) averaged into the bands.
 * The result is 0..1 per band.
 */
export function bands(data: Uint8Array, edges: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const start = Math.min(edges[i] as number, data.length);
    const end = Math.min(Math.max(edges[i + 1] as number, start + 1), data.length);
    let sum = 0;
    let n = 0;
    for (let bin = start; bin < end; bin++) {
      sum += data[bin] as number;
      n++;
    }
    out.push(n === 0 ? 0 : sum / n / 255);
  }
  return out;
}

/** Bars rise instantly and fall gradually. */
export function decay(previous: number[], next: number[], fall = FALL): number[] {
  return next.map((value, i) => {
    const was = previous[i] ?? 0;
    return value >= was ? value : Math.max(value, was - fall);
  });
}

/** A peak marker that sinks. */
export function holdPeaks(previous: number[], bars: number[], fall = PEAK_FALL): number[] {
  return bars.map((value, i) => Math.max(value, (previous[i] ?? 0) - fall));
}

export interface SpectrumTheme {
  bar: string;
  peak: string;
  background: string;
}

/**
 * Draw the bars. Kept free of the DOM beyond the 2D context so the layout
 * maths can be reasoned about — and so a canvas of zero width, which happens
 * for one frame while the panel is laid out, draws nothing instead of throwing.
 */
export function drawSpectrum(
  context: CanvasRenderingContext2D,
  size: { width: number; height: number },
  bars: number[],
  peaks: number[],
  theme: SpectrumTheme,
): void {
  const { width, height } = size;
  if (width <= 0 || height <= 0 || bars.length === 0) return;
  context.clearRect(0, 0, width, height);
  const slot = width / bars.length;
  const bar = Math.max(1, slot * 0.72);
  const peakHeight = Math.max(2, height * 0.012);

  context.fillStyle = theme.bar;
  bars.forEach((value, i) => {
    const barHeight = Math.max(1, value * (height - peakHeight * 2));
    context.fillRect(i * slot + (slot - bar) / 2, height - barHeight, bar, barHeight);
  });

  context.fillStyle = theme.peak;
  peaks.forEach((value, i) => {
    const y = height - Math.max(1, value * (height - peakHeight * 2)) - peakHeight * 2;
    context.fillRect(i * slot + (slot - bar) / 2, Math.max(0, y), bar, peakHeight);
  });
}
