import type { DiarSegment, Utterance, WordToken } from "./types";

const WORD_CENTER_EPS = 0.0;
const MERGE_DIAR_GAP_SEC = 0.2;
const MERGE_UTTERANCE_GAP_SEC = 0.35;

export const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
};

export const smartJoinTokens = (tokens: string[]) => {
  let text = "";
  for (const token of tokens) {
    if (!token) continue;
    if (!text) {
      text = token.replace(/^\s+/, "");
      continue;
    }
    if (/^\s/.test(token)) {
      text += token;
    } else if (/^[\.,!?:;%\)\]\}»]/.test(token)) {
      text += token;
    } else if (/[\(\[\{«]$/.test(text)) {
      text += token;
    } else {
      text += ` ${token}`;
    }
  }
  return text.trim();
};

export const extractWords = (asr: any): WordToken[] => {
  const words: WordToken[] = [];
  const direct = Array.isArray(asr?.words) ? asr.words : [];
  if (direct.length > 0) {
    for (const w of direct) {
      if (w && w.start != null && w.end != null && w.word != null) {
        words.push({
          start: Number(w.start),
          end: Number(w.end),
          word: String(w.word),
          prob: w.probability ?? w.prob
        });
      }
    }
  } else if (Array.isArray(asr?.segments)) {
    for (const seg of asr.segments) {
      const segWords = Array.isArray(seg?.words) ? seg.words : [];
      for (const w of segWords) {
        if (w && w.start != null && w.end != null && w.word != null) {
          words.push({
            start: Number(w.start),
            end: Number(w.end),
            word: String(w.word),
            prob: w.probability ?? w.prob
          });
        }
      }
    }
  }
  return words.sort((a, b) => (a.start - b.start) || (a.end - b.end));
};

export const extractDiarSegments = (diar: any): DiarSegment[] => {
  const data = diar?.data ?? diar;
  const segs = Array.isArray(data?.exclusive_segments)
    ? data.exclusive_segments
    : Array.isArray(data?.segments)
      ? data.segments
      : [];
  const out: DiarSegment[] = [];
  for (const s of segs) {
    if (!s || s.speaker == null || s.start == null || s.end == null) continue;
    out.push({
      speaker: String(s.speaker),
      start: Number(s.start),
      end: Number(s.end)
    });
  }
  return out.sort((a, b) => (a.start - b.start) || (a.end - b.end));
};

export const mergeAdjacentSameSpeaker = (segs: DiarSegment[]) => {
  if (!segs.length) return [];
  const merged: DiarSegment[] = [{ ...segs[0] }];
  for (const seg of segs.slice(1)) {
    const last = merged[merged.length - 1];
    if (seg.speaker === last.speaker && (seg.start - last.end) <= MERGE_DIAR_GAP_SEC) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
};

export const buildUtterancesByDiarSegments = (words: WordToken[], diarSegs: DiarSegment[]) => {
  if (!diarSegs.length) return [];
  const utterances: Utterance[] = [];
  let i = 0;
  const n = words.length;

  for (const seg of diarSegs) {
    const s0 = seg.start;
    const s1 = seg.end;
    if (s1 <= s0) continue;

    while (i < n && words[i].end <= s0) i += 1;

    let j = i;
    const buf: WordToken[] = [];
    while (j < n && words[j].start < s1) {
      const center = (words[j].start + words[j].end) / 2;
      if ((s0 - WORD_CENTER_EPS) <= center && center <= (s1 + WORD_CENTER_EPS)) {
        buf.push(words[j]);
      }
      j += 1;
    }

    i = j;
    if (buf.length) {
      utterances.push({
        speaker: seg.speaker,
        start: s0,
        end: s1,
        words: buf,
        text: smartJoinTokens(buf.map((w) => w.word))
      });
    }
  }

  if (!utterances.length) return [];
  const merged: Utterance[] = [{ ...utterances[0], words: [...utterances[0].words] }];
  for (const u of utterances.slice(1)) {
    const last = merged[merged.length - 1];
    if (u.speaker === last.speaker && (u.start - last.end) <= MERGE_UTTERANCE_GAP_SEC) {
      last.end = Math.max(last.end, u.end);
      last.words = [...last.words, ...u.words];
      last.text = smartJoinTokens(last.words.map((w) => w.word));
    } else {
      merged.push({ ...u, words: [...u.words] });
    }
  }
  return merged;
};

export const buildSpeakerMap = (speakers: string[]) => {
  const map: Record<string, string> = {};
  speakers.forEach((speaker, index) => {
    map[speaker] = `Speaker ${index + 1}`;
  });
  return map;
};

export const createSpeakerId = (existing: string[]) => {
  let idx = existing.length;
  let candidate = `SPEAKER_${idx.toString().padStart(2, "0")}`;
  while (existing.includes(candidate)) {
    idx += 1;
    candidate = `SPEAKER_${idx.toString().padStart(2, "0")}`;
  }
  return candidate;
};

export const hashHue = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
};
