import { useEffect, useLayoutEffect, useRef } from 'react';
import { useStore, useLayout, activeOrigin } from '../store';
import { findNode, pathTo } from '../tree';
import { absoluteBox, letterSpacingPx, textFontStyle } from '../layout';
import type { TextNode } from '../types';

/** In-place text editing: a textarea laid exactly over the Konva text (which is hidden meanwhile). */
export default function TextEditor() {
  const id = useStore((s) => s.editingTextId)!;
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const layout = useLayout();
  useStore((s) => s.project);
  const origin = activeOrigin();
  const ref = useRef<HTMLTextAreaElement>(null);
  const node = findNode(doc.nodes, id) as TextNode | null;
  const box = node ? absoluteBox(layout, pathTo(doc.nodes, id)) : null;
  const originalText = useRef(node?.text ?? '');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = el.scrollHeight + 'px';
  });

  const finish = () => {
    const s = useStore.getState();
    const n = findNode(s.doc.nodes, id);
    s.set({ editingTextId: null });
    if (n?.type === 'text' && !n.text.trim()) {
      s.select([id]);
      s.deleteSelection();
    }
  };

  if (!node || node.type !== 'text' || !box) return null;
  const z = view.zoom;
  const hug = node.sizingH === 'hug';
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={node.text}
      spellCheck={false}
      onChange={(e) => useStore.getState().updateNode(id, { text: e.target.value }, 'text-' + id)}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          if (e.key === 'Escape' && !node.text.trim() && originalText.current) {
            useStore.getState().updateNode(id, { text: originalText.current });
          }
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      style={{
        left: view.panX + (box.x + origin.x) * z,
        top: view.panY + (box.y + origin.y) * z,
        width: hug ? Math.max(box.w * z + node.fontSize * z, 24) : box.w * z,
        transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
        transformOrigin: '0 0',
        font: `${textFontStyle(node)} ${node.fontSize * z}px "${node.fontFamily}"`,
        lineHeight: node.lineHeight,
        letterSpacing: letterSpacingPx(node) * z + 'px',
        color: node.fill,
        textAlign: node.align === 'justify' ? 'justify' : node.align,
        textTransform: node.uppercase ? 'uppercase' : 'none',
        textDecoration: node.decoration === 'none' ? 'none' : node.decoration,
        whiteSpace: hug ? 'pre' : 'pre-wrap',
      }}
    />
  );
}
