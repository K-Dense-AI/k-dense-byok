import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  PromptInputProvider,
  usePromptInputController,
} from "./prompt-input";

function ProviderProbe() {
  const controller = usePromptInputController();
  return (
    <div>
      <span data-testid="draft">{controller.textInput.value}</span>
      <span data-testid="attachments">{controller.attachments.files.length}</span>
      <button
        type="button"
        onClick={() => controller.textInput.setInput("updated draft")}
      >
        Update
      </button>
    </div>
  );
}

describe("PromptInputProvider persistence state", () => {
  it("hydrates and reports draft text and inline attachments", async () => {
    const onStateChange = vi.fn();
    render(
      <PromptInputProvider
        initialInput="restored draft"
        initialAttachments={[
          {
            id: "image-1",
            filename: "figure.png",
            mediaType: "image/png",
            url: "data:image/png;base64,cGl4ZWw=",
          },
        ]}
        onStateChange={onStateChange}
      >
        <ProviderProbe />
      </PromptInputProvider>,
    );

    expect(screen.getByTestId("draft")).toHaveTextContent("restored draft");
    expect(screen.getByTestId("attachments")).toHaveTextContent("1");
    await waitFor(() =>
      expect(onStateChange).toHaveBeenCalledWith({
        text: "restored draft",
        attachments: [
          {
            id: "image-1",
            filename: "figure.png",
            mediaType: "image/png",
            url: "data:image/png;base64,cGl4ZWw=",
          },
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "updated draft" }),
      ),
    );
  });
});
