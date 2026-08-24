export function normalizeReadableText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function voiceButtonId(messageKey) {
  const input = String(messageKey ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `dsh-edge-read-${hash.toString(36)}`;
}
