// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Extension-specific UI bridge handling for ask_user_question.
 *
 * Uses the shared infrastructure from subscribe-to-subagent-ui-bridge.ts (vendored copy).
 * This file contains only ask_user_question-specific logic:
 * - Root-side handler that renders questions from subagents
 * - Child-side forwarding wrapper with ask_user_question payload shaping
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { renderQuestionsViaUI } from "./component.ts";
import { formatResultSummary, type Question, type Result } from "./schema.ts";
import { withCoordinator } from "./snippets/vendored/subscribe-to-dialog-coordinator.ts";
import { withAttention } from "./snippets/vendored/subscribe-to-notifications.ts";
import {
  forwardToRoot,
  isSubagentBridgeAvailable,
  type RootHandler,
  subscribeToUiBridge,
} from "./snippets/vendored/subscribe-to-subagent-ui-bridge.ts";

/** The content type for ask_user_question bridge messages. */
const CONTENT_TYPE = "ask_user_question";

/**
 * Check whether this extension instance is running inside a subagent process.
 * Uses two independent signals (OR logic — either one is sufficient):
 *   ctx.mode !== "tui"   — pi-core signal (RPC children have mode="rpc").
 *   PI_SUBAGENT_PARENT_PID — avtc-pi-subagent env var (set by the parent at spawn).
 */
export function isSubagentSession(ctx: { mode: string }): boolean {
  return ctx.mode !== "tui" || process.env.PI_SUBAGENT_PARENT_PID !== undefined;
}

/**
 * Build a notification detail string for forwarded (subagent) requests.
 * Uses the subagent's lastMessage from IPC meta — never the root session's context.
 */
export function buildNotificationDetail(questions: Question[], ipcMessage: string | undefined): string {
  const questionSummary = questions
    .map((q) => {
      const opts = q.options.map((o) => o.label).join(" | ");
      return `${q.header}: ${q.question} [${opts}]`;
    })
    .join(" · ");

  return ipcMessage ? `${questionSummary}\n${ipcMessage}` : questionSummary;
}

/** Reusable cancelled result — used when ctx lacks UI, no questions, or user cancels. */
const CANCELLED_RESULT: Result = Object.freeze({
  questions: [],
  answers: {},
  cancelled: true,
});

/** Root-side handler: render questions from subagents. */
const askHandler: RootHandler<{ hasUI: boolean; ui: ExtensionUIContext }, { questions?: Question[] }> = async (
  input,
) => {
  if (!input.ctx.hasUI) return CANCELLED_RESULT;
  const questions = input.payload.questions;
  if (!questions?.length) return CANCELLED_RESULT;

  const result = await withAttention(
    "ask_user_question",
    buildNotificationDetail(questions, input.meta?.lastMessage),
    () => withCoordinator(() => renderQuestionsViaUI(questions, input.ctx)),
  );
  if (!result) return CANCELLED_RESULT;
  return result;
};

/**
 * Register the ask_user_question UI bridge hooks.
 * Call once during extension initialization.
 */
export function registerAskQuestionBridge(pi: ExtensionAPI): void {
  subscribeToUiBridge(pi, CONTENT_TYPE, askHandler);
}

/**
 * Handle the subagent forwarding path for ask_user_question.
 * Returns null if not in subagent context (caller should handle locally).
 */
export async function handleSubagentForwarding(
  params: { questions: Question[] },
  signal: AbortSignal | undefined,
): Promise<{
  content: { type: "text"; text: string }[];
  details: Result;
  isError?: boolean;
} | null> {
  if (!isSubagentBridgeAvailable()) return null;

  const payload = { questions: params.questions };

  const reply = await forwardToRoot({
    contentType: CONTENT_TYPE,
    payload: payload as unknown as Record<string, unknown>,
    text: `Ask user question from subagent (${params.questions.length} question(s))`,
    signal,
    // User might take arbitrary time to answer — never time out.
    timeoutMs: Infinity,
  });

  if (!reply) return null;

  // Response is structured — no JSON.parse needed
  const result = reply.payload as Result;

  if (!result || result.cancelled) {
    return {
      content: [{ type: "text", text: "User cancelled" }],
      details: {
        questions: params.questions,
        answers: {},
        cancelled: true,
      },
    };
  }

  return {
    content: [{ type: "text", text: formatResultSummary(result) }],
    details: result,
  };
}
