import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechInput } from "@/components/ai-elements/speech-input";

class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  state: RecordingState = "inactive";
  readonly mimeType = "audio/mp4;codecs=mp4a.40.2";

  constructor(readonly stream: MediaStream) {
    super();
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    if (this.state !== "recording") return;
    this.state = "inactive";
    const dataEvent = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(dataEvent, "data", {
      value: new Blob(["audio"], { type: this.mimeType }),
    });
    this.dispatchEvent(dataEvent);
    this.dispatchEvent(new Event("stop"));
  }
}

const mediaRecorderDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "MediaRecorder",
);
const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);
const speechRecognitionDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "SpeechRecognition",
);
const webkitSpeechRecognitionDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "webkitSpeechRecognition",
);

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

describe("SpeechInput MediaRecorder fallback", () => {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);

  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    track.stop.mockClear();
    getUserMedia.mockClear();
    Reflect.deleteProperty(window, "SpeechRecognition");
    Reflect.deleteProperty(window, "webkitSpeechRecognition");
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
  });

  afterEach(() => {
    restoreProperty(globalThis, "MediaRecorder", mediaRecorderDescriptor);
    restoreProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
    restoreProperty(window, "SpeechRecognition", speechRecognitionDescriptor);
    restoreProperty(
      window,
      "webkitSpeechRecognition",
      webkitSpeechRecognitionDescriptor,
    );
  });

  it("records with the browser MIME type and inserts the provider transcript", async () => {
    const onAudioRecorded = vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe("audio/mp4;codecs=mp4a.40.2");
      return "hello from audio";
    });
    const onTranscriptionChange = vi.fn();
    render(
      <SpeechInput
        onAudioRecorded={onAudioRecorded}
        onTranscriptionChange={onTranscriptionChange}
      />,
    );

    const button = await screen.findByRole("button", {
      name: "Hold to dictate",
    });
    fireEvent.pointerDown(button, { button: 0 });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    fireEvent.pointerUp(button, { button: 0 });

    await waitFor(() =>
      expect(onTranscriptionChange).toHaveBeenCalledWith("hello from audio"),
    );
    expect(track.stop).toHaveBeenCalled();
  });

  it("explains unavailability when no transcription callback is configured", async () => {
    render(<SpeechInput />);
    const button = await screen.findByRole("button", {
      name: "Dictation unavailable",
    });
    expect(button).toBeDisabled();
  });

  it("does not begin recording if hold is released while permission is pending", async () => {
    let resolvePermission!: (value: MediaStream) => void;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const onAudioRecorded = vi.fn(async () => "unused");
    render(<SpeechInput onAudioRecorded={onAudioRecorded} />);

    const button = await screen.findByRole("button", {
      name: "Hold to dictate",
    });
    fireEvent.pointerDown(button, { button: 0 });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    fireEvent.pointerUp(button, { button: 0 });
    resolvePermission(stream);

    await waitFor(() => expect(track.stop).toHaveBeenCalled());
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(onAudioRecorded).not.toHaveBeenCalled();
  });
});
