/**
 * Prompt-catalog type vocabulary (D-C12-4).
 *
 * Each prompt definition mirrors the MCP `prompts/get` response shape:
 * a list of `messages`, each with a `role` and a `content` block. v1
 * prompts emit a single user message containing the templated
 * instructions for the agent — multi-turn prompts are out of scope.
 *
 * `requiresAction` flags prompts that reference action tools so the
 * server bootstrap can gate their registration on `--allow-actions`.
 * The catalog itself is the unconditional source of truth — gating
 * happens in `createMcpServer`.
 */

export type PromptRole = "user" | "assistant";

export interface PromptMessageContent {
  type: "text";
  text: string;
}

export interface PromptMessage {
  role: PromptRole;
  content: PromptMessageContent;
}

export interface PromptRenderResult {
  messages: PromptMessage[];
}

export interface PromptArgumentSpec {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments?: PromptArgumentSpec[];
  /** Gate flag — when `true`, the prompt is only registered with --allow-actions. */
  requiresAction?: boolean;
  render(args?: Record<string, unknown>): Promise<PromptRenderResult>;
}

export function userMessage(text: string): PromptMessage {
  return { role: "user", content: { type: "text", text } };
}
