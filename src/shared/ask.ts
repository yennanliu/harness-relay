/**
 * An agent ends its reply with this to ask the user something before it answers: the team stops
 * until the user replies, then that agent answers first (see `Orchestrator.execute`).
 */
export const ASK_TOKEN = '[ASK_USER]';

/** The marker at the very end of a reply, also when wrapped in Markdown emphasis or code, or followed by punctuation. */
const ASK_AT_END = /[*_`]*\[ASK_USER\][*_`]*[\s.。!！]*$/i;

/**
 * A reply's text without a final ask marker, and whether it asks: only a reply that says something
 * besides the marker asks the user.
 */
export function splitAsk(text: string): { text: string; asks: boolean } {
  const m = ASK_AT_END.exec(text);
  if (!m) return { text, asks: false };
  const rest = text.slice(0, m.index).trimEnd();
  return { text: rest, asks: rest.length > 0 };
}

/**
 * An agent ends its reply with this to ask for a git repository that is not among the conversation's
 * working directories, and with `edit` for edit access to it: `[ASK_FOLDER /path/to/repo]` or
 * `[ASK_FOLDER /path/to/repo edit]`. The team stops as for a question; the user allows or denies it
 * on a card in the chat (see `Orchestrator.answerFolder`).
 */
export const FOLDER_TOKEN = '[ASK_FOLDER';

/** The marker at the very end of a reply, as `ASK_AT_END` takes it: its path, and `edit` after it. */
const FOLDER_AT_END = /[*_`]*\[ASK_FOLDER[:\s]\s*([^\]\n]+?)\s*\][*_`]*[\s.。!！]*$/i;

/** What a reply asks for with a final folder marker: the folder as written, and whether to edit there. */
export interface FolderAsk {
  path: string;
  edit: boolean;
}

/** A reply's text without a final folder marker, and what the marker asks for (neither when there is no marker, or no path in it). */
export function splitFolderAsk(text: string): { text: string; folder?: FolderAsk } {
  const m = FOLDER_AT_END.exec(text);
  if (!m) return { text };
  const rest = text.slice(0, m.index).trimEnd();
  const inner = m[1]!.trim();
  const edit = /\s+edit$/i.test(inner);
  // Quotes or backticks around the path are the agent's, not the path's.
  const path = (edit ? inner.replace(/\s+edit$/i, '') : inner).trim().replace(/^["'`<]+|["'`>]+$/g, '').trim();
  // A marker without a path asks for nothing: the reply stays as it was written.
  return path ? { text: rest, folder: { path, edit } } : { text };
}

/** A reply's text while it streams, without either closing marker (they are taken out when it ends). */
export function withoutAskMarkers(text: string): string {
  return splitFolderAsk(splitAsk(text).text).text;
}
