/** Conversions between raw PCM and the Float32Array sherpa-onnx expects. */

/** Converts 16-bit PCM to normalised float samples. */
export function toFloat32(pcm: Buffer): Float32Array {
  const count = Math.floor(pcm.length / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2) / 32_768;
  }
  return samples;
}
