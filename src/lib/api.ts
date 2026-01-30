const API_BASE = import.meta.env.VITE_API_BASE ?? "https://mangisoz.nu.edu.kz/backend/api/v1";
const API_KEY = import.meta.env.VITE_API_KEY ?? "";
const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN ?? "";

const STT_RATE_LIMIT_PER_MIN = 100;
const STT_MIN_INTERVAL_MS = Math.ceil(60000 / STT_RATE_LIMIT_PER_MIN);
let sttChain: Promise<void> = Promise.resolve();
let lastSttStart = 0;

const buildHeaders = () => {
  const headers: Record<string, string> = {
    "X-API-Key": API_KEY
  };
  if (AUTH_TOKEN) {
    headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  }
  return headers;
};

export type DiarParams = Record<string, string>;

export const DIAR_PRESETS: Record<"sensitive" | "balanced" | "strict", DiarParams> = {
  sensitive: {
    return_rttm: "false",
    exclusive: "true",
    embed_exclude_overlap: "true",
    seg_min_duration_off: "0.0",
    seg_threshold: "0.40",
    cluster_threshold: "0.58",
    vbx_fa: "0.07",
    vbx_fb: "0.70"
  },
  balanced: {
    return_rttm: "false",
    exclusive: "true",
    embed_exclude_overlap: "true",
    seg_min_duration_off: "0.0",
    seg_threshold: "0.50",
    cluster_threshold: "0.60",
    vbx_fa: "0.07",
    vbx_fb: "0.80"
  },
  strict: {
    return_rttm: "false",
    exclusive: "true",
    embed_exclude_overlap: "true",
    seg_min_duration_off: "0.12",
    seg_threshold: "0.60",
    cluster_threshold: "0.62",
    vbx_fa: "0.07",
    vbx_fb: "1.00"
  }
};

export const DIAR_PARAMS: DiarParams = DIAR_PRESETS.balanced;

const scheduleStt = async <T>(fn: () => Promise<T>) => {
  let release: (() => void) | null = null;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = sttChain;
  sttChain = sttChain.then(() => next);

  await prev;
  const now = Date.now();
  const wait = Math.max(0, lastSttStart + STT_MIN_INTERVAL_MS - now);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastSttStart = Date.now();
  release?.();
  return fn();
};

export const transcribeAudio = async (file: File) => {
  return scheduleStt(async () => {
    const form = new FormData();
    form.append("audio", file);
    form.append("language", "auto");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities", "word");
    form.append("prompt", "");
    form.append("temperature", "0");
    form.append("include_raw", "false");

    const res = await fetch(`${API_BASE}/stt/transcribe`, {
      method: "POST",
      headers: buildHeaders(),
      body: form
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Transcribe failed: ${res.status}`);
    }
    return res.json();
  });
};

export const diarizeAudio = async (file: File, params: DiarParams = DIAR_PARAMS) => {
  const form = new FormData();
  form.append("audio", file);

  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/diarization/analyze?${query}`, {
    method: "POST",
    headers: buildHeaders(),
    body: form
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Diarization failed: ${res.status}`);
  }
  return res.json();
};
