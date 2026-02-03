export const safeName = (value: string) =>
  value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);

export const saveDebugArtifacts = (label: string, asr: unknown, diar: unknown) => {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = safeName(label || "session");
  downloadJson(`debug_asr_${prefix}_${ts}.json`, asr);
  downloadJson(`debug_diar_${prefix}_${ts}.json`, diar);
};

export const downloadBlob = (filename: string, blob: Blob) => {
  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Failed to download debug artifact", err);
  }
};

const downloadJson = (filename: string, data: unknown) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  downloadBlob(filename, blob);
};
