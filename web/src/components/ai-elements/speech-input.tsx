"use client";

import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { MicIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
    | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
    | null;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

export type SpeechInputMode =
  | "detecting"
  | "speech-recognition"
  | "media-recorder"
  | "none";

export type SpeechInputProps = ComponentProps<typeof Button> & {
  onTranscriptionChange?: (text: string) => void;
  /**
   * Callback for when audio is recorded using MediaRecorder fallback.
   * This is called in browsers that don't support the Web Speech API (Firefox, Safari).
   * The callback receives an audio Blob that should be sent to a transcription service.
   * Return the transcribed text, which will be passed to onTranscriptionChange.
   */
  onAudioRecorded?: (audioBlob: Blob) => Promise<string>;
  onModeChange?: (mode: SpeechInputMode) => void;
  onSpeechError?: (message: string) => void;
  lang?: string;
};

export const detectSpeechInputMode = (): Exclude<SpeechInputMode, "detecting"> => {
  if (typeof window === "undefined") {
    return "none";
  }

  if ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) {
    return "speech-recognition";
  }

  if ("MediaRecorder" in window && "mediaDevices" in navigator) {
    return "media-recorder";
  }

  return "none";
};

function speechRecognitionErrorMessage(error: string): string | null {
  switch (error) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied. Allow microphone access and try again.";
    case "audio-capture":
      return "No microphone is available.";
    case "network":
      return "Speech recognition could not reach its service.";
    case "no-speech":
      return "No speech was detected.";
    default:
      return "Dictation could not be started.";
  }
}

export const SpeechInput = ({
  className,
  onTranscriptionChange,
  onAudioRecorded,
  onModeChange,
  onSpeechError,
  lang = "en-US",
  disabled: disabledProp,
  onPointerDown: onPointerDownProp,
  onPointerUp: onPointerUpProp,
  onPointerCancel: onPointerCancelProp,
  onKeyDown: onKeyDownProp,
  onKeyUp: onKeyUpProp,
  ...buttonProps
}: SpeechInputProps) => {
  const [isListening, setIsListening] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [mode, setMode] = useState<SpeechInputMode>("detecting");
  const [isRecognitionReady, setIsRecognitionReady] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const isHoldingRef = useRef(false);
  const onTranscriptionChangeRef = useRef<
    SpeechInputProps["onTranscriptionChange"]
  >(onTranscriptionChange);
  const onAudioRecordedRef =
    useRef<SpeechInputProps["onAudioRecorded"]>(onAudioRecorded);
  const onErrorRef =
    useRef<SpeechInputProps["onSpeechError"]>(onSpeechError);

  // Keep refs in sync
  onTranscriptionChangeRef.current = onTranscriptionChange;
  onAudioRecordedRef.current = onAudioRecorded;
  onErrorRef.current = onSpeechError;

  // Declared before the recorder cleanup so it flips first: unmounting stops
  // the recorder, whose stop handler would otherwise fire a transcription
  // request whose result has nowhere to go.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Detect browser-only APIs after hydration so server and client initially
  // render the same disabled button.
  useEffect(() => {
    setMode(detectSpeechInputMode());
  }, []);

  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  // Initialize Speech Recognition when mode is speech-recognition
  useEffect(() => {
    if (mode !== "speech-recognition") {
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    let speechRecognition: SpeechRecognition;
    try {
      speechRecognition = new SpeechRecognition();
    } catch {
      setMode(
        "MediaRecorder" in window && "mediaDevices" in navigator
          ? "media-recorder"
          : "none",
      );
      onErrorRef.current?.("Speech recognition is unavailable in this browser.");
      return;
    }

    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = lang;

    const handleStart = () => {
      if (!isHoldingRef.current) {
        speechRecognition.stop();
        return;
      }
      setIsListening(true);
    };

    const handleEnd = () => {
      setIsListening(false);
    };

    const handleResult = (event: Event) => {
      const speechEvent = event as SpeechRecognitionEvent;
      let finalTranscript = "";

      for (
        let i = speechEvent.resultIndex;
        i < speechEvent.results.length;
        i += 1
      ) {
        const result = speechEvent.results[i];
        if (result.isFinal) {
          finalTranscript += result[0]?.transcript ?? "";
        }
      }

      if (finalTranscript) {
        onTranscriptionChangeRef.current?.(finalTranscript);
      }
    };

    const handleError = (event: Event) => {
      setIsListening(false);
      const error = (event as SpeechRecognitionErrorEvent).error;
      const canUseRecordedFallback =
        (error === "service-not-allowed" ||
          error === "language-not-supported") &&
        "MediaRecorder" in window &&
        "mediaDevices" in navigator &&
        Boolean(onAudioRecordedRef.current);
      if (canUseRecordedFallback) {
        setMode("media-recorder");
        onErrorRef.current?.(
          "Browser speech recognition is unavailable. Hold again to use recorded transcription.",
        );
        return;
      }
      const message = speechRecognitionErrorMessage(error);
      if (message) onErrorRef.current?.(message);
    };

    speechRecognition.addEventListener("start", handleStart);
    speechRecognition.addEventListener("end", handleEnd);
    speechRecognition.addEventListener("result", handleResult);
    speechRecognition.addEventListener("error", handleError);

    recognitionRef.current = speechRecognition;
    setIsRecognitionReady(true);

    return () => {
      speechRecognition.removeEventListener("start", handleStart);
      speechRecognition.removeEventListener("end", handleEnd);
      speechRecognition.removeEventListener("result", handleResult);
      speechRecognition.removeEventListener("error", handleError);
      try {
        speechRecognition.stop();
      } catch {
        // Some implementations throw when stop() is called before start().
      }
      recognitionRef.current = null;
      setIsRecognitionReady(false);
    };
  }, [mode, lang]);

  // Cleanup MediaRecorder and stream on unmount
  useEffect(
    () => () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
      }
    },
    []
  );

  // Start MediaRecorder recording
  const startMediaRecorder = useCallback(async () => {
    if (!onAudioRecordedRef.current) {
      return;
    }

    setIsStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isHoldingRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      const handleDataAvailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      const handleStop = async () => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
        mediaRecorderRef.current = null;
        if (!mountedRef.current) return;
        setIsListening(false);

        const audioBlob = new Blob(audioChunksRef.current, {
          type:
            mediaRecorder.mimeType ||
            audioChunksRef.current[0]?.type ||
            "application/octet-stream",
        });

        if (audioBlob.size > 0 && onAudioRecordedRef.current) {
          setIsProcessing(true);
          try {
            const transcript = await onAudioRecordedRef.current(audioBlob);
            if (transcript && mountedRef.current) {
              onTranscriptionChangeRef.current?.(transcript);
            }
          } catch (error) {
            if (mountedRef.current) {
              onErrorRef.current?.(
                error instanceof Error ? error.message : "Dictation could not be transcribed.",
              );
            }
          } finally {
            if (mountedRef.current) setIsProcessing(false);
          }
        }
      };

      const handleError = () => {
        setIsListening(false);
        for (const track of stream.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
        mediaRecorderRef.current = null;
        onErrorRef.current?.("The microphone stopped recording unexpectedly.");
      };

      mediaRecorder.addEventListener("dataavailable", handleDataAvailable);
      mediaRecorder.addEventListener("stop", handleStop);
      mediaRecorder.addEventListener("error", handleError);

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsListening(true);
    } catch (error) {
      setIsListening(false);
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) track.stop();
        streamRef.current = null;
      }
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone access was denied. Allow microphone access and try again."
          : "The microphone could not be started.";
      onErrorRef.current?.(message);
    } finally {
      setIsStarting(false);
    }
  }, []);

  // Stop MediaRecorder recording
  const stopMediaRecorder = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsListening(false);
  }, []);

  const startListening = useCallback(() => {
    if (isListening || isStarting || isProcessing) return;
    if (mode === "speech-recognition" && recognitionRef.current) {
      try {
        recognitionRef.current.start();
      } catch {
        onErrorRef.current?.("Dictation could not be started.");
      }
    } else if (mode === "media-recorder") {
      void startMediaRecorder();
    }
  }, [mode, isListening, isStarting, isProcessing, startMediaRecorder]);

  const stopListening = useCallback(() => {
    if (mode === "speech-recognition" && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped.
      }
    } else if (mode === "media-recorder") {
      stopMediaRecorder();
    }
  }, [mode, stopMediaRecorder]);

  // Global pointerup to catch release even when pointer leaves the button
  useEffect(() => {
    if (!(isListening || isStarting)) return;

    const handleGlobalPointerUp = () => {
      isHoldingRef.current = false;
      stopListening();
    };

    document.addEventListener("pointerup", handleGlobalPointerUp);
    document.addEventListener("pointercancel", handleGlobalPointerUp);
    return () => {
      document.removeEventListener("pointerup", handleGlobalPointerUp);
      document.removeEventListener("pointercancel", handleGlobalPointerUp);
    };
  }, [isListening, isStarting, stopListening]);

  // Determine if button should be disabled
  const isDisabled =
    Boolean(disabledProp) ||
    mode === "detecting" ||
    mode === "none" ||
    (mode === "speech-recognition" && !isRecognitionReady) ||
    (mode === "media-recorder" && !onAudioRecorded) ||
    isProcessing;
  const ariaLabel =
    buttonProps["aria-label"] ??
    (isProcessing
      ? "Transcribing dictation"
      : isListening
        ? "Release to stop dictation"
        : isDisabled
          ? "Dictation unavailable"
          : "Hold to dictate");

  const release = () => {
    isHoldingRef.current = false;
    stopListening();
  };

  return (
    <div className="relative inline-flex items-center justify-center">
      {/* Animated pulse rings */}
      {isListening &&
        [0, 1, 2].map((index) => (
          <div
            className="absolute inset-0 animate-ping rounded-full border-2 border-red-400/30"
            key={index}
            style={{
              animationDelay: `${index * 0.3}s`,
              animationDuration: "2s",
            }}
          />
        ))}

      {/* Main record button — hold to talk */}
      <Button
        {...buttonProps}
        className={cn(
          "relative z-10 rounded-full transition-all duration-300 select-none touch-none",
          isListening
            ? "bg-destructive text-white hover:bg-destructive/80 hover:text-white"
            : "bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground",
          className
        )}
        disabled={isDisabled}
        aria-label={ariaLabel}
        onPointerDown={(e) => {
          onPointerDownProp?.(e);
          if (e.defaultPrevented || e.button !== 0) return;
          e.preventDefault();
          isHoldingRef.current = true;
          startListening();
        }}
        onPointerUp={(e) => {
          onPointerUpProp?.(e);
          release();
        }}
        onPointerCancel={(e) => {
          onPointerCancelProp?.(e);
          release();
        }}
        onKeyDown={(e) => {
          onKeyDownProp?.(e);
          if (
            e.defaultPrevented ||
            e.repeat ||
            (e.key !== " " && e.key !== "Enter")
          ) {
            return;
          }
          e.preventDefault();
          isHoldingRef.current = true;
          startListening();
        }}
        onKeyUp={(e) => {
          onKeyUpProp?.(e);
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          release();
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {(isStarting || isProcessing) && <Spinner />}
        {!(isStarting || isProcessing) && isListening && (
          <SquareIcon className="size-4" />
        )}
        {!(isStarting || isProcessing || isListening) && (
          <MicIcon className="size-4" />
        )}
      </Button>
    </div>
  );
};
