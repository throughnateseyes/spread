import { useLayout } from '../store';
import { autoStacks, phoneStackSetting } from '../email/html';
import { Section, Segmented, Toggle } from '../ui/controls';
import type { FrameNode, SceneNode } from '../types';

// Phone layout on email boards: whether a row stacks on phones, and pictures that run edge to
// edge there. Both used to be hidden in layer-name tags ([stack] / [nostack]).

type StackChoice = 'auto' | 'stack' | 'side-by-side';

const hasPicture = (n: SceneNode): boolean => n.type === 'image' || (n.type === 'frame' && n.children.some((c) => c.visible && hasPicture(c)));

/** Drops the older name tags once the row has a real setting. */
const withoutStackTags = (name: string) => name.replace(/\s*\[(no)?stack\]/gi, '').trim() || name;

export function PhoneLayoutSection({ sel, upd }: { sel: SceneNode[]; upd: (fn: (n: SceneNode) => void, key?: string) => void }) {
  const layout = useLayout();
  const rows = sel.filter((n): n is FrameNode => n.type === 'frame' && n.layout === 'row');
  const pictures = sel.filter((n) => n.type === 'image' || (n.type === 'frame' && hasPicture(n)));
  const showStack = rows.length > 0 && rows.length === sel.length;
  const showBleed = pictures.length > 0 && pictures.length === sel.length;
  if (!showStack && !showBleed) return null;

  const choices = rows.map((f): StackChoice => phoneStackSetting(f) ?? 'auto');
  const choice = choices.every((c) => c === choices[0]) ? choices[0] : null;
  const autoSays = rows.length === 1 ? (autoStacks(rows[0], layout) ? 'Auto stacks this row: it holds photos or cards.' : 'Auto keeps this row side by side.') : null;
  const setStack = (v: StackChoice) =>
    upd((n) => {
      if (n.type !== 'frame') return;
      if (v === 'auto') delete n.phoneStack;
      else n.phoneStack = v;
      n.name = withoutStackTags(n.name);
    });

  const bleed = pictures.every((n) => (n.type === 'image' || n.type === 'frame') && n.phoneFullWidth);
  const setBleed = (on: boolean) =>
    upd((n) => {
      if (n.type !== 'image' && n.type !== 'frame') return;
      if (on) n.phoneFullWidth = true;
      else delete n.phoneFullWidth;
    });

  return (
    <Section title="On phones">
      {showStack && (
        <>
          <Segmented<StackChoice>
            value={choice}
            options={[
              { value: 'auto', label: 'Auto', title: 'Rows of photos or cards stack; others stay side by side' },
              { value: 'stack', label: 'Stack', title: 'One under another on phones' },
              { value: 'side-by-side', label: 'Side by side', title: 'Stays across on phones, each cell gets part of a 375px screen' },
            ]}
            onChange={setStack}
          />
          {choice === 'auto' && autoSays && <div className="hint">{autoSays}</div>}
          {choice === 'side-by-side' && <div className="hint">Check Preview on a phone: text gets about half the screen here and may wrap.</div>}
        </>
      )}
      {showBleed && (
        <>
          <Toggle checked={bleed} onChange={setBleed} label="Full width on phones" title="The picture spans the phone screen edge to edge. Desktop doesn't change." />
          {bleed && <div className="hint">Edge to edge on phones, ignoring the padding around it. Desktop doesn't change.</div>}
        </>
      )}
    </Section>
  );
}
