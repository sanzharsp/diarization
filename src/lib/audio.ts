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
