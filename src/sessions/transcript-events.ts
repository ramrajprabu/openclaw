import { asPositiveSafeInteger } from "../shared/number-coercion.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type SessionTranscriptUpdate = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(update: SessionTranscriptUpdate): void {
  const normalized = {
    agentId: update.agentId,
    sessionId: update.sessionId,
    sessionKey: update.sessionKey,
    message: update.message,
    messageId: update.messageId,
    messageSeq: update.messageSeq,
  };
  const agentId = normalizeOptionalString(normalized.agentId);
  const sessionId = normalizeOptionalString(normalized.sessionId);
  const sessionKey = normalizeOptionalString(normalized.sessionKey);
  if (!sessionId && !sessionKey) {
    return;
  }
  const messageSeq = asPositiveSafeInteger(normalized.messageSeq);
  const nextUpdate: SessionTranscriptUpdate = {
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    ...(normalizeOptionalString(normalized.messageId)
      ? { messageId: normalizeOptionalString(normalized.messageId) }
      : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
  };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}
