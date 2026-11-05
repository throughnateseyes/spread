import { useEffect, useMemo, useState } from 'react';
import { filterChanges, timeAgo, type ChangeEntry, type ChangeLine } from '../history';
import { useStore } from '../store';
import { findNode } from '../tree';
import { EmptyState, Segmented, Select } from '../ui/controls';
import { IconClock } from '../ui/icons';
import type { SceneNode } from '../types';

// Who changed what: the History tab, and the line in the right panel that says who last touched
// a layer. Reading only. Undo is still how a change gets taken back.

const WHO = { you: 'You', claude: 'Claude' };

function openLine(entry: ChangeEntry, line: ChangeLine) {
  const s = useStore.getState();
  if (!entry.boardId || !line.ids?.length || !s.project.boards.some((b) => b.id === entry.boardId)) return;
  s.setActiveBoard(entry.boardId);
  const t = useStore.getState();
  const here = line.ids.filter((id) => findNode(t.doc.nodes, id));
  if (!here.length) return t.toast('That layer has since been deleted.');
  t.select(here);
  window.dispatchEvent(new Event('spread:zoom-selection'));
}

function Row({ entry, showBoard }: { entry: ChangeEntry; showBoard: boolean }) {
  return (
    <div className="hist-entry">
      <div className="hist-head">
        <span className={`hist-who ${entry.who}`}>{WHO[entry.who]}</span>
        {entry.undo && <span className="hist-tag">{entry.undo === 'undo' ? 'Undid' : 'Redid'}</span>}
        {showBoard && <span className="hist-board">{entry.boardName}</span>}
        <span className="hist-time" title={new Date(entry.at).toLocaleString()}>
          {timeAgo(entry.at)}
        </span>
      </div>
      {entry.lines.map((l, i) => (
        <button key={i} className="hist-line" disabled={!l.ids?.length} title={entry.via ? `Through ${entry.via}` : undefined} onClick={() => openLine(entry, l)}>
          {l.layer && <span className="hist-layer">{l.layer}</span>} {l.what}
        </button>
      ))}
      {entry.more && <div className="hist-more">and {entry.more} more</div>}
    </div>
  );
}

export function HistoryTab() {
  const changes = useStore((s) => s.changes);
  const boardId = useStore((s) => s.project.activeBoardId);
  const selection = useStore((s) => s.selection);
  const boards = useStore((s) => s.project.boards.length);
  const [who, setWho] = useState<'all' | 'you' | 'claude'>('all');
  const [scope, setScope] = useState<'project' | 'board' | 'layer'>(() => (useStore.getState().selection.length ? 'layer' : 'project'));
  const layers = scope === 'layer' && selection.length > 0;
  useEffect(() => {
    const show = () => setScope('layer');
    window.addEventListener('spread:layer-history', show);
    return () => window.removeEventListener('spread:layer-history', show);
  }, []);

  const shown = useMemo(
    () =>
      filterChanges(changes, {
        who: who === 'all' ? undefined : who,
        boardId: scope === 'board' ? boardId : undefined,
        layerIds: layers ? selection : undefined,
      }),
    [changes, who, scope, boardId, layers, selection],
  );

  return (
    <div className="panel-scroll hist">
      <div className="hist-filters">
        <Segmented
          value={who}
          options={[
            { value: 'all', label: 'All' },
            { value: 'you', label: 'You' },
            { value: 'claude', label: 'Claude' },
          ]}
          onChange={setWho}
        />
        <Select
          title="Show changes to"
          value={scope}
          options={[
            { value: 'project', label: 'Whole project' },
            { value: 'board', label: 'This board' },
            { value: 'layer', label: 'Selected layers' },
          ]}
          onChange={setScope}
        />
      </div>
      {scope === 'layer' && !selection.length ? (
        <div className="hint">Select a layer to see what happened to it.</div>
      ) : !shown.length ? (
        <EmptyState icon={<IconClock size={20} />} title="No changes yet">
          Edits by you and Claude show up here.
        </EmptyState>
      ) : (
        shown.slice(0, 300).map((e) => <Row key={e.id} entry={e} showBoard={boards > 1 && scope !== 'board'} />)
      )}
    </div>
  );
}

/** Who last touched this layer. Opens its history. */
export function LastChange({ node }: { node: SceneNode }) {
  const changes = useStore((s) => s.changes);
  const last = useMemo(() => filterChanges(changes, { layerIds: [node.id] })[0], [changes, node.id]);
  if (!last) return null;
  return (
    <button
      className="hist-last"
      onClick={() => {
        useStore.getState().set({ leftTab: 'history' });
        window.dispatchEvent(new Event('spread:layer-history'));
      }}
    >
      Last changed by {WHO[last.who]}, {timeAgo(last.at)}
    </button>
  );
}
