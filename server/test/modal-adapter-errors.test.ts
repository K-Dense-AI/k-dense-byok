import { describe, expect, it } from "vitest";
import {
  ClientClosedError,
  FunctionTimeoutError,
  InvalidError,
  NotFoundError,
  SandboxFilesystemFileTooLargeError,
  SandboxFilesystemNotFoundError,
  SandboxTimeoutError,
  TimeoutError,
} from "modal";
import { classifyModalError } from "../src/modal/adapter.ts";
import { ModalJobError } from "../src/modal/types.ts";

function grpc(code: number, message: string): Error {
  const error = new Error(message);
  error.name = "ClientError";
  (error as Error & { code: number }).code = code;
  return error;
}

describe("classifyModalError", () => {
  it("passes typed manager errors through untouched", () => {
    const original = new ModalJobError("BUDGET_EXCEEDED", "cap", 402);
    expect(classifyModalError(original)).toBe(original);
  });

  it.each([
    [grpc(16, "UNAUTHENTICATED: token invalid"), "AUTH_FAILED", 401, false],
    [grpc(7, "PERMISSION_DENIED"), "AUTH_FAILED", 401, false],
    [new Error("Token secret is invalid"), "AUTH_FAILED", 401, false],
    [new Error("Image build for im-123 failed with the exception: pip failed"), "IMAGE_BUILD_FAILED", 422, false],
    [new InvalidError("bad gpu string"), "INVALID_REQUEST", 400, false],
    [new NotFoundError("Sandbox sb-1 not found"), "REMOTE_NOT_FOUND", 404, false],
    [Object.assign(new SandboxFilesystemNotFoundError("missing"), {}), "REMOTE_NOT_FOUND", 404, false],
    [new SandboxFilesystemFileTooLargeError("too big"), "OUTPUT_TOO_LARGE", 413, false],
    [new SandboxTimeoutError("sandbox timed out"), "TIMEOUT", 504, true],
    [new FunctionTimeoutError("function timed out"), "TIMEOUT", 504, true],
    [new TimeoutError("deadline"), "TIMEOUT", 504, true],
    [new Error("request timed out after 30s"), "TIMEOUT", 504, true],
    [new ClientClosedError(), "CLIENT_CLOSED", 503, true],
    [new Error("connection reset"), "REMOTE_FAILURE", 502, true],
    ["string failure", "REMOTE_FAILURE", 502, true],
  ])("classifies %s as %s", (error, code, status, retryable) => {
    const classified = classifyModalError(error);
    expect(classified).toBeInstanceOf(ModalJobError);
    expect(classified.code).toBe(code);
    expect(classified.statusCode).toBe(status);
    expect(classified.retryable).toBe(retryable);
    expect(classified.message.length).toBeGreaterThan(0);
  });
});
