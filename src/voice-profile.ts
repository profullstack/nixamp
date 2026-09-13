/** Acoustic matching only: pitch does not establish a speaker's gender or identity. */
export type VoiceProfile = "lower" | "higher" | "unknown";

/** Median fundamental frequency from periodic voiced frames, sampled at 8 kHz.
 * Ambiguous pitch, overlapping voices and unvoiced sound use the selected default.
 * This is deliberately inexpensive and does not load another model beside ASR.
 */
export function voiceProfile(pcm: Buffer): VoiceProfile {
  const pitches: number[] = [];
  const frame = 320;
  const samples = Math.floor(pcm.length / 4);
  for (let start = 0; start + frame < samples; start += 1600) {
    const values = new Float32Array(frame);
    let mean = 0;
    for (let i = 0; i < frame; i++) mean += values[i] = pcm.readInt16LE((start + i) * 4) / 32768;
    mean /= frame;
    let energy = 0;
    for (let i = 0; i < frame; i++) { values[i] = (values[i] as number) - mean; energy += (values[i] as number) ** 2; }
    if (Math.sqrt(energy / frame) < 0.01) continue;
    let best = 0;
    let period = 0;
    // Prefer the first strong peak; a later multiple of the period has the same correlation.
    const correlations: number[] = [];
    for (let lag = 20; lag <= 114; lag++) {
      let cross = 0, left = 0, right = 0;
      for (let i = 0; i < frame - lag; i++) {
        const a = values[i] as number, b = values[i + lag] as number;
        cross += a * b; left += a * a; right += b * b;
      }
      correlations[lag] = cross / Math.sqrt(left * right || 1);
    }
    for (let lag = 21; lag < 114; lag++) {
      const score = correlations[lag] as number;
      if (score > 0.8 && score > (correlations[lag - 1] as number) && score >= (correlations[lag + 1] as number) && score > best + 0.03) {
        best = score; period = lag;
      }
    }
    if (period) pitches.push(8000 / period);
  }
  if (pitches.length < 3) return "unknown";
  pitches.sort((a, b) => a - b);
  const median = pitches[Math.floor(pitches.length / 2)] as number;
  const lower = pitches.filter((pitch) => pitch < 155).length / pitches.length;
  const higher = pitches.filter((pitch) => pitch > 185).length / pitches.length;
  return median < 155 && lower >= 0.75 ? "lower" : median > 185 && higher >= 0.75 ? "higher" : "unknown";
}
