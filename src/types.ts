import type { Context, SessionFlavor } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";

export interface SessionData {
  // kelajakda kerak bo'lishi mumkin bo'lgan vaqtinchalik holat
  scratch?: Record<string, unknown>;
}

export type MyContext = Context & SessionFlavor<SessionData> & ConversationFlavor;
