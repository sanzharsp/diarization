import { useMemo, useRef, useState, type MouseEvent } from "react";
import {
  Button,
  Empty,
  Input,
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
import type { TranscriptItem, Utterance, WordToken } from "./lib/types";
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
import { saveDebugArtifacts } from "./lib/debug";
import { encodeWav } from "./lib/wav";

const NAV_ITEMS = [
  "Text to Speech",
  "Agents",
  "Music",
  "Speech to Text",
  "Dubbing",
  "Voice Cloning",
  "ElevenReader"
];

const createId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t_${Date.now()}_${Math.random().toString(16).slice(2)}`);

type RecorderSession = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  gain: GainNode;
  stream: MediaStream;
  buffers: Float32Array[];
  bufferLength: number;
  sampleRate: number;
  lastLevelAt: number;
};

const App = () => {
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<RecorderSession | null>(null);
  const recordTimerRef = useRef<number | null>(null);

  const activeTranscript = transcripts.find((t) => t.id === activeId) ?? transcripts[0];

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

  const setTranscript = (id: string, updater: (prev: TranscriptItem) => TranscriptItem) => {
    setTranscripts((prev) => prev.map((t) => (t.id === id ? updater(t) : t)));
  };

  const handleUpload = async (file: File) => {
    const id = createId();
    const title = file.name.replace(/\.[^/.]+$/, "");
    const createdAt = new Date().toISOString();
    const audioUrl = URL.createObjectURL(file);

    const newItem: TranscriptItem = {
      id,
      title: title || "Untitled",
      createdAt,
      status: "processing",
      audioUrl,
      utterances: [],
      diarSegments: [],
      words: [],
      speakerMap: {}
    };

    setTranscripts((prev) => [newItem, ...prev]);
    setActiveId(id);

    try {
      const [asrResponse, diarResponse] = await Promise.all([
        transcribeAudio(file),
        diarizeAudio(file)
      ]);

      saveDebugArtifacts(title || id, asrResponse, diarResponse);

      const asrPayload = asrResponse?.asr ?? asrResponse;
      const words = extractWords(asrPayload);
      const diarSegments = mergeAdjacentSameSpeaker(extractDiarSegments(diarResponse));
      const utterances = buildUtterancesByDiarSegments(words, diarSegments);
      const speakers = Array.from(new Set(utterances.map((u) => u.speaker)));

      setTranscript(id, (prev) => ({
        ...prev,
        status: "ready",
        words,
        diarSegments,
        utterances,
        speakerMap: Object.keys(prev.speakerMap).length ? prev.speakerMap : buildSpeakerMap(speakers)
      }));

      message.success("Transcription + diarization готово");
    } catch (err: any) {
      setTranscript(id, (prev) => ({ ...prev, status: "error" }));
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
      const merged = mergeUtterances(updated);
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
    if (!audioRef.current || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audioRef.current.currentTime = ratio * duration;
  };

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
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const gain = context.createGain();
      gain.gain.value = 0;

      const session: RecorderSession = {
        context,
        source,
        processor,
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
        if (now - session.lastLevelAt > 60) {
          let sum = 0;
          for (let i = 0; i < input.length; i += 1) {
            sum += input[i] * input[i];
          }
          const rms = Math.sqrt(sum / input.length);
          setMicLevel(Math.min(1, rms * 2.4));
          session.lastLevelAt = now;
        }
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);

      recorderRef.current = session;
      setRecordingTime(0);
      setIsRecording(true);
      recordTimerRef.current = window.setInterval(() => {
        setRecordingTime((t) => t + 1);
      }, 1000);
    } catch (err: any) {
      message.error(err?.message || "Microphone access denied.");
    }
  };

  const stopRecording = async () => {
    const session = recorderRef.current;
    if (!session) return;

    session.processor.disconnect();
    session.source.disconnect();
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
    void handleUpload(file);
  };

  const toggleRecording = () => {
    if (isRecording) {
      void stopRecording();
    } else {
      void startRecording();
    }
  };

  const progress = duration ? Math.min(1, currentTime / duration) : 0;

  return (
    <div className="app-shell">
      <header className="top-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item}
            className={item === "Speech to Text" ? "nav-pill active" : "nav-pill"}
            type="button"
          >
            {item}
          </button>
        ))}
      </header>

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
          <div className="player-card">
          <div className="player-left">
            <Button
              type="text"
              className="play-btn"
              icon={isPlaying ? <PauseCircleFilled /> : <PlayCircleFilled />}
              onClick={handleTogglePlay}
            />
            <div className="waveform" onClick={handleWaveSeek}>
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
                  const hue = hashHue(speakerId);
                  return (
                    <button
                      key={speakerId}
                      type="button"
                      className="speaker-chip"
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
              <Button
                icon={<PlusOutlined />}
                className="ghost-btn"
                onClick={handleAddSpeaker}
              >
                Add speaker
              </Button>
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
              </div>
            )}

            {activeTranscript && activeTranscript.status === "error" && (
              <Empty description="Ошибка обработки. Попробуйте другой файл." />
            )}

            {activeTranscript && activeTranscript.status === "ready" && (
              <div className="utterance-list">
                {activeTranscript.utterances.map((utterance, index) => {
                  const hue = hashHue(utterance.speaker);
                  const isActive = activeUtteranceIndex === index;
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
                          className="speaker-avatar"
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
            )}
          </div>
        </section>
      </div>

      <audio
        ref={audioRef}
        src={activeTranscript?.audioUrl}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
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
