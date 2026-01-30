const API_BASE = import.meta.env.VITE_API_BASE ?? "https://mangisoz.nu.edu.kz/backend/api/v1";
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

export const transcribeAudio = async (file: File) => {
  const form = new FormData();
  form.append("audio", file);
  form.append("language", "auto");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities", "word");
  form.append("prompt", "");
  form.append("temperature", "1");
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

export const diarizeAudio = async (file: File) => {
  const form = new FormData();
  form.append("audio", file);

  const res = await fetch(`${API_BASE}/diarization/analyze`, {
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
