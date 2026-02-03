export const decodeAudioFile = async (file: File) => {
  const arrayBuffer = await file.arrayBuffer();
  const context = new AudioContext();
  const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
  await context.close();
  return audioBuffer;
};

export const createAudioBufferFromMono = async (
  pcm: Float32Array,
  sampleRate: number
) => {
  const context = new AudioContext({ sampleRate });
  const buffer = context.createBuffer(1, pcm.length, sampleRate);
  buffer.copyToChannel(pcm, 0);
  await context.close();
  return buffer;
};

export const getMonoSlice = (buffer: AudioBuffer, startSec: number, endSec: number) => {
  const start = Math.max(0, Math.floor(startSec * buffer.sampleRate));
  const end = Math.min(buffer.length, Math.ceil(endSec * buffer.sampleRate));
  const length = Math.max(0, end - start);
  const output = new Float32Array(length);
  const channels = buffer.numberOfChannels;

  for (let ch = 0; ch < channels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      output[i] += data[start + i] ?? 0;
    }
  }

  if (channels > 1) {
    for (let i = 0; i < length; i += 1) {
      output[i] /= channels;
    }
  }

  return output;
};

export const resampleLinear = (
  input: Float32Array,
  inputRate: number,
  outputRate: number
) => {
  if (!input.length || inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[idx + 1] ?? s0;
    output[i] = s0 + (s1 - s0) * frac;
  }

  return output;
};

export const normalizePcm = (
  input: Float32Array,
  targetPeak: number = 0.98,
  minPeak: number = 1e-3
) => {
  if (!input.length) return input;
  let mean = 0;
  for (let i = 0; i < input.length; i += 1) {
    mean += input[i];
  }
  mean /= input.length;

  let peak = 0;
  for (let i = 0; i < input.length; i += 1) {
    const v = input[i] - mean;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }

  const gain = peak > minPeak ? targetPeak / peak : 1;
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    let v = (input[i] - mean) * gain;
    if (v > 1) v = 1;
    if (v < -1) v = -1;
    output[i] = v;
  }

  return output;
};
