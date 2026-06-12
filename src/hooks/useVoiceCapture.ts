import { useCallback, useRef, useState } from "preact/hooks";
import { transcribeFile } from "../api/commands";
import { startRecording as micStart, stopRecording as micStop } from "tauri-plugin-mic-recorder-api";

export type CaptureState = "idle" | "recording" | "transcribing";

const MAX_RECORDING_MS = 120_000;

/**
 * Self-contained voice capture for a single component. Unlike `useVoiceInput`
 * (which drives the chat mic) this keeps state LOCAL — no global signal — and
 * registers no global shortcut, so it runs independently of the chat input.
 * `onTranscription` receives the raw transcript when recording stops; the caller
 * decides what to do with it (e.g. structure it into a book page).
 */
export function useVoiceCapture(onTranscription: (text: string) => void | Promise<void>) {
  const [state, setState] = useState<CaptureState>("idle");
  const [error, setError] = useState("");
  // Mirror state in a ref so the async start/stop logic reads the live value
  // (state closures would be stale across the await boundary).
  const stateRef = useRef<CaptureState>("idle");
  const timeoutId = useRef<number | null>(null);
  const onRef = useRef(onTranscription);
  onRef.current = onTranscription;

  const set = useCallback((s: CaptureState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const stop = useCallback(async () => {
    if (timeoutId.current) {
      clearTimeout(timeoutId.current);
      timeoutId.current = null;
    }
    if (stateRef.current !== "recording") return;

    set("transcribing");
    setError("");
    try {
      const filePath = await micStop();
      const text = await transcribeFile(filePath);
      set("idle");
      await onRef.current(text.trim());
    } catch (e) {
      setError(`${e}`);
      set("idle");
    }
  }, [set]);

  const start = useCallback(async () => {
    if (stateRef.current !== "idle") return;
    setError("");
    try {
      await micStart();
      set("recording");
      timeoutId.current = window.setTimeout(stop, MAX_RECORDING_MS);
    } catch (e) {
      setError(`Microphone access failed: ${e}`);
      set("idle");
    }
  }, [set, stop]);

  const toggle = useCallback(() => {
    if (stateRef.current === "recording") stop();
    else if (stateRef.current === "idle") start();
  }, [start, stop]);

  return { state, error, toggle };
}
