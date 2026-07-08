// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  buildNotificationDetail,
  handleSubagentForwarding,
  registerAskQuestionBridge,
} from "../src/ask-question-bridge.js";
import { _resetUiBridgeState } from "../src/snippets/vendored/subscribe-to-subagent-ui-bridge.js";

// Mock subscribe-to-notifications to control withAttention
vi.mock("../src/snippets/vendored/subscribe-to-notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/snippets/vendored/subscribe-to-notifications.js")>();
  return {
    ...actual,
    withAttention: vi.fn((_source: string, _detail: string, fn: () => Promise<unknown>) => fn()),
  };
});

// Mock renderQuestionsViaUI so askHandler tests can control the return value
vi.mock("../src/component.js", () => ({
  renderQuestionsViaUI: vi.fn().mockResolvedValue(null),
}));

import { renderQuestionsViaUI } from "../src/component.js";

type SendAndWaitFn = (options: {
  contentType: string;
  payload: Record<string, unknown>;
  text: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<{ payload: unknown }>;

beforeEach(() => {
  delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
  delete process.env.PI_SUBAGENT_PARENT_PID;
  delete (globalThis as { __avtcPiAskUserQuestionWired?: boolean }).__avtcPiAskUserQuestionWired;
  _resetUiBridgeState();
  vi.mocked(renderQuestionsViaUI).mockReset().mockResolvedValue(null);
});

/** Helper: register hooks with a mock pi that fires ready immediately with a mock sendAndWait. */
function initBridgeWithMockSendAndWait(sendAndWait: SendAndWaitFn): {
  mockPi: ExtensionAPI;
  registerHandler: ReturnType<typeof vi.fn>;
} {
  const registerHandler = vi.fn();
  let capturedHandler: ((data: unknown) => void) | null = null;

  const mockPi = {
    on: vi.fn(() => () => {}),
    events: {
      on: vi.fn((_event: string, handler: (data: unknown) => void) => {
        capturedHandler = handler;
        return () => {};
      }),
      emit: vi.fn(),
    },
  };

  registerAskQuestionBridge(mockPi as unknown as ExtensionAPI);

  // Trigger events.on to capture the handler (registerAskQuestionBridge calls events.on)
  const handler = capturedHandler as ((data: unknown) => void) | null;
  if (handler) {
    handler({
      registerHandler,
      sendAndWait,
    });
  }

  return { mockPi: mockPi as unknown as ExtensionAPI, registerHandler };
}

const SAMPLE_QUESTIONS = [
  {
    question: "Which framework?",
    header: "Framework",
    options: [{ label: "React" }, { label: "Vue" }],
    multiSelect: false,
  },
];

test("registerAskQuestionBridge registers handler on pi-subagent-ui-bridge:ready event", () => {
  const emitted: { event: string; data: unknown }[] = [];
  const mockPi = {
    on: () => () => {},
    events: {
      on: (event: string, _handler: (data: unknown) => void) => {
        emitted.push({ event, data: null });
        return () => {};
      },
      emit: () => {},
    },
  };

  registerAskQuestionBridge(mockPi as unknown as ExtensionAPI);

  expect(emitted.length).toBe(1);
  expect(emitted[0]?.event).toBe("pi-subagent-ui-bridge:ready");
});

test("handleSubagentForwarding returns null when not in subagent context", async () => {
  const result = await handleSubagentForwarding(
    {
      questions: SAMPLE_QUESTIONS,
    },
    undefined,
  );

  expect(result).toBeNull();
});

test("handleSubagentForwarding returns null when sendAndWait not available", async () => {
  process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET = "test-socket";

  try {
    const result = await handleSubagentForwarding(
      {
        questions: SAMPLE_QUESTIONS,
      },
      undefined,
    );

    expect(result).toBeNull();
  } finally {
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
  }
});

test("handleSubagentForwarding returns formatted summary on success", async () => {
  process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET = "test-socket";

  const mockResult: import("../src/schema.js").Result = {
    questions: SAMPLE_QUESTIONS,
    answers: { "Which framework?": "React" },
    cancelled: false,
  };

  const mockSendAndWait = vi.fn().mockResolvedValue({
    payload: mockResult,
  });

  initBridgeWithMockSendAndWait(mockSendAndWait as unknown as SendAndWaitFn);

  try {
    const result = await handleSubagentForwarding(
      {
        questions: SAMPLE_QUESTIONS,
      },
      undefined,
    );

    expect(result).not.toBeNull();
    expect(result?.isError).toBeUndefined();
    expect(result?.details).toEqual(mockResult);
    expect(result?.content).toEqual([{ type: "text", text: '"Which framework?" = "React"' }]);

    // Verify sendAndWait was called correctly
    expect(mockSendAndWait).toHaveBeenCalledOnce();
    expect(mockSendAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "ask_user_question",
        text: expect.stringContaining("1 question"),
      }),
    );
  } finally {
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
  }
});

test("handleSubagentForwarding propagates sendAndWait rejection", async () => {
  process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET = "test-socket";

  const mockSendAndWait = vi.fn().mockRejectedValue(new Error("Connection refused"));

  initBridgeWithMockSendAndWait(mockSendAndWait as unknown as SendAndWaitFn);

  try {
    await expect(
      handleSubagentForwarding(
        {
          questions: SAMPLE_QUESTIONS,
        },
        undefined,
      ),
    ).rejects.toThrow("Connection refused");

    expect(mockSendAndWait).toHaveBeenCalledOnce();
  } finally {
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
  }
});

test("handleSubagentForwarding propagates server error response", async () => {
  process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET = "test-socket";

  // Simulate server sending error response (e.g., handler threw, timed out, etc.)
  const mockSendAndWait = vi.fn().mockRejectedValue(new Error("Internal handler error"));

  initBridgeWithMockSendAndWait(mockSendAndWait as unknown as SendAndWaitFn);

  try {
    await expect(
      handleSubagentForwarding(
        {
          questions: SAMPLE_QUESTIONS,
        },
        undefined,
      ),
    ).rejects.toThrow("Internal handler error");

    expect(mockSendAndWait).toHaveBeenCalledOnce();
  } finally {
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
  }
});

test("handleSubagentForwarding returns cancelled result when user cancels", async () => {
  process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET = "test-socket";

  const mockResult: import("../src/schema.js").Result = {
    questions: SAMPLE_QUESTIONS,
    answers: {},
    cancelled: true,
  };

  const mockSendAndWait = vi.fn().mockResolvedValue({
    payload: mockResult,
  });

  initBridgeWithMockSendAndWait(mockSendAndWait as unknown as SendAndWaitFn);

  try {
    const result = await handleSubagentForwarding(
      {
        questions: SAMPLE_QUESTIONS,
      },
      undefined,
    );

    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ type: "text", text: "User cancelled" }]);
    expect(result?.details.cancelled).toBe(true);
  } finally {
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
  }
});

// ── askHandler guard path tests ──────────────────────────────────────────────

/** Helper: capture the askHandler registered via registerHandler. */
function captureAskHandler(): {
  mockPi: ExtensionAPI;
  registerHandler: ReturnType<typeof vi.fn>;
  getHandler: () => ((input: unknown) => Promise<unknown>) | null;
} {
  const registerHandler = vi.fn();
  let capturedHandler: ((input: unknown) => Promise<unknown>) | null = null;
  let capturedReadyHandler: ((data: unknown) => void) | null = null;

  const mockPi = {
    on: vi.fn(() => () => {}),
    events: {
      on: vi.fn((_event: string, handler: (data: unknown) => void) => {
        capturedReadyHandler = handler;
        return () => {};
      }),
      emit: vi.fn(),
    },
  };

  registerAskQuestionBridge(mockPi as unknown as ExtensionAPI);

  // Fire the ready event to trigger registerHandler call
  const readyHandler = capturedReadyHandler as ((data: unknown) => void) | null;
  if (readyHandler) {
    readyHandler({
      registerHandler: (_contentType: string, handler: (input: unknown) => Promise<unknown>) => {
        capturedHandler = handler;
      },
      sendAndWait: undefined,
    });
  }

  return {
    mockPi: mockPi as unknown as ExtensionAPI,
    registerHandler,
    getHandler: () => capturedHandler,
  };
}

test("askHandler returns CANCELLED_RESULT when ctx.hasUI is false", async () => {
  const { getHandler } = captureAskHandler();
  const handler = getHandler();
  expect(handler).not.toBeNull();

  const result = await handler?.({
    ctx: { hasUI: false },
    clientId: "test-client",
    contentType: "ask_user_question",
    payload: { questions: SAMPLE_QUESTIONS },
    meta: {},
  });

  expect(result).toEqual({
    questions: [],
    answers: {},
    cancelled: true,
  });
});

test("askHandler returns CANCELLED_RESULT when questions array is empty", async () => {
  const { getHandler } = captureAskHandler();
  const handler = getHandler();
  expect(handler).not.toBeNull();

  const result = await handler?.({
    ctx: { hasUI: true },
    clientId: "test-client",
    contentType: "ask_user_question",
    payload: { questions: [] },
    meta: {},
  });

  expect(result).toEqual({
    questions: [],
    answers: {},
    cancelled: true,
  });
});

test("askHandler returns CANCELLED_RESULT when questions is undefined", async () => {
  const { getHandler } = captureAskHandler();
  const handler = getHandler();
  expect(handler).not.toBeNull();

  const result = await handler?.({
    ctx: { hasUI: true },
    clientId: "test-client",
    contentType: "ask_user_question",
    payload: {},
    meta: {},
  });

  expect(result).toEqual({
    questions: [],
    answers: {},
    cancelled: true,
  });
});

test("askHandler returns CANCELLED_RESULT when renderQuestionsViaUI returns null", async () => {
  // renderQuestionsViaUI already returns null by default (mockReset in beforeEach)
  const { getHandler } = captureAskHandler();
  const handler = getHandler();
  expect(handler).not.toBeNull();

  const result = await handler?.({
    ctx: { hasUI: true },
    clientId: "test-client",
    contentType: "ask_user_question",
    payload: { questions: SAMPLE_QUESTIONS },
    meta: {},
  });

  expect(result).toEqual({
    questions: [],
    answers: {},
    cancelled: true,
  });
});

test("askHandler returns result from renderQuestionsViaUI on success", async () => {
  const expectedResult: import("../src/schema.js").Result = {
    questions: SAMPLE_QUESTIONS,
    answers: { "Which framework?": "React" },
    cancelled: false,
  };

  vi.mocked(renderQuestionsViaUI).mockResolvedValue(expectedResult);

  const { getHandler } = captureAskHandler();
  const handler = getHandler();
  expect(handler).not.toBeNull();

  const result = await handler?.({
    ctx: { hasUI: true },
    clientId: "test-client",
    contentType: "ask_user_question",
    payload: { questions: SAMPLE_QUESTIONS },
    meta: {},
  });

  expect(result).toEqual(expectedResult);
});

test("handleSubagentForwarding handles null payload from server", async () => {
  process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET = "test-socket";

  // Server returns null payload (e.g., handler error or no response)
  const mockSendAndWait = vi.fn().mockResolvedValue({
    payload: null,
  });

  initBridgeWithMockSendAndWait(mockSendAndWait as unknown as SendAndWaitFn);

  try {
    const result = await handleSubagentForwarding(
      {
        questions: SAMPLE_QUESTIONS,
      },
      undefined,
    );

    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ type: "text", text: "User cancelled" }]);
    expect(result?.details.cancelled).toBe(true);
  } finally {
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
  }
});

test("handleSubagentForwarding handles undefined payload from server", async () => {
  process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET = "test-socket";

  // Server returns undefined payload
  const mockSendAndWait = vi.fn().mockResolvedValue({
    payload: undefined,
  });

  initBridgeWithMockSendAndWait(mockSendAndWait as unknown as SendAndWaitFn);

  try {
    const result = await handleSubagentForwarding(
      {
        questions: SAMPLE_QUESTIONS,
      },
      undefined,
    );

    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ type: "text", text: "User cancelled" }]);
    expect(result?.details.cancelled).toBe(true);
  } finally {
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
  }
});

// ── buildNotificationDetail tests ────────────────────────────────────────────

describe("buildNotificationDetail", () => {
  const questions = [
    {
      question: "Which framework?",
      header: "Framework",
      options: [{ label: "React" }, { label: "Vue" }],
      multiSelect: false,
    },
  ];

  it("returns question summary without context when no message provided", () => {
    const result = buildNotificationDetail(questions, undefined);
    expect(result).toBe("Framework: Which framework? [React | Vue]");
  });

  it("returns question summary with IPC message context", () => {
    const result = buildNotificationDetail(questions, "I need to decide on a framework");
    expect(result).toBe("Framework: Which framework? [React | Vue]\nI need to decide on a framework");
  });
});

// ── withCoordinator integration: askHandler queues when coordinator active ──

describe("askHandler dialog coordinator integration", () => {
  beforeEach(() => {
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
    vi.mocked(renderQuestionsViaUI).mockReset().mockResolvedValue(null);
  });

  test("askHandler queues via withCoordinator when coordinator is in active mode", async () => {
    // Import DialogCoordinator from avtc-pi-ui-components (the singleton owner)
    // We test via the forwarding module's _coordinator reference
    const { subscribeToDialogCoordinator, _resetState } = await import(
      "../src/snippets/vendored/subscribe-to-dialog-coordinator.js"
    );
    _resetState();

    // Create a mock coordinator that tracks queuing
    let queuedFn: (() => Promise<unknown>) | null = null;
    const mockCoordinator = {
      enqueueOrShow: vi.fn(<T>(fn: () => Promise<T>): Promise<T> => {
        // Simulate queuing — store fn, return a promise that resolves when flushed
        return new Promise<T>((resolve) => {
          queuedFn = async () => {
            const result = await fn();
            resolve(result);
          };
        });
      }),
    };

    // Subscribe with mock coordinator
    const mockPi = {
      on: vi.fn(() => () => {}),
      events: {
        on: vi.fn((_event: string, handler: (data: unknown) => void) => {
          if (_event === "dialog-coordinator:ready") {
            handler({ coordinator: mockCoordinator });
          }
          return () => {};
        }),
      },
    };
    subscribeToDialogCoordinator(mockPi as unknown as ExtensionAPI);

    // Now capture the askHandler
    const { registerAskQuestionBridge } = await import("../src/ask-question-bridge.js");
    let askHandler: ((input: unknown) => Promise<unknown>) | null = null;
    const pi2 = {
      on: vi.fn(() => () => {}),
      events: {
        on: vi.fn((_event: string, handler: (data: unknown) => void) => {
          handler({
            registerHandler: (_ct: string, h: (input: unknown) => Promise<unknown>) => {
              askHandler = h;
            },
            sendAndWait: undefined,
          });
          return () => {};
        }),
      },
    };
    registerAskQuestionBridge(pi2 as unknown as ExtensionAPI);
    expect(askHandler).not.toBeNull();

    // Mock renderQuestionsViaUI to return a result
    const expectedResult = {
      questions: SAMPLE_QUESTIONS,
      answers: { "Which framework?": "React" },
      cancelled: false,
    };
    vi.mocked(renderQuestionsViaUI).mockResolvedValue(expectedResult);

    // Call askHandler — should be queued (not rendered yet)
    expect(askHandler).not.toBeNull();
    const resultPromise = (askHandler as unknown as (data: unknown) => void)({
      ctx: { hasUI: true },
      clientId: "test",
      contentType: "ask_user_question",
      payload: { questions: SAMPLE_QUESTIONS },
      meta: {},
    });

    // Coordinator.enqueueOrShow should have been called
    expect(mockCoordinator.enqueueOrShow).toHaveBeenCalled();

    // Flush the queue
    expect(queuedFn).not.toBeNull();
    await (queuedFn as unknown as () => Promise<unknown>)();

    const result = await resultPromise;
    expect(result).toEqual(expectedResult);

    _resetState();
  });
});

// ── tool execute path: RPC child (hasUI=true) must still forward via bridge ──

describe("ask_user_question tool execute: hasUI=true forwards via bridge (rpc child)", () => {
  // Mock the UI render + notification hooks so the execute path is isolated to routing logic.
  // (These mocks are already active from the top of this file for renderQuestionsViaUI +
  //  withAttention; we additionally need a mock pi that captures the registered tool.)

  function captureTool() {
    let captured: { execute: (...args: unknown[]) => Promise<unknown> } | null = null;
    const mockPi = {
      on: vi.fn(() => () => {}),
      events: { on: vi.fn(() => () => {}), emit: vi.fn() },
      registerTool: vi.fn((t: { execute: (...args: unknown[]) => Promise<unknown> }) => {
        captured = t;
      }),
      setActiveTools: vi.fn(),
      getActiveTools: vi.fn(() => ["ask_user_question"]),
    };
    return {
      mockPi,
      getTool: () => captured,
    };
  }

  beforeEach(() => {
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
    _resetUiBridgeState();
    vi.mocked(renderQuestionsViaUI).mockReset().mockResolvedValue(null);
  });

  it("hasUI=true + bridge available → forwards (returns forwarded result, no local render)", async () => {
    process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET = "/tmp/fake-socket";
    // Wire the bridge sendAndWait to a canned forwarded Result payload.
    const forwardedResult = {
      questions: SAMPLE_QUESTIONS,
      answers: { "Which framework?": "React" },
      cancelled: false,
    };
    const sendAndWait = vi.fn().mockResolvedValue({ payload: forwardedResult });
    (globalThis as Record<string, unknown>).__piSubagentUiBridgeForwarding = { sendAndWait };

    const { mockPi, getTool } = captureTool();
    const extension = (await import("../src/index.js")).default;
    extension(mockPi as unknown as ExtensionAPI);
    const tool = getTool();
    expect(tool).not.toBeNull();

    const result = (await tool?.execute("call-1", { questions: SAMPLE_QUESTIONS }, undefined, undefined, {
      hasUI: true,
    })) as { content: Array<{ text: string }> } | undefined;
    expect(tool).toBeDefined();

    // Forwarded via the bridge (sendAndWait called); local renderQuestionsViaUI was NOT.
    expect(sendAndWait).toHaveBeenCalledTimes(1);
    expect(renderQuestionsViaUI).not.toHaveBeenCalled();
    // The forwarded answer surfaces in the summary text.
    expect(result?.content[0].text).toContain("React");

    delete (globalThis as Record<string, unknown>).__piSubagentUiBridgeForwarding;
  });

  it("hasUI=true + mode=tui + NO bridge → local render (root session)", async () => {
    // No env / no sendAndWait → bridge unavailable. A root TUI session (mode=tui) must fall through
    // to LOCAL render.
    const { mockPi, getTool } = captureTool();
    const extension = (await import("../src/index.js")).default;
    extension(mockPi as unknown as ExtensionAPI);
    const tool = getTool();
    expect(tool).not.toBeNull();

    await tool?.execute("call-1", { questions: SAMPLE_QUESTIONS }, undefined, undefined, {
      hasUI: true,
      mode: "tui",
    } as unknown as ExtensionContext);

    // Local render was attempted (renderQuestionsViaUI called), NOT disabled.
    expect(tool).toBeDefined();
    expect(renderQuestionsViaUI).toHaveBeenCalledTimes(1);
    expect(mockPi.setActiveTools).not.toHaveBeenCalled(); // not disabled
  });

  it("hasUI=true + mode=rpc + NO bridge → tool disabled (rpc subagent)", async () => {
    // No env / no sendAndWait → bridge unavailable. An RPC subagent (mode=rpc, hasUI=true)
    // must NOT fall through to local render — the tool returns cancelled.
    const { mockPi, getTool } = captureTool();
    const extension = (await import("../src/index.js")).default;
    extension(mockPi as unknown as ExtensionAPI);
    const tool = getTool();
    expect(tool).not.toBeNull();

    const result = (await tool?.execute("call-1", { questions: SAMPLE_QUESTIONS }, undefined, undefined, {
      hasUI: true,
      mode: "rpc",
    } as unknown as ExtensionContext)) as { details?: { cancelled?: boolean } } | undefined;

    // Tool was disabled (no local render, no bridge forwarding).
    expect(renderQuestionsViaUI).not.toHaveBeenCalled();
    expect(result?.details?.cancelled).toBe(true);
  });
});
