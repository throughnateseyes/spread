const NOT_TEXT = new Set(['range', 'checkbox', 'radio', 'color', 'button', 'file']);

/** True when keys belong to a field. A slider keeps focus after a drag, but ⌘Z should still undo. */
export function isTyping() {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  if (a.tagName === 'INPUT') return !NOT_TEXT.has((a as HTMLInputElement).type);
  return a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable;
}
