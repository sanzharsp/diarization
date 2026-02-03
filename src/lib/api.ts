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

export const transcribeAudio = async (file: File) => {
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
