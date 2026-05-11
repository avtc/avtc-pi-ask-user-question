/**
 * Intercom integration for ask_user_question.
 *
 * Root-side: registers a handler via pi.events to render questions from subagents.
 * Child-side: forwards questions to root session via sendAndWait.
 * Message renderer: displays answered questions in root session history.
 *
 * Wire format uses the same Result type as AskUserQuestionComponent — no conversion needed.
 * No direct import of pi-intercom is needed — everything flows through pi.events.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box } from "@mariozechner/pi-tui";
import type { Question, Result } from "./schema.ts";
import { renderQuestionsViaUI } from "./component.ts";

// Track pi.events listeners for cleanup on reload.
// globalThis survives module re-import during /reload.
const _gt = globalThis as { __piAskUserQuestionHookUnsubs?: Array<() => void> };
const _hookUnsubs = _gt.__piAskUserQuestionHookUnsubs ??= [];

// Stored reference to sendAndWait from pi-intercom (set during init)
let _sendAndWait: ((options: {
  contentType: string;
  payload: Record<string, unknown>;
  text: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<{ text: string }>) | null = null;

/**
 * Register intercom hooks for ask_user_question extension.
 * Call once during extension initialization.
 */
export function registerIntercomHooks(pi: ExtensionAPI): void {
  // Root-side handler: render questions from subagents
  const askHandler = async (
    ctx: any,
    _from: any,
    message: { payload?: any },
  ) => {
    if (!ctx.hasUI) return undefined;
    const payload = message.payload as { questions?: Question[] };
    if (!payload?.questions?.length) return undefined;

    const result = await renderQuestionsViaUI(payload.questions, ctx);
    if (!result) return { text: JSON.stringify({ cancelled: true } satisfies Result) };
    return { text: JSON.stringify(result) };
  };

  // Single-path: listen for intercom:ready (emitted by pi-intercom in session_start,
  // after all extensions have loaded). Register handler and capture sendAndWait.
  for (const unsub of _hookUnsubs) unsub();
  _hookUnsubs.length = 0;
  _hookUnsubs.push(pi.events.on("intercom:ready", (data: unknown) => {
    const api = data as {
      registerHandler: (contentType: string, handler: any) => void;
      sendAndWait?: (options: { contentType: string; payload: Record<string, unknown>; text: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<{ text: string }>;
    };
    if (typeof api.registerHandler === "function") {
      api.registerHandler("ask_user_question", askHandler);
    }
    if (typeof api.sendAndWait === "function") {
      _sendAndWait = api.sendAndWait;
    }
  }));

  // Message renderer: display answered questions in root session history
  pi.registerMessageRenderer((message) => {
    if (message.customType === "intercom:answered-question") {
      const details = message.details as {
        questions?: string[];
        answers?: Record<string, string>;
      };
      if (details?.questions && details?.answers) {
        const answerLines = details.questions
          .map((q: string) => `- ${q}: ${details.answers?.[q] ?? "(no answer)"}`)
          .join("\n");
        return {
          content: [
            {
              type: "box" as const,
              box: Box(
                { borderStyle: "round" as const, borderColor: "green" as const },
                `Answered questions:\n${answerLines}`,
              ),
            },
          ],
        };
      }
    }
    return undefined;
  });
}

/**
 * Handle the subagent forwarding path for ask_user_question.
 * Returns null if not in subagent context (caller should handle locally).
 */
export async function handleSubagentForwarding(
  params: { questions: Question[] },
  signal?: AbortSignal,
): Promise<{
  content: { type: "text"; text: string }[];
  details: Result;
  isError?: boolean;
} | null> {
  if (!process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET) return null;

  if (!_sendAndWait) {
    throw new Error("sendAndWait not available — pi-intercom not loaded or not in subagent context");
  }

  const payload = { questions: params.questions };

  const reply = await _sendAndWait({
    contentType: "ask_user_question",
    payload: payload as unknown as Record<string, unknown>,
    text: `Ask user question from subagent (${params.questions.length} question(s))`,
    signal,
    timeoutMs: Infinity,
  });

  // Parse reply as Result (same format as AskUserQuestionComponent returns)
  let result: Result;
  try {
    result = JSON.parse(reply.text);
  } catch {
    return {
      content: [{ type: "text", text: "Error: failed to parse reply from parent session" }],
      isError: true,
      details: { questions: params.questions, answers: {}, cancelled: true },
    };
  }

  if (result.cancelled) {
    return {
      content: [{ type: "text", text: "User cancelled" }],
      details: { questions: params.questions, answers: {}, cancelled: true },
    };
  }
  const summaryLines = result.questions.map(
    (q) => `"${q.question}" = "${result.answers[q.question] ?? "(no answer)"}"`,
  );
  return {
    content: [{ type: "text", text: summaryLines.join("\n") }],
    details: result,
  };
}
