export type WordToken = {
  start: number;
  end: number;
  word: string;
  prob?: number;
};

export type DiarSegment = {
  speaker: string;
  start: number;
  end: number;
};

export type Utterance = {
  speaker: string;
  start: number;
  end: number;
  words: WordToken[];
  text: string;
};

export type TranscriptStatus = "idle" | "processing" | "ready" | "error";

export type TranscriptItem = {
  id: string;
  title: string;
  createdAt: string;
  status: TranscriptStatus;
  audioUrl?: string;
  utterances: Utterance[];
  diarSegments: DiarSegment[];
  words: WordToken[];
  speakerMap: Record<string, string>;
};
