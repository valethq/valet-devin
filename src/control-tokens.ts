// devin acp sometimes leaks raw model control tokens (spelled "<\|" + name +
// "|>") into chunk text; everything from the first token on is a leaked
// tool-call template, not real reply text.

export interface TokenFilter {
  held: string;
  muted: boolean;
}

export function newTokenFilter(): TokenFilter {
  return { held: "", muted: false };
}

const TOKEN = /<\|[A-Za-z0-9_]{1,32}\|>/;
// Tail of a chunk that may still grow into a token on the next chunk:
// a lone "<", or "<\|" plus up to 32 word chars and an optional "|".
const TAIL = /<\|[A-Za-z0-9_]{0,32}\|?$|<$/;

// Returns the text safe to emit for this chunk. When a control token is
// found, emits the text before it and mutes the stream (onMute fires once
// per muted stretch). Otherwise holds back a trailing token prefix.
export function feed(f: TokenFilter, chunk: string, onMute?: () => void): string {
  if (f.muted) return "";
  const text = f.held + chunk;
  f.held = "";
  const m = TOKEN.exec(text);
  if (m) {
    f.muted = true;
    onMute?.();
    return text.slice(0, m.index);
  }
  const tail = TAIL.exec(text)?.[0] ?? "";
  f.held = text.slice(text.length - tail.length);
  return text.slice(0, text.length - tail.length);
}

// Unmutes the stream and returns held text (now known not to be a token).
export function flush(f: TokenFilter): string {
  const text = f.held;
  f.held = "";
  f.muted = false;
  return text;
}
