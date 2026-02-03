import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  Button,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Spin,
  Typography,
  Upload,
  message
} from "antd";
import {
  EditOutlined,
  AudioOutlined,
  StopOutlined,
  PauseCircleFilled,
  PlayCircleFilled,
  PlusOutlined,
  UploadOutlined
} from "@ant-design/icons";
import type { AsrDebugSegment, DiarSegment, TranscriptItem, Utterance, WordToken } from "./lib/types";
import {
  buildSpeakerMap,
  buildUtterancesByDiarSegments,
  createSpeakerId,
  extractDiarSegments,
  extractWords,
  formatTime,
  hashHue,
  mergeAdjacentSameSpeaker,
  mergeUtterances
} from "./lib/processing";
import { diarizeAudio, transcribeAudio } from "./lib/api";
import { safeName, saveDebugArtifacts } from "./lib/debug";
import { encodeWav } from "./lib/wav";
import {
  createAudioBufferFromMono,
  decodeAudioFile,
  getMonoSlice
} from "./lib/audio";

const LIVE_DIAR_LABEL = "Live Diarization";
const NAV_ITEMS = [
  "Text to Speech",
  "Agents",
  "Music",
  "Speech to Text",
  LIVE_DIAR_LABEL,
  "Dubbing",
  "Voice Cloning",
  "ElevenReader"
];
const MIC_BARS = Array.from({ length: 7 }, (_, i) => i);
const DEFAULT_STREAM_WS_URL =
  import.meta.env.VITE_DIAR_STREAM_WS_URL ?? "ws://localhost:9001/ws";

const createId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t_${Date.now()}_${Math.random().toString(16).slice(2)}`);

const formatDurationMs = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
};

const STREAM_TARGET_SAMPLE_RATE = 16000;
const STREAM_PROCESSOR_SIZE = 4096;
const STREAM_SEGMENT_LIMIT = 240;
const LIVE_ASR_CHUNK_SEC = 6;
const LIVE_ASR_OVERLAP_SEC = 1;
const LIVE_ASR_WORD_LIMIT = 2000;
const LIVE_UTTERANCE_MERGE_GAP_SEC = 0.6;
const LIVE_ASR_CHUNK_SAMPLES = Math.round(LIVE_ASR_CHUNK_SEC * STREAM_TARGET_SAMPLE_RATE);
const LIVE_ASR_OVERLAP_SAMPLES = Math.round(LIVE_ASR_OVERLAP_SEC * STREAM_TARGET_SAMPLE_RATE);

const ASR_SEGMENT_PADDING_SEC = 1.0;
const ASR_CONCURRENCY = 40;
const ASR_DIAR_MERGE_GAP_SEC = Number.POSITIVE_INFINITY;
const DEBUG_SAVE_ASR_SEGMENTS = import.meta.env.VITE_DEBUG_SAVE_ASR_SEGMENTS === "1";
const UI_UTTERANCE_MERGE_GAP_SEC = Number.POSITIVE_INFINITY;

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (result: R, index: number) => void
) => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const current = nextIndex;
      if (current >= items.length) break;
      nextIndex += 1;
      results[current] = await fn(items[current], current);
      if (onProgress) {
        onProgress(results[current], current);
      }
    }
  });
  await Promise.all(workers);
  return results;
};

const downsampleBuffer = (buffer: Float32Array, sampleRate: number, outRate: number) => {
  if (outRate >= sampleRate) return buffer.slice();
  const ratio = sampleRate / outRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
};

const floatTo16BitPCM = (buffer: Float32Array) => {
  const output = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) {
    const s = Math.max(-1, Math.min(1, buffer[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
};

const normalizeStreamSegments = (segments: any[]): DiarSegment[] => {
  const out: DiarSegment[] = [];
  for (const seg of segments) {
    if (!seg) continue;
    const speaker = seg.speaker ?? seg.spk_id ?? seg.spk ?? seg.speaker_id ?? "unknown";
    const start = seg.start ?? seg.seg_begin ?? seg.begin;
    const end = seg.end ?? seg.seg_end ?? seg.finish;
    if (speaker == null || start == null || end == null) continue;
    const s = Number(start);
    const e = Number(end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    out.push({ speaker: String(speaker), start: s, end: e });
  }
  return out;
};

const mergeStreamSegments = (prev: DiarSegment[], incoming: DiarSegment[]) => {
  if (!incoming.length) return prev;
  const merged = mergeAdjacentSameSpeaker(
    [...prev, ...incoming].sort((a, b) => (a.start - b.start) || (a.end - b.end)),
    0.2
  );
  if (merged.length > STREAM_SEGMENT_LIMIT) {
    return merged.slice(-STREAM_SEGMENT_LIMIT);
  }
  return merged;
};

type RecorderSession = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  analyser: AnalyserNode;
  analyserData: Uint8Array;
  gain: GainNode;
  stream: MediaStream;
  buffers: Float32Array[];
  bufferLength: number;
  sampleRate: number;
  lastLevelAt: number;
};

type StreamSession = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  analyser: AnalyserNode;
  analyserData: Uint8Array;
  gain: GainNode;
  stream: MediaStream;
  ws: WebSocket;
  lastLevelAt: number;
};

const App = () => {
  const [activeNav, setActiveNav] = useState("Speech to Text");
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renameState, setRenameState] = useState<{
    open: boolean;
    speakerId?: string;
    label?: string;
  }>({ open: false });
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [playbackLevel, setPlaybackLevel] = useState(0);
  const [minSpeakers, setMinSpeakers] = useState<number | null>(null);
  const [maxSpeakers, setMaxSpeakers] = useState<number | null>(null);
  const [diarProfile, setDiarProfile] = useState<string | null>("general");
  const [processingNow, setProcessingNow] = useState(() => Date.now());
  const [streamUrl, setStreamUrl] = useState(DEFAULT_STREAM_WS_URL);
  const [streamPreset, setStreamPreset] = useState<"low" | "very_high">("low");
  const [streamStatus, setStreamStatus] = useState<"idle" | "connecting" | "streaming" | "error">("idle");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamSegments, setStreamSegments] = useState<DiarSegment[]>([]);
  const [streamElapsedMs, setStreamElapsedMs] = useState(0);
  const [streamMicLevel, setStreamMicLevel] = useState(0);
  const [streamInfo, setStreamInfo] = useState<Record<string, any> | null>(null);
  const [liveAsrWords, setLiveAsrWords] = useState<WordToken[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<RecorderSession | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const streamWsRef = useRef<WebSocket | null>(null);
  const streamSessionRef = useRef<StreamSession | null>(null);
  const streamTimerRef = useRef<number | null>(null);
  const streamStartedAtRef = useRef<number | null>(null);
  const streamActiveRef = useRef(false);
  const liveAsrBufferRef = useRef<Float32Array[]>([]);
  const liveAsrBufferedSamplesRef = useRef(0);
  const liveAsrPendingRef = useRef(false);
  const liveAsrOffsetSecRef = useRef(0);
  const liveAsrRunIdRef = useRef(0);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveAnimRef = useRef<number | null>(null);
  const playbackRafRef = useRef<number | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null);
  const playbackDataRef = useRef<Uint8Array | null>(null);

  const activeTranscript = transcripts.find((t) => t.id === activeId) ?? transcripts[0];
  const isStreaming = streamStatus === "streaming";

  useEffect(() => {
    if (!activeTranscript || activeTranscript.status !== "processing") return;
    setProcessingNow(Date.now());
    const tick = window.setInterval(() => setProcessingNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [activeTranscript?.id, activeTranscript?.status]);

  useEffect(() => {
    if (activeNav === LIVE_DIAR_LABEL) return;
    if (streamStatus === "idle") return;
    void stopStreaming();
  }, [activeNav, streamStatus]);

  const processingElapsedMs = useMemo(() => {
    if (!activeTranscript?.processingStartedAt) return null;
    if (activeTranscript.status === "processing") {
      return Math.max(0, processingNow - activeTranscript.processingStartedAt);
    }
    if (activeTranscript.processingMs != null) {
      return Math.max(0, activeTranscript.processingMs);
    }
    if (activeTranscript.processingFinishedAt) {
      return Math.max(
        0,
        activeTranscript.processingFinishedAt - activeTranscript.processingStartedAt
      );
    }
    return null;
  }, [activeTranscript, processingNow]);

  const streamSpeakerLabels = useMemo(() => {
    const map: Record<string, string> = {};
    let idx = 1;
    for (const seg of streamSegments) {
      if (!map[seg.speaker]) {
        map[seg.speaker] = `Спикер ${idx}`;
        idx += 1;
      }
    }
    return map;
  }, [streamSegments]);

  const liveAsrUtterances = useMemo(() => {
    if (!liveAsrWords.length || !streamSegments.length) return [];
    return buildUtterancesByDiarSegments(
      liveAsrWords,
      streamSegments,
      LIVE_UTTERANCE_MERGE_GAP_SEC
    );
  }, [liveAsrWords, streamSegments]);

  const speakerIds = useMemo(() => {
    if (!activeTranscript) return [];
    return Array.from(new Set(activeTranscript.utterances.map((u) => u.speaker)));
  }, [activeTranscript]);

  const flatWords = useMemo(() => {
    if (!activeTranscript) return [] as Array<WordToken & { key: string; utteranceIndex: number }>; // type guard
    const out: Array<WordToken & { key: string; utteranceIndex: number }> = [];
    activeTranscript.utterances.forEach((u, uIdx) => {
      u.words.forEach((w, wIdx) => {
        out.push({ ...w, key: `${uIdx}-${wIdx}`, utteranceIndex: uIdx });
      });
    });
    return out.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  }, [activeTranscript]);

  const activeWordKey = useMemo(() => {
    if (!flatWords.length) return null;
    let lo = 0;
    let hi = flatWords.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const w = flatWords[mid];
      if (currentTime < w.start) {
        hi = mid - 1;
      } else if (currentTime > w.end) {
        lo = mid + 1;
      } else {
        return w.key;
      }
    }
    return null;
  }, [currentTime, flatWords]);

  const activeUtteranceIndex = useMemo(() => {
    if (!activeTranscript) return null;
    const idx = activeTranscript.utterances.findIndex(
      (u) => currentTime >= u.start && currentTime <= u.end
    );
    return idx >= 0 ? idx : null;
  }, [activeTranscript, currentTime]);

  const activeSpeakerId = useMemo(() => {
    if (!activeTranscript || activeUtteranceIndex == null) return null;
    return activeTranscript.utterances[activeUtteranceIndex]?.speaker ?? null;
  }, [activeTranscript, activeUtteranceIndex]);

  const setTranscript = (id: string, updater: (prev: TranscriptItem) => TranscriptItem) => {
    setTranscripts((prev) => prev.map((t) => (t.id === id ? updater(t) : t)));
  };

  const resetLiveAsrState = () => {
    liveAsrBufferRef.current = [];
    liveAsrBufferedSamplesRef.current = 0;
    liveAsrPendingRef.current = false;
    liveAsrOffsetSecRef.current = 0;
    setLiveAsrWords([]);
  };

  const consumeLiveAsrSamples = (count: number) => {
    const buffers = liveAsrBufferRef.current;
    const output = new Float32Array(count);
    let offset = 0;
    while (offset < count && buffers.length > 0) {
      const buf = buffers[0];
      const take = Math.min(buf.length, count - offset);
      output.set(buf.subarray(0, take), offset);
      offset += take;
      if (take === buf.length) {
        buffers.shift();
      } else {
        buffers[0] = buf.subarray(take);
      }
    }
    liveAsrBufferedSamplesRef.current = Math.max(0, liveAsrBufferedSamplesRef.current - count);
    return output;
  };

  const takeLiveAsrChunk = () => {
    if (liveAsrBufferedSamplesRef.current < LIVE_ASR_CHUNK_SAMPLES) return null;
    const chunk = consumeLiveAsrSamples(LIVE_ASR_CHUNK_SAMPLES);
    if (LIVE_ASR_OVERLAP_SAMPLES > 0) {
      const overlap = chunk.subarray(chunk.length - LIVE_ASR_OVERLAP_SAMPLES);
      liveAsrBufferRef.current.unshift(overlap);
      liveAsrBufferedSamplesRef.current += overlap.length;
    }
    return chunk;
  };

  const drainLiveAsrBuffer = (runId: number) => {
    if (!streamActiveRef.current) return;
    if (liveAsrPendingRef.current) return;
    const chunk = takeLiveAsrChunk();
    if (!chunk) return;

    liveAsrPendingRef.current = true;
    const chunkStartSec = liveAsrOffsetSecRef.current;
    liveAsrOffsetSecRef.current +=
      (LIVE_ASR_CHUNK_SAMPLES - LIVE_ASR_OVERLAP_SAMPLES) / STREAM_TARGET_SAMPLE_RATE;

    const wavBuffer = encodeWav(chunk, STREAM_TARGET_SAMPLE_RATE);
    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    const segFile = new File([blob], `live_asr_${chunkStartSec.toFixed(2)}.wav`, {
      type: "audio/wav"
    });

    transcribeAudio(segFile)
      .then((asr) => {
        if (liveAsrRunIdRef.current !== runId) return;
        const asrPayload = asr?.asr ?? asr;
        const rawWords = extractWords(asrPayload);
        const relativeDrop = chunkStartSec > 0 ? LIVE_ASR_OVERLAP_SEC : 0;
        const adjusted = rawWords
          .filter((w) => ((w.start + w.end) / 2) >= relativeDrop)
          .map((w) => ({
            ...w,
            start: w.start + chunkStartSec,
            end: w.end + chunkStartSec
          }));

        if (!adjusted.length) return;
        setLiveAsrWords((prev) => {
          const merged = [...prev, ...adjusted].sort(
            (a, b) => (a.start - b.start) || (a.end - b.end)
          );
          if (merged.length > LIVE_ASR_WORD_LIMIT) {
            return merged.slice(-LIVE_ASR_WORD_LIMIT);
          }
          return merged;
        });
      })
      .catch((err: any) => {
        if (liveAsrRunIdRef.current !== runId) return;
        setStreamError((prev) => prev || err?.message || "Ошибка live ASR.");
      })
      .finally(() => {
        if (liveAsrRunIdRef.current !== runId) return;
        liveAsrPendingRef.current = false;
        drainLiveAsrBuffer(runId);
      });
  };

  const buildStreamUrl = () => {
    if (!streamUrl) return "";
    try {
      const url = new URL(streamUrl, window.location.href);
      url.searchParams.set("preset", streamPreset);
      url.searchParams.set("send_segments", "true");
      url.searchParams.set("debug", "false");
      return url.toString();
    } catch {
      return streamUrl;
    }
  };

  const stopStreaming = async (nextStatus: "idle" | "error" = "idle") => {
    streamActiveRef.current = false;
    liveAsrRunIdRef.current += 1;
    resetLiveAsrState();

    const session = streamSessionRef.current;
    if (session) {
      session.processor.disconnect();
      session.source.disconnect();
      session.analyser.disconnect();
      session.gain.disconnect();
      session.stream.getTracks().forEach((track) => track.stop());
      session.processor.onaudioprocess = null;
      streamSessionRef.current = null;
      try {
        await session.context.close();
      } catch {
        // ignore close errors
      }
    }

    const ws = streamWsRef.current;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
      }
      streamWsRef.current = null;
    }

    if (streamTimerRef.current) {
      window.clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }

    setStreamMicLevel(0);
    setStreamStatus(nextStatus);
  };

  const startStreaming = async () => {
    if (streamStatus === "connecting" || streamStatus === "streaming") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      message.error("Microphone not supported in this browser.");
      return;
    }
    if (!streamUrl) {
      message.error("Stream WS URL не задан.");
      return;
    }
    if (isRecording) {
      message.warning("Остановите запись, чтобы запустить стрим.");
      return;
    }

    const runId = liveAsrRunIdRef.current + 1;
    liveAsrRunIdRef.current = runId;
    resetLiveAsrState();
    setStreamError(null);
    setStreamSegments([]);
    setStreamInfo(null);
    setStreamStatus("connecting");
    const wsTarget = buildStreamUrl();

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsTarget);
    } catch (err: any) {
      setStreamError(err?.message || "Некорректный WS URL.");
      setStreamStatus("error");
      return;
    }

    ws.binaryType = "arraybuffer";
    streamWsRef.current = ws;

    ws.onopen = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: STREAM_TARGET_SAMPLE_RATE,
            sampleSize: 16,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });

        const context = new AudioContext({ sampleRate: STREAM_TARGET_SAMPLE_RATE });
        await context.resume();
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(STREAM_PROCESSOR_SIZE, 1, 1);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.78;
        const analyserData = new Uint8Array(analyser.frequencyBinCount);
        const gain = context.createGain();
        gain.gain.value = 0;

        const session: StreamSession = {
          context,
          source,
          processor,
          analyser,
          analyserData,
          gain,
          stream,
          ws,
          lastLevelAt: 0
        };

        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          const inputRate = event.inputBuffer.sampleRate;
          const downsampled = downsampleBuffer(input, inputRate, STREAM_TARGET_SAMPLE_RATE);
          const pcm16 = floatTo16BitPCM(downsampled);
          if (ws.readyState === WebSocket.OPEN && pcm16.length > 0) {
            ws.send(pcm16.buffer);
          }
          liveAsrBufferRef.current.push(downsampled);
          liveAsrBufferedSamplesRef.current += downsampled.length;
          drainLiveAsrBuffer(runId);

          const now = performance.now();
          if (now - session.lastLevelAt > 40) {
            let sum = 0;
            for (let i = 0; i < input.length; i += 1) {
              sum += input[i] * input[i];
            }
            const rms = Math.sqrt(sum / input.length);
            setStreamMicLevel(Math.min(1, rms * 2.6));
            session.lastLevelAt = now;
          }
        };

        source.connect(analyser);
        source.connect(processor);
        processor.connect(gain);
        gain.connect(context.destination);

        streamSessionRef.current = session;
        streamStartedAtRef.current = Date.now();
        streamActiveRef.current = true;
        setStreamElapsedMs(0);
        if (streamTimerRef.current) {
          window.clearInterval(streamTimerRef.current);
        }
        streamTimerRef.current = window.setInterval(() => {
          if (!streamStartedAtRef.current) return;
          setStreamElapsedMs(Date.now() - streamStartedAtRef.current);
        }, 1000);

        setStreamStatus("streaming");
      } catch (err: any) {
        setStreamError(err?.message || "Не удалось запустить микрофон.");
        await stopStreaming("error");
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload?.type === "hello") {
        setStreamInfo(payload);
        return;
      }
      if (payload?.type === "error") {
        setStreamError(payload.detail || "Ошибка стрима.");
        void stopStreaming("error");
        return;
      }
      if (payload?.type === "update") {
        const incoming = normalizeStreamSegments(Array.isArray(payload.segments) ? payload.segments : []);
        if (incoming.length) {
          setStreamSegments((prev) => mergeStreamSegments(prev, incoming));
        }
      }
    };

    ws.onerror = () => {
      setStreamError("Ошибка соединения WebSocket.");
      void stopStreaming("error");
    };

    ws.onclose = () => {
      setStreamError((prev) => prev || "Соединение закрыто.");
      void stopStreaming("error");
    };
  };

  const handleUpload = async (file: File, predecoded?: AudioBuffer) => {
    const processingStartedAt = Date.now();
    const id = createId();
    const title = file.name.replace(/\.[^/.]+$/, "");
    const createdAt = new Date().toISOString();
    const audioUrl = URL.createObjectURL(file);

    const newItem: TranscriptItem = {
      id,
      title: title || "Untitled",
      createdAt,
      status: "processing",
      processingStartedAt,
      audioUrl,
      utterances: [],
      diarSegments: [],
      words: [],
      speakerMap: {},
      debugAsrSegments: []
    };

    setTranscripts((prev) => [newItem, ...prev]);
    setActiveId(id);

    try {
      const diarParams: Record<string, string | number> = {};
      if (minSpeakers != null) {
        diarParams.min_speakers = minSpeakers;
      }
      if (maxSpeakers != null) {
        diarParams.max_speakers = maxSpeakers;
      }
      if (diarProfile) {
        diarParams.profile = diarProfile;
      }

      const [diarResponse, audioBuffer] = await Promise.all([
        diarizeAudio(file, diarParams),
        predecoded ? Promise.resolve(predecoded) : decodeAudioFile(file)
      ]);

      const rawDiarSegments = extractDiarSegments(diarResponse);
      const asrSegments = rawDiarSegments;
      const diarSegments = rawDiarSegments;
      const diarSegmentsForAttribution = rawDiarSegments;
      const durationSec = audioBuffer.duration;
      const debugAsrSegments: Array<AsrDebugSegment | null> = new Array(asrSegments.length).fill(
        null
      );
      const asrSegmentWordBuckets: Array<WordToken[] | null> = new Array(asrSegments.length).fill(
        null
      );
      let lastProgressUpdate = 0;

      setTranscript(id, (prev) => ({
        ...prev,
        diarSegments
      }));

      const extractSegmentWords = (result: {
        seg: (typeof asrSegments)[number];
        clipStart: number;
        clipEnd: number;
        asr: any;
      }) => {
        if (!result.asr) return [];
        const asrPayload = result.asr?.asr ?? result.asr;
        const segmentWords = extractWords(asrPayload).map((w) => ({
          ...w,
          start: w.start + result.clipStart,
          end: w.end + result.clipStart
        }));

        return segmentWords.filter((w) => {
          const center = (w.start + w.end) / 2;
          return center >= result.seg.start - 0.05 && center <= result.seg.end + 0.05;
        });
      };

      const collectSegmentWords = () => {
        const words: WordToken[] = [];
        for (const bucket of asrSegmentWordBuckets) {
          if (bucket && bucket.length) {
            words.push(...bucket);
          }
        }
        return words.sort((a, b) => (a.start - b.start) || (a.end - b.end));
      };

      const updatePartialTranscript = (force = false) => {
        const now = Date.now();
        if (!force && now - lastProgressUpdate < 250) return;
        lastProgressUpdate = now;
        const words = collectSegmentWords();
        const mergedUtterances = buildUtterancesByDiarSegments(
          words,
          diarSegmentsForAttribution,
          UI_UTTERANCE_MERGE_GAP_SEC
        );
        setTranscript(id, (prev) => ({
          ...prev,
          words,
          diarSegments,
          utterances: mergedUtterances
        }));
      };

      const asrSegmentResults = await mapWithConcurrency(
        asrSegments,
        ASR_CONCURRENCY,
        async (seg, index) => {
          const clipStart = Math.max(0, seg.start - ASR_SEGMENT_PADDING_SEC);
          const clipEnd = Math.min(durationSec, seg.end + ASR_SEGMENT_PADDING_SEC);
          if (clipEnd <= clipStart) {
            return { seg, clipStart, clipEnd, asr: null };
          }
          const mono = getMonoSlice(audioBuffer, clipStart, clipEnd);
          const wavBuffer = encodeWav(mono, audioBuffer.sampleRate);
          const blob = new Blob([wavBuffer], { type: "audio/wav" });
          if (DEBUG_SAVE_ASR_SEGMENTS) {
            const speakerTag = seg.speaker ? String(seg.speaker) : "unknown";
            const fileLabel = safeName(
              `${title || id}_seg_${index}_${speakerTag}_${clipStart.toFixed(2)}-${clipEnd.toFixed(2)}`
            );
            const url = URL.createObjectURL(blob);
            debugAsrSegments[index] = {
              id: fileLabel,
              url,
              filename: `${fileLabel}.wav`,
              speaker: speakerTag,
              start: clipStart,
              end: clipEnd
            };
          }
          const speakerTag = "speaker" in seg ? `_${seg.speaker}` : "";
          const segFile = new File([blob], `seg_${index}${speakerTag}.wav`, { type: "audio/wav" });
          const asr = await transcribeAudio(segFile);
          return { seg, clipStart, clipEnd, asr };
        },
        (result, index) => {
          if (!result.asr) return;
          const filtered = extractSegmentWords(result);
          asrSegmentWordBuckets[index] = filtered;
          updatePartialTranscript();
        }
      );

      const words = collectSegmentWords();
      const mergedUtterances = buildUtterancesByDiarSegments(
        words,
        diarSegmentsForAttribution,
        UI_UTTERANCE_MERGE_GAP_SEC
      );
      const speakers = Array.from(new Set(mergedUtterances.map((u) => u.speaker)));

      saveDebugArtifacts(
        title || id,
        { diarSegments, asrSegments: asrSegmentResults },
        diarResponse
      );

      const processingFinishedAt = Date.now();
      const processingMs = processingFinishedAt - processingStartedAt;

      setTranscript(id, (prev) => ({
        ...prev,
        status: "ready",
        processingFinishedAt,
        processingMs,
        words,
        diarSegments,
        utterances: mergedUtterances,
        speakerMap: Object.keys(prev.speakerMap).length ? prev.speakerMap : buildSpeakerMap(speakers),
        debugAsrSegments: DEBUG_SAVE_ASR_SEGMENTS
          ? debugAsrSegments.filter((seg): seg is AsrDebugSegment => Boolean(seg))
          : prev.debugAsrSegments
      }));

      message.success("Transcription + diarization готово");
    } catch (err: any) {
      const processingFinishedAt = Date.now();
      const processingMs = processingFinishedAt - processingStartedAt;
      setTranscript(id, (prev) => ({
        ...prev,
        status: "error",
        processingFinishedAt,
        processingMs
      }));
      message.error(err?.message || "Ошибка обработки аудио");
    }
  };

  const handleWordClick = (word: WordToken) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, word.start + 0.01);
    audioRef.current.play();
  };

  const handleUtteranceSpeakerChange = (utterance: Utterance, newSpeaker: string) => {
    if (!activeTranscript) return;
    setTranscript(activeTranscript.id, (prev) => {
      const updated = prev.utterances.map((u) =>
        u === utterance ? { ...u, speaker: newSpeaker } : u
      );
      const merged = mergeUtterances(updated, UI_UTTERANCE_MERGE_GAP_SEC);
      const map = { ...prev.speakerMap };
      if (!map[newSpeaker]) {
        map[newSpeaker] = `Speaker ${Object.keys(map).length + 1}`;
      }
      return { ...prev, utterances: merged, speakerMap: map };
    });
  };

  const handleAddSpeaker = () => {
    if (!activeTranscript) return;
    const existing = Object.keys(activeTranscript.speakerMap);
    const newId = createSpeakerId(existing);
    setTranscript(activeTranscript.id, (prev) => ({
      ...prev,
      speakerMap: {
        ...prev.speakerMap,
        [newId]: `Speaker ${existing.length + 1}`
      }
    }));
    setRenameState({ open: true, speakerId: newId, label: `Speaker ${existing.length + 1}` });
  };

  const handleRenameSpeaker = () => {
    if (!activeTranscript || !renameState.speakerId || !renameState.label) {
      setRenameState({ open: false });
      return;
    }
    const speakerId = renameState.speakerId;
    const newLabel = renameState.label.trim();
    setTranscript(activeTranscript.id, (prev) => ({
      ...prev,
      speakerMap: { ...prev.speakerMap, [speakerId]: newLabel || prev.speakerMap[speakerId] }
    }));
    setRenameState({ open: false });
  };

  const handleTogglePlay = () => {
    if (!audioRef.current) return;
    if (audioRef.current.paused) {
      audioRef.current.play();
    } else {
      audioRef.current.pause();
    }
  };

  const handleWaveSeek = (event: MouseEvent<HTMLDivElement>) => {
    if (isRecording) return;
    if (!audioRef.current || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audioRef.current.currentTime = ratio * duration;
  };

  const prepareWaveCanvas = (canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  };

  const startWaveAnimation = (session: RecorderSession) => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const prepared = prepareWaveCanvas(canvas);
      if (!prepared) return;
      const { ctx, width, height } = prepared;
      ctx.clearRect(0, 0, width, height);

      session.analyser.getByteTimeDomainData(session.analyserData);
      const bars = 48;
      const step = Math.floor(session.analyserData.length / bars);
      const center = height / 2;
      const barWidth = width / (bars * 1.2);
      const gap = barWidth * 0.4;

      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "rgba(31, 122, 97, 0.6)");
      gradient.addColorStop(0.5, "rgba(17, 24, 39, 0.9)");
      gradient.addColorStop(1, "rgba(31, 122, 97, 0.6)");

      ctx.strokeStyle = gradient;
      ctx.lineWidth = Math.max(2, barWidth);
      ctx.lineCap = "round";

      let x = (width - bars * (barWidth + gap) + gap) / 2;
      for (let i = 0; i < bars; i += 1) {
        const sample = session.analyserData[i * step] / 128 - 1;
        const amp = Math.min(1, Math.abs(sample) * 1.5 + 0.05);
        const barHeight = Math.max(6, amp * height * 0.9);
        ctx.beginPath();
        ctx.moveTo(x, center - barHeight / 2);
        ctx.lineTo(x, center + barHeight / 2);
        ctx.stroke();
        x += barWidth + gap;
      }

      waveAnimRef.current = requestAnimationFrame(draw);
    };

    if (waveAnimRef.current) {
      cancelAnimationFrame(waveAnimRef.current);
    }
    draw();
  };

  const stopWaveAnimation = () => {
    if (waveAnimRef.current) {
      cancelAnimationFrame(waveAnimRef.current);
      waveAnimRef.current = null;
    }
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const prepared = prepareWaveCanvas(canvas);
    if (!prepared) return;
    prepared.ctx.clearRect(0, 0, prepared.width, prepared.height);
  };

  const startPlaybackMeter = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!playbackContextRef.current) {
      const context = new AudioContext();
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.78;
      source.connect(analyser);
      analyser.connect(context.destination);
      playbackContextRef.current = context;
      playbackAnalyserRef.current = analyser;
      playbackDataRef.current = new Uint8Array(analyser.frequencyBinCount);
    }

    const context = playbackContextRef.current;
    if (context && context.state === "suspended") {
      void context.resume();
    }

    const analyser = playbackAnalyserRef.current;
    const data = playbackDataRef.current;
    if (!analyser || !data) return;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const sample = (data[i] - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / data.length);
      setPlaybackLevel(Math.min(1, rms * 3.2));
      playbackRafRef.current = requestAnimationFrame(tick);
    };

    if (playbackRafRef.current == null) {
      tick();
    }
  };

  const stopPlaybackMeter = () => {
    if (playbackRafRef.current) {
      cancelAnimationFrame(playbackRafRef.current);
      playbackRafRef.current = null;
    }
    setPlaybackLevel(0);
  };

  useEffect(() => {
    return () => {
      stopPlaybackMeter();
      if (playbackContextRef.current) {
        void playbackContextRef.current.close();
        playbackContextRef.current = null;
      }
      playbackAnalyserRef.current = null;
      playbackDataRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      void stopStreaming();
    };
  }, []);

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      message.error("Microphone not supported in this browser.");
      return;
    }
    if (isRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          sampleSize: 16,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }

      const context = new AudioContext({ sampleRate: 48000 });
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.78;
      const analyserData = new Uint8Array(analyser.frequencyBinCount);
      const gain = context.createGain();
      gain.gain.value = 0;

      const session: RecorderSession = {
        context,
        source,
        processor,
        analyser,
        analyserData,
        gain,
        stream,
        buffers: [],
        bufferLength: 0,
        sampleRate: context.sampleRate,
        lastLevelAt: 0
      };

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        session.buffers.push(new Float32Array(input));
        session.bufferLength += input.length;

        const now = performance.now();
        if (now - session.lastLevelAt > 40) {
          let sum = 0;
          for (let i = 0; i < input.length; i += 1) {
            sum += input[i] * input[i];
          }
          const rms = Math.sqrt(sum / input.length);
          setMicLevel(Math.min(1, rms * 2.6));
          session.lastLevelAt = now;
        }
      };

      source.connect(analyser);
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);

      recorderRef.current = session;
      setRecordingTime(0);
      setIsRecording(true);
      recordTimerRef.current = window.setInterval(() => {
        setRecordingTime((t) => t + 1);
      }, 1000);
      startWaveAnimation(session);
    } catch (err: any) {
      message.error(err?.message || "Microphone access denied.");
    }
  };

  const stopRecording = async () => {
    const session = recorderRef.current;
    if (!session) return;

    session.processor.disconnect();
    session.source.disconnect();
    session.analyser.disconnect();
    session.gain.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    session.processor.onaudioprocess = null;
    recorderRef.current = null;

    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }

    await session.context.close();
    setIsRecording(false);
    setMicLevel(0);
    stopWaveAnimation();

    if (!session.bufferLength) {
      message.warning("No audio captured.");
      return;
    }

    const pcm = new Float32Array(session.bufferLength);
    let offset = 0;
    for (const chunk of session.buffers) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }

    const wavBuffer = encodeWav(pcm, session.sampleRate);
    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = new File([blob], `recording_${stamp}.wav`, { type: "audio/wav" });
    const audioBuffer = await createAudioBufferFromMono(pcm, session.sampleRate);
    void handleUpload(file, audioBuffer);
  };

  const toggleRecording = () => {
    if (isRecording) {
      void stopRecording();
    } else {
      void startRecording();
    }
  };

  const progress = duration ? Math.min(1, currentTime / duration) : 0;
  const voiceLevel = isRecording ? micLevel : isPlaying ? playbackLevel : 0;
  const activeMicLevel = isRecording ? micLevel : isStreaming ? streamMicLevel : 0;
  const appStyle = {
    "--mic": activeMicLevel,
    "--voice": voiceLevel
  } as CSSProperties;

  return (
    <div className="app-shell" style={appStyle}>
      <header className="top-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item}
            className={item === activeNav ? "nav-pill active" : "nav-pill"}
            type="button"
            onClick={() => setActiveNav(item)}
          >
            {item}
          </button>
        ))}
      </header>

      {activeNav === "Speech to Text" && (
      <div className="main-grid">
        <aside className="sidebar">
          <div className="sidebar-header">
            <Typography.Title level={5} className="sidebar-title">
              Transcripts
            </Typography.Title>
          </div>

          <div className="sidebar-list">
            {transcripts.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Загрузите аудио"
              />
            ) : (
              <List
                dataSource={transcripts}
                renderItem={(item) => (
                  <List.Item
                    className={
                      item.id === activeTranscript?.id
                        ? "transcript-item active"
                        : "transcript-item"
                    }
                    onClick={() => setActiveId(item.id)}
                  >
                    <div className="transcript-item-title">
                      <span>{item.title}</span>
                      <span className={`status-dot ${item.status}`} />
                    </div>
                    <div className="transcript-item-sub">
                      {new Date(item.createdAt).toLocaleDateString()}
                    </div>
                  </List.Item>
                )}
              />
            )}
          </div>

          <div className="sidebar-controls">
            <div className="control-row">
              <span className="control-label">Min speakers</span>
              <InputNumber
                min={1}
                max={20}
                value={minSpeakers ?? undefined}
                placeholder="auto"
                onChange={(value) =>
                  setMinSpeakers(typeof value === "number" ? value : null)
                }
              />
            </div>
            <div className="control-row">
              <span className="control-label">Max speakers</span>
              <InputNumber
                min={1}
                max={20}
                value={maxSpeakers ?? undefined}
                placeholder="auto"
                onChange={(value) =>
                  setMaxSpeakers(typeof value === "number" ? value : null)
                }
              />
            </div>
            <div className="control-row">
              <span className="control-label">Profile</span>
              <Select
                size="small"
                value={diarProfile ?? undefined}
                placeholder="auto"
                allowClear
                className="diar-select"
                onChange={(value) => setDiarProfile(typeof value === "string" ? value : null)}
                options={[
                  { value: "general", label: "general" },
                  { value: "meeting", label: "meeting" },
                  { value: "telephonic", label: "telephonic" }
                ]}
              />
            </div>
            <span className="control-hint">Пусто = авто</span>
          </div>

          <div className="sidebar-footer">
            <Upload
              accept="audio/*"
              showUploadList={false}
              beforeUpload={(file) => {
                void handleUpload(file);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} type="primary" size="large" block>
                Upload file
              </Button>
            </Upload>
          </div>
        </aside>

        <section className="workspace">
          <div className={isRecording ? "player-card recording" : "player-card"}>
          <div className="player-left">
            <Button
              type="text"
              className="play-btn"
              icon={isPlaying ? <PauseCircleFilled /> : <PlayCircleFilled />}
              onClick={handleTogglePlay}
            />
            <div className={isRecording ? "waveform recording" : "waveform"} onClick={handleWaveSeek}>
              <canvas ref={waveCanvasRef} className="waveform-canvas" />
              <div className="waveform-bars" />
              <div className="waveform-progress" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
          <div className="player-right">
            <div className="player-meta">
              <span>{formatTime(currentTime)}</span>
              <span className="divider" />
              <span>{formatTime(duration)}</span>
            </div>
            <div className="record-control">
              <button
                type="button"
                className={isRecording ? "record-btn recording" : "record-btn"}
                onClick={toggleRecording}
              >
                <span
                  className="record-level"
                  style={{ transform: `scale(${1 + micLevel * 1.4})` }}
                />
                <span className="record-icon">
                  {isRecording ? <StopOutlined /> : <AudioOutlined />}
                </span>
              </button>
              <div className={isRecording ? "mic-meter active" : "mic-meter"} aria-hidden="true">
                {MIC_BARS.map((bar) => (
                  <span key={bar} className="mic-bar" />
                ))}
              </div>
              <div className="record-meta">
                <span className="record-label">
                  {isRecording ? "Recording" : "Mic test"}
                </span>
                <span className="record-time">{formatTime(recordingTime)}</span>
              </div>
            </div>
          </div>
        </div>

          <div className="transcript-card">
          <div className="transcript-toolbar">
            <div className="speaker-stack">
                {speakerIds.map((speakerId) => {
                  const isSpeaking = speakerId === activeSpeakerId && voiceLevel > 0.02;
                  const hue = hashHue(speakerId);
                  return (
                    <button
                      key={speakerId}
                      type="button"
                      className={isSpeaking ? "speaker-chip speaking" : "speaker-chip"}
                      onClick={() =>
                        setRenameState({
                          open: true,
                          speakerId,
                          label: activeTranscript?.speakerMap[speakerId] || speakerId
                        })
                      }
                    >
                      <span
                        className="speaker-avatar"
                        style={{
                          background: `conic-gradient(from 180deg, hsl(${hue} 72% 64%), hsl(${(hue + 60) % 360} 78% 62%), hsl(${(hue + 120) % 360} 72% 58%))`
                        }}
                      />
                      <span className="speaker-label">
                        {activeTranscript?.speakerMap[speakerId] || speakerId}
                      </span>
                      <EditOutlined />
                    </button>
                  );
                })}
            </div>
            <div className="toolbar-actions">
              <Button
                icon={<PlusOutlined />}
                className="ghost-btn"
                onClick={handleAddSpeaker}
              >
                Add speaker
              </Button>
            </div>
          </div>

            {!activeTranscript && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Загрузите файл для транскрипции"
              />
            )}

            {activeTranscript && activeTranscript.status === "processing" && (
              <div className="loading-state">
                <Spin size="large" />
                <Typography.Text>Обрабатываем аудио...</Typography.Text>
                {processingElapsedMs != null && (
                  <Typography.Text className="processing-time">
                    Прошло: {formatDurationMs(processingElapsedMs)}
                  </Typography.Text>
                )}
              </div>
            )}

            {activeTranscript && activeTranscript.status === "error" && (
              <>
                <Empty description="Ошибка обработки. Попробуйте другой файл." />
                {processingElapsedMs != null && (
                  <Typography.Text className="processing-time">
                    Время до ошибки: {formatDurationMs(processingElapsedMs)}
                  </Typography.Text>
                )}
              </>
            )}

            {activeTranscript && activeTranscript.status !== "error" && (
              <>
                {activeTranscript.status === "ready" && processingElapsedMs != null && (
                  <Typography.Text className="processing-time">
                    Готово за {formatDurationMs(processingElapsedMs)}
                  </Typography.Text>
                )}
                {DEBUG_SAVE_ASR_SEGMENTS && activeTranscript.debugAsrSegments.length > 0 && (
                  <details className="debug-asr">
                    <summary>
                      ASR segments sent ({activeTranscript.debugAsrSegments.length})
                    </summary>
                    <div className="debug-asr-list">
                      {activeTranscript.debugAsrSegments.map((seg, index) => (
                        <div className="debug-asr-item" key={`${seg.id}-${index}`}>
                          <div className="debug-asr-meta">
                            <span className="debug-asr-speaker">
                              {activeTranscript.speakerMap[seg.speaker] || seg.speaker}
                            </span>
                            <span className="debug-asr-time">
                              {formatTime(seg.start)} - {formatTime(seg.end)}
                            </span>
                            <a className="debug-asr-download" href={seg.url} download={seg.filename}>
                              Download
                            </a>
                          </div>
                          <audio controls src={seg.url} preload="none" />
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                <div className="utterance-list">
                  {activeTranscript.utterances.map((utterance, index) => {
                    const hue = hashHue(utterance.speaker);
                    const isActive = activeUtteranceIndex === index;
                    const isSpeaking = isActive && voiceLevel > 0.02;
                    return (
                      <div
                        key={`${utterance.start}-${utterance.end}-${index}`}
                        className={isActive ? "utterance active" : "utterance"}
                        style={{ animationDelay: `${index * 30}ms` }}
                        onClick={() => {
                          if (audioRef.current) {
                            audioRef.current.currentTime = utterance.start;
                            audioRef.current.play();
                          }
                        }}
                      >
                        <div className="utterance-meta">
                          <span
                            className={isSpeaking ? "speaker-avatar speaking" : "speaker-avatar"}
                            style={{
                              background: `conic-gradient(from 180deg, hsl(${hue} 72% 64%), hsl(${(hue + 60) % 360} 78% 62%), hsl(${(hue + 120) % 360} 72% 58%))`
                            }}
                          />
                          <div className="utterance-meta-text">
                            <span className="speaker-title">
                              {activeTranscript.speakerMap[utterance.speaker] || utterance.speaker}
                            </span>
                            <span className="timecode">
                              {formatTime(utterance.start)} - {formatTime(utterance.end)}
                            </span>
                          </div>
                          <Select
                            size="small"
                            value={utterance.speaker}
                            className="speaker-select"
                            onChange={(value) => handleUtteranceSpeakerChange(utterance, value)}
                            options={Object.keys(activeTranscript.speakerMap).map((id) => ({
                              value: id,
                              label: activeTranscript.speakerMap[id] || id
                            }))}
                          />
                        </div>
                        <div className="utterance-text">
                          {utterance.words.map((word, wIdx) => {
                            const key = `${index}-${wIdx}`;
                            return (
                              <span
                                key={key}
                                className={
                                  key === activeWordKey ? "word active" : "word"
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleWordClick(word);
                                }}
                              >
                                {word.word}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
      )}

      {activeNav === LIVE_DIAR_LABEL && (
      <div className="main-grid">
        <aside className="sidebar">
          <div className="sidebar-header">
            <Typography.Title level={5} className="sidebar-title">
              Live stream
            </Typography.Title>
          </div>

          <div className="sidebar-controls">
            <div className="control-row">
              <span className="control-label">WS URL</span>
              <Input
                size="small"
                value={streamUrl}
                placeholder="ws://host:9001/ws"
                className="stream-input"
                onChange={(event) => setStreamUrl(event.target.value)}
              />
            </div>
            <div className="control-row">
              <span className="control-label">Preset</span>
              <Select
                size="small"
                value={streamPreset}
                className="stream-select"
                onChange={(value) => setStreamPreset(value as "low" | "very_high")}
                options={[
                  { value: "low", label: "low" },
                  { value: "very_high", label: "very_high" }
                ]}
              />
            </div>
            <div className="control-row">
              <span className="control-label">Status</span>
              <span className={`stream-status-text ${isStreaming ? "live" : ""}`}>
                {streamStatus === "connecting" ? "connecting" : streamStatus}
              </span>
            </div>
          </div>

          <div className="stream-meter">
            <div className={isStreaming ? "mic-meter active" : "mic-meter"} aria-hidden="true">
              {MIC_BARS.map((bar) => (
                <span key={bar} className="mic-bar" />
              ))}
            </div>
            <span className="stream-time">
              {isStreaming ? `On air ${formatDurationMs(streamElapsedMs)}` : "Mic idle"}
            </span>
          </div>

          <div className="sidebar-footer">
            <div className="stream-actions">
              <Button
                type="primary"
                size="large"
                block
                disabled={isStreaming || streamStatus === "connecting"}
                onClick={() => void startStreaming()}
              >
                Start stream
              </Button>
              <Button
                danger
                size="large"
                block
                disabled={!isStreaming && streamStatus !== "connecting"}
                onClick={() => void stopStreaming("idle")}
              >
                Stop stream
              </Button>
            </div>
          </div>
        </aside>

        <section className="workspace">
          <div className="transcript-card">
            <div className="stream-header">
              <div>
                <Typography.Title level={4} className="stream-title">
                  Streaming diarization
                </Typography.Title>
                <Typography.Text className="stream-subtitle">
                  Сегменты появляются по мере готовности.
                </Typography.Text>
              </div>
              <div className="stream-meta">
                <span className={`stream-badge ${isStreaming ? "live" : ""}`}>
                  {isStreaming ? "LIVE" : streamStatus.toUpperCase()}
                </span>
                {streamInfo?.model && <span>Model: {streamInfo.model}</span>}
                {streamSegments.length > 0 && <span>Segments: {streamSegments.length}</span>}
              </div>
            </div>

            {streamError && (
              <Typography.Text type="danger">
                {streamError}
              </Typography.Text>
            )}

            {liveAsrUtterances.length > 0 ? (
              <div className="stream-segment-list">
                {liveAsrUtterances.map((utterance, index) => {
                  const hue = hashHue(utterance.speaker);
                  return (
                    <div
                      key={`${utterance.speaker}-${utterance.start}-${utterance.end}-${index}`}
                      className="stream-segment"
                    >
                      <div className="stream-segment-meta">
                        <span
                          className="stream-asr-speaker"
                          style={{
                            background: `linear-gradient(120deg, hsl(${hue} 70% 55%), hsl(${(hue + 60) % 360} 70% 55%))`
                          }}
                        >
                          {streamSpeakerLabels[utterance.speaker] ?? "Спикер"}
                        </span>
                        <span className="stream-time">
                          {formatTime(utterance.start)} - {formatTime(utterance.end)}
                        </span>
                      </div>
                      <Typography.Paragraph className="stream-segment-text">
                        {utterance.text}
                      </Typography.Paragraph>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty
                description={
                  streamStatus === "streaming"
                    ? "Текст появится после первых чанков ASR."
                    : "Запустите стрим, чтобы увидеть диалог."
                }
              />
            )}
          </div>
        </section>
      </div>
      )}

      {activeNav !== "Speech to Text" && activeNav !== LIVE_DIAR_LABEL && (
      <div className="main-grid">
        <section className="workspace" style={{ gridColumn: "1 / -1" }}>
          <div className="transcript-card">
            <Empty description="Раздел в разработке." />
          </div>
        </section>
      </div>
      )}

      <audio
        ref={audioRef}
        src={activeTranscript?.audioUrl}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        onPlay={() => {
          setIsPlaying(true);
          startPlaybackMeter();
        }}
        onPause={() => {
          setIsPlaying(false);
          stopPlaybackMeter();
        }}
        onEnded={() => {
          setIsPlaying(false);
          stopPlaybackMeter();
        }}
      />

      <Modal
        title="Rename speaker"
        open={renameState.open}
        onOk={handleRenameSpeaker}
        onCancel={() => setRenameState({ open: false })}
        okText="Save"
      >
        <Input
          value={renameState.label}
          onChange={(event) =>
            setRenameState((prev) => ({ ...prev, label: event.target.value }))
          }
          placeholder="Speaker name"
        />
      </Modal>
    </div>
  );
};

export default App;
