const API_BASE = import.meta.env.VITE_API_BASE ?? "https://mangisoz.nu.edu.kz/backend/api/v1";
const DIARIZATION_URL = import.meta.env.VITE_DIARIZATION_URL ?? "";
const DIARIZATION_BASE = import.meta.env.VITE_DIARIZATION_BASE ?? "";
const DIARIZATION_PATH = import.meta.env.VITE_DIARIZATION_PATH ?? "";
const DIARIZATION_AUTH_TOKEN = import.meta.env.VITE_DIARIZATION_AUTH_TOKEN ?? "";
const API_KEY = import.meta.env.VITE_API_KEY ?? "";
const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN ?? "";


const buildHeaders = () => {
  const headers: Record<string, string> = {
    "X-API-Key": API_KEY
  };
  if (AUTH_TOKEN) {
    headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  }
  return headers;
};

export type DiarParams = Record<string, string | number>;
export const DEFAULT_DIAR_PARAMS: DiarParams = {};

const readStreamedJson = async (res: Response) => {
  if (!res.body) {
    return res.json();
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let lastJson: any = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    fullText += chunk;
    buffer += chunk;

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (line.startsWith("data:")) {
        line = line.slice(5).trim();
      }
      if (!line || line === "[DONE]") continue;
      try {
        lastJson = JSON.parse(line);
      } catch {
        // Ignore partial JSON lines; they'll be retried via the fullText fallback.
      }
    }
  }

  const tail = decoder.decode();
  if (tail) {
    fullText += tail;
    buffer += tail;
  }

  const remaining = buffer.trim();
  if (remaining) {
    let line = remaining;
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (line && line !== "[DONE]") {
      try {
        lastJson = JSON.parse(line);
      } catch {
        // Fall through to fullText parsing.
      }
    }
  }

  if (lastJson != null) return lastJson;

  const cleaned = fullText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("data:") ? line.slice(5).trim() : line))
    .filter((line) => line && line !== "[DONE]")
    .join("\n");

  try {
    return JSON.parse(cleaned);
  } catch {
    // Ignore and try raw text below.
  }

  try {
    return JSON.parse(fullText);
  } catch {
    throw new Error("Transcribe failed: invalid streaming JSON");
  }
};

export const transcribeAudio = async (file: File) => {
  const form = new FormData();
  form.append("audio", file);
  form.append("language", "auto");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities", "word");
  form.append("prompt", "");
  form.append("temperature", "0");
  form.append("include_raw", "false");
  form.append("stream", "true");

  const res = await fetch(`${API_BASE}/stt/transcribe`, {
    method: "POST",
    headers: buildHeaders(),
    body: form
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Transcribe failed: ${res.status}`);
  }
  return readStreamedJson(res);
};

const toQueryString = (params: DiarParams) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    query.set(key, String(value));
  }
  return query.toString();
};

const appendQueryParams = (url: string, params: DiarParams) => {
  const query = toQueryString(params);
  if (!query) return url;
  return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
};

const resolveDiarizationUrl = () => {
  if (DIARIZATION_URL) return DIARIZATION_URL;
  if (!DIARIZATION_BASE) return "";
  if (!DIARIZATION_PATH) return DIARIZATION_BASE;
  const base = DIARIZATION_BASE.replace(/\/+$/, "");
  const path = DIARIZATION_PATH.replace(/^\/+/, "");
  return `${base}/${path}`;
};

export const diarizeAudio = async (file: File, params: DiarParams = DEFAULT_DIAR_PARAMS) => {
  const form = new FormData();

  const altUrl = resolveDiarizationUrl();
  const useAltEndpoint = Boolean(altUrl);
  if (useAltEndpoint) {
    form.append("file", file);
    // Alt endpoints expect params in query (per Nemo v2 API).
  } else {
    form.append("audio", file);
  }

  const query = toQueryString(params);
  const url = useAltEndpoint
    ? appendQueryParams(altUrl, params)
    : query
      ? `${API_BASE}/diarization/analyze?${query}`
      : `${API_BASE}/diarization/analyze`;
  const headers = useAltEndpoint
    ? {
        Accept: "application/json",
        ...(DIARIZATION_AUTH_TOKEN ? { Authorization: `Bearer ${DIARIZATION_AUTH_TOKEN}` } : {})
      }
    : buildHeaders();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: form
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Diarization failed: ${res.status}`);
  }
  return res.json();
};
