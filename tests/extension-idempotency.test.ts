// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "../src/index.js";

const WIRED_KEY = "__avtcPiAskUserQuestionWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

/** Mock pi exposing every method the entry touches plus registerCommand. */
function createMockPi(): ExtensionAPI {
  return {
    on: vi.fn(() => () => {}),
    events: {
      on: vi.fn(() => () => {}),
      emit: vi.fn(),
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
  } as unknown as ExtensionAPI;
}

beforeEach(() => {
  delete (globalThis as GlobalWithWired)[WIRED_KEY];
});

afterEach(() => {
  delete (globalThis as GlobalWithWired)[WIRED_KEY];
});

describe("entry idempotency guard", () => {
  it("wires on first call without throwing", () => {
    const pi = createMockPi();
    expect(() => entry(pi)).not.toThrow();
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
  });

  it("second call no-ops without throwing", () => {
    const pi = createMockPi();
    entry(pi);
    expect(() => entry(pi)).not.toThrow();
    // Still only registered once — the second call is a no-op.
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
  });

  it("sets the globalThis flag", () => {
    const pi = createMockPi();
    entry(pi);
    expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(true);
  });

  it("re-wires after session_shutdown (reload-safe)", () => {
    // Capture shutdown handlers registered via pi.on so we can simulate a /reload.
    const shutdownHandlers: Array<() => void> = [];
    const pi = {
      ...createMockPi(),
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "session_shutdown") shutdownHandlers.push(cb);
        return () => {};
      }),
    } as unknown as ExtensionAPI;

    // First call wires and registers the tool once.
    entry(pi);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(true);

    // Second call is a no-op — flag is still set, tool still registered once.
    entry(pi);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);

    // Fire shutdown handlers — the flag must reset so a reload can re-wire.
    expect(shutdownHandlers.length).toBeGreaterThan(0);
    for (const handler of shutdownHandlers) handler();
    expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(false);

    // Third call re-wires after shutdown — tool registered a second time total.
    entry(pi);
    expect(pi.registerTool).toHaveBeenCalledTimes(2);
    expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(true);
  });
});
