import { useState, type ClipboardEvent } from 'react';
import { useStore } from '../store';
import { getAsset } from '../assets';
import { photoCell, pickReplacement } from '../importer';
import { bindLayer, cardNodeId, fieldNamed, parseTable, photoFields, renameField, repeatHost, rowOf, sourceLayer, startRepeat, stopRepeat, unbindLayer } from '../repeat';
import { findNode, walk } from '../tree';
import type { FrameNode, RepeatSpec, SceneNode } from '../types';
import { Button, IconButton, Modal, NumberField, Section, Toggle } from '../ui/controls';
import { IconMinus } from '../ui/icons';
import './panels.css';

const inRepeat = (id: string, fn: (f: FrameNode) => void, key?: string) =>
  useStore.getState().change((d) => {
    const f = findNode(d.nodes, id);
    if (f?.type === 'frame') fn(f);
  }, key);

/** Turns a frame into a repeat, or shows the repeat the selected layer sits in. */
export function RepeatSection({ node }: { node: SceneNode }) {
  const nodes = useStore((s) => s.doc.nodes);
  const set = useStore((s) => s.set);
  const host = repeatHost(nodes, node.id);

  if (!host) {
    if (node.type !== 'frame') return null;
    const start = () => {
      let id = '';
      try {
        useStore.getState().change((d) => {
          id = startRepeat(d, node.id);
        });
      } catch (e) {
        useStore.getState().toast((e as Error).message, 'error');
        return;
      }
      useStore.getState().select([id]);
      set({ modal: 'repeat' });
    };
    return (
      <Section title="Repeat">
        <Button onClick={start} title="Use this frame as a card and fill copies of it from a table">
          Repeat this card
        </Button>
      </Section>
    );
  }

  const spec = host.repeat!;
  const source = sourceLayer(host, node.id);
  const field = source?.bind?.image ?? source?.bind?.text;
  const canBind = source?.type === 'text' || source?.type === 'image';
  const row = rowOf(host, node.id);
  return (
    <Section title="Repeat" actions={<span className="repeat-count">{row > 0 ? `Card ${row + 1} of ${spec.rows.length}` : `${spec.rows.length} ${spec.rows.length === 1 ? 'card' : 'cards'}`}</span>}>
      <NumberField label="Per row" value={spec.columns} min={1} max={6} onChange={(v, key) => inRepeat(host.id, (f) => void (f.repeat!.columns = v), key)} />
      {canBind && (
        <Toggle
          label="Changes per card"
          title="Off: every card shows the same thing"
          checked={field !== undefined}
          onChange={(on) =>
            inRepeat(host.id, (f) => {
              const n = findNode(f.children, source!.id);
              if (!n) return;
              if (on) bindLayer(f.repeat!, n);
              else unbindLayer(f, n);
            })
          }
        />
      )}
      <Button onClick={() => set({ modal: 'repeat' })}>Edit table</Button>
      <button className="link-btn left muted-link" onClick={() => inRepeat(host.id, stopRepeat)} title="Keep the cards as plain layers">
        Stop repeating
      </button>
    </Section>
  );
}

function PhotoCell({ assetId, onPick }: { assetId: string; onPick: () => void }) {
  const url = assetId ? getAsset(assetId)?.thumbUrl : undefined;
  return (
    <button className="repeat-photo" onClick={onPick} title="Choose a photo, or paste a link to one">
      {url ? <img src={url} alt="" /> : <span>Choose</span>}
    </button>
  );
}

/** Pasted rows, as cells by field. A first line of column names lines them up by name. */
function pastedCells(text: string, spec: RepeatSpec, startCol: number) {
  const grid = parseTable(text);
  const header = grid[0].every((c) => !c || fieldNamed(spec, c)) && grid[0].some(Boolean);
  const columns = header ? grid[0].map((c) => (c ? fieldNamed(spec, c) : undefined)) : grid[0].map((_, i) => spec.fields[startCol + i]);
  const rows = (header ? grid.slice(1) : grid).map((cells) => {
    const out: Record<string, string> = {};
    cells.forEach((c, i) => {
      if (columns[i]) out[columns[i]!] = c;
    });
    return out;
  });
  return { header, rows };
}

export default function RepeatDialog() {
  const set = useStore((s) => s.set);
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const [busy, setBusy] = useState(false);
  const host = selection.length ? repeatHost(doc.nodes, selection[0]) : null;
  const close = () => set({ modal: null });
  if (!host) return null;
  const spec = host.repeat!;
  const photos = photoFields(host);

  // The photo layer in a field's card, so the file picker can fill that card.
  const photoLayer = (field: string, row: number) => {
    let id: string | null = null;
    const card = host.children[0]?.type === 'frame' ? host.children[0].children[0] : undefined;
    if (card) walk([card], (n) => void (n.bind?.image === field && (id ??= n.id)));
    return id ? cardNodeId(id, row) : null;
  };

  const onPaste = async (e: ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text/plain');
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
    const startRow = Number(cell?.dataset.row ?? 0);
    const startCol = Number(cell?.dataset.col ?? 0);
    const onPhoto = photos.includes(spec.fields[startCol]);
    if (!text.trim() || (!/[\t\n]/.test(text.trim()) && !onPhoto)) return;
    e.preventDefault();
    const { header, rows } = pastedCells(text, spec, startCol);

    // Photos come in first, so the table only ever holds photos the project has.
    setBusy(true);
    const seen = new Map<string, string>();
    let failed = 0;
    for (const row of rows) {
      for (const f of photos) {
        const v = row[f];
        if (v === undefined) continue;
        try {
          if (!seen.has(v)) seen.set(v, await photoCell(v));
          row[f] = seen.get(v)!;
        } catch {
          row[f] = '';
          failed++;
        }
      }
    }
    setBusy(false);
    if (failed) useStore.getState().toast(`Couldn't get ${failed} ${failed === 1 ? 'photo' : 'photos'}.`, 'error');

    inRepeat(host.id, (f) => {
      const table = f.repeat!;
      const from = header ? 0 : startRow;
      if (header) table.rows.length = Math.min(table.rows.length, Math.max(1, rows.length));
      rows.forEach((row, i) => {
        table.rows[from + i] = { ...(table.rows[from + i] ?? table.rows[0]), ...row };
      });
    });
  };

  return (
    <Modal
      title="Cards table"
      width={Math.min(980, 200 + spec.fields.length * 170)}
      onClose={close}
      footer={
        <>
          <Button onClick={() => inRepeat(host.id, (f) => void f.repeat!.rows.push({ ...f.repeat!.rows[f.repeat!.rows.length - 1] }))}>Add card</Button>
          <Button primary onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <p className="repeat-hint">{busy ? 'Getting photos…' : 'One row per card. Paste from a spreadsheet to fill it; a first line of column names matches columns by name.'}</p>
      <div className="repeat-table" onPaste={onPaste}>
        <table>
          <thead>
            <tr>
              <th className="repeat-num" />
              {spec.fields.map((f) => (
                <th key={f}>
                  <input defaultValue={f} aria-label="Column name" spellCheck={false} onBlur={(e) => inRepeat(host.id, (x) => renameField(x, f, e.target.value))} />
                </th>
              ))}
              <th className="repeat-num" />
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((row, r) => (
              <tr key={r}>
                <td className="repeat-num">{r + 1}</td>
                {spec.fields.map((f, c) => (
                  <td key={f} data-row={r} data-col={c}>
                    {photos.includes(f) ? (
                      <PhotoCell
                        assetId={row[f] ?? ''}
                        onPick={() => {
                          const id = photoLayer(f, r);
                          if (id) pickReplacement(id);
                        }}
                      />
                    ) : (
                      <input
                        value={row[f] ?? ''}
                        aria-label={`${f}, card ${r + 1}`}
                        spellCheck={false}
                        onChange={(e) => {
                          const v = e.target.value;
                          inRepeat(host.id, (x) => void (x.repeat!.rows[r][f] = v), `repeat-cell:${r}:${f}`);
                        }}
                      />
                    )}
                  </td>
                ))}
                <td className="repeat-num">
                  <IconButton className="small" title="Remove card" disabled={spec.rows.length < 2} onClick={() => inRepeat(host.id, (x) => void x.repeat!.rows.splice(r, 1))}>
                    <IconMinus size={14} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
