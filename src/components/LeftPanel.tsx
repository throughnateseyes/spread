import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { MOD, useLayout, useStore } from '../store';
import { getAsset, filesFromDataTransfer } from '../assets';
import { importFiles, pickFolder, pickImages } from '../importer';
import { pathTo, walk } from '../tree';
import type { SceneNode } from '../types';
import { Button, EmptyState, IconButton } from '../ui/controls';
import { Tooltip } from '../ui/Tooltip';
import {
  ICON_DENSE,
  IconArrange,
  IconAutoLayoutColumn,
  IconAutoLayoutRow,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconEllipse,
  IconEye,
  IconEyeOff,
  IconFrame,
  IconImage,
  IconLayers,
  IconLock,
  IconOpen,
  IconPhotos,
  IconPlus,
  IconRect,
  IconText,
  IconTrash,
  IconUnlock,
} from '../ui/icons';
import './panels.css';

export default function LeftPanel() {
  const tab = useStore((s) => s.leftTab);
  const set = useStore((s) => s.set);
  const photoCount = useStore((s) => s.doc.assetOrder.filter((id) => s.doc.assets[id]?.kind !== 'font').length);
  return (
    <div className="panel left">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'layers'} className={tab === 'layers' ? 'on' : ''} onClick={() => set({ leftTab: 'layers' })}>
          Layers
        </button>
        <button role="tab" aria-selected={tab === 'photos'} className={tab === 'photos' ? 'on' : ''} onClick={() => set({ leftTab: 'photos' })}>
          Photos
          {photoCount > 0 && <span className="tab-count">{photoCount}</span>}
        </button>
      </div>
      {tab === 'layers' ? <LayersTab /> : <PhotosTab />}
    </div>
  );
}

// ---------------- Photos ----------------

function PhotosTab() {
  const order = useStore((s) => s.doc.assetOrder);
  const assets = useStore((s) => s.doc.assets);
  const nodes = useStore((s) => s.doc.nodes);
  const traySel = useStore((s) => s.traySelection);
  const set = useStore((s) => s.set);
  const removeTrayAssets = useStore((s) => s.removeTrayAssets);
  const [over, setOver] = useState(false);
  const anchor = useRef<string | null>(null);

  const usage = useMemo(() => {
    const m = new Map<string, number>();
    walk(nodes, (n) => {
      if (n.type === 'image' && n.assetId) m.set(n.assetId, (m.get(n.assetId) ?? 0) + 1);
    });
    return m;
  }, [nodes]);

  // Fonts live in the asset table too; the tray only shows photos.
  const ids = order.filter((id) => assets[id] && assets[id].kind !== 'font');

  const click = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor.current && ids.includes(anchor.current)) {
      const a = ids.indexOf(anchor.current);
      const b = ids.indexOf(id);
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      set({ traySelection: [...new Set([...traySel, ...range])] });
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      set({ traySelection: traySel.includes(id) ? traySel.filter((x) => x !== id) : [...traySel, id] });
    } else set({ traySelection: traySel.length === 1 && traySel[0] === id ? [] : [id] });
    anchor.current = id;
  };

  const allSelected = ids.length > 0 && traySel.length === ids.length;

  return (
    <div
      className={`panel-scroll photos ${over ? 'drop-over' : ''}`}
      tabIndex={0}
      aria-label="Photos"
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && traySel.length) {
          e.preventDefault();
          e.stopPropagation();
          removeTrayAssets(traySel);
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          e.stopPropagation();
          set({ traySelection: ids });
        }
        if (e.key === 'Escape' && traySel.length) {
          e.stopPropagation();
          set({ traySelection: [] });
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
          if (!over) setOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Ignore leaves into child elements (prevents the highlight flickering).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={async (e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const files = await filesFromDataTransfer(e.dataTransfer);
        void importFiles(files);
      }}
    >
      <div className="photos-actions">
        <Button onClick={pickImages} title="Import photos (or font files)">
          <IconPlus size={ICON_DENSE} /> Photos
        </Button>
        <Button onClick={pickFolder} title="Import every photo in a folder">
          <IconOpen size={ICON_DENSE} /> Folder
        </Button>
        {ids.length > 0 && (
          <Button className="arrange" onClick={() => set({ modal: 'arrange' })} title={traySel.length ? `Lay out the ${traySel.length} selected photos across slides` : 'Lay the photos out across slides'}>
            <IconArrange size={ICON_DENSE} /> {traySel.length ? `Arrange ${traySel.length} selected…` : 'Arrange…'}
          </Button>
        )}
      </div>
      {!ids.length ? (
        <EmptyState icon={<IconPhotos size={28} weight="light" />} title="Drop photos here">
          Or a whole folder. Fonts work too.
        </EmptyState>
      ) : (
        <>
          <div className="photos-meta">
            <span className="muted ellipsis">
              {ids.length} photo{ids.length === 1 ? '' : 's'}
              {traySel.length ? ` · ${traySel.length} selected` : ''}
            </span>
            <div className="photos-meta-actions">
              <button className="link-btn" onClick={() => set({ traySelection: allSelected ? [] : ids })}>
                {allSelected ? 'Select none' : 'Select all'}
              </button>
              <IconButton className="small" title="Remove from Photos" shortcut="Del" disabled={!traySel.length} onClick={() => removeTrayAssets(traySel)}>
                <IconTrash size={ICON_DENSE} />
              </IconButton>
            </div>
          </div>
          <div className="photo-grid">
            {ids.map((id) => {
              const a = getAsset(id);
              const meta = assets[id];
              const used = usage.get(id) ?? 0;
              return (
                <Tooltip key={id} label={`${meta.name}\n${meta.width} × ${meta.height}${used ? ` · used ${used}×` : ' · not placed yet'}`} side="right" delay={700}>
                  <div
                    className={`photo ${traySel.includes(id) ? 'on' : ''}`}
                    onClick={(e) => click(e, id)}
                    draggable
                    onDragStart={(e) => {
                      const dragIds = traySel.includes(id) ? ids.filter((x) => traySel.includes(x)) : [id];
                      e.dataTransfer.setData('application/x-spread-assets', JSON.stringify(dragIds));
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                  >
                    {a?.thumbUrl ? <img src={a.thumbUrl} alt={meta.name} draggable={false} /> : <div className="photo-missing" />}
                    {used > 0 && (
                      <span className="photo-badge" aria-label="Placed on this board">
                        <IconCheck size={10} weight="bold" />
                      </span>
                    )}
                  </div>
                </Tooltip>
              );
            })}
          </div>
          <div className="hint photos-hint">
            Drag a photo onto the canvas, or onto another photo to swap it.
          </div>
        </>
      )}
    </div>
  );
}

// ---------------- Layers ----------------

interface RowInfo {
  node: SceneNode;
  depth: number;
  parentId: string | null;
  index: number;
  ancestorSelected: boolean;
  parentHidden: boolean;
  /** Auto layout children list in reading order; everything else lists top layer first. */
  forward: boolean;
}

function NodeIcon({ n }: { n: SceneNode }) {
  const p = { size: ICON_DENSE };
  if (n.type === 'image') return <IconImage {...p} />;
  if (n.type === 'text') return <IconText {...p} />;
  if (n.type === 'rect') return <IconRect {...p} />;
  if (n.type !== 'frame') return <IconEllipse {...p} />;
  if (n.layout === 'row') return <IconAutoLayoutRow {...p} />;
  if (n.layout === 'column') return <IconAutoLayoutColumn {...p} />;
  return <IconFrame {...p} />;
}

/** The name without what's only there for the exporter ("CTA [link:{{URL}}]", "Section / Body"). */
function layerLabel(n: SceneNode) {
  const name = n.name.replace(/\s*\[[^\]]*\]/g, '').replace(/^(Section|Email) \/ /, '').trim();
  if (n.type === 'text' && (!name || name === 'Text')) return n.text.replace(/\s+/g, ' ').slice(0, 40) || 'Text';
  return name || n.type[0].toUpperCase() + n.type.slice(1);
}

type DropPos = { id: string; where: 'above' | 'below' | 'inside' } | null;

function LayersTab() {
  const nodes = useStore((s) => s.doc.nodes);
  const selection = useStore((s) => s.selection);
  const W = useStore((s) => s.doc.slideWidth);
  const kind = useStore((s) => s.doc.kind);
  const { select, updateNode, moveNode } = useStore(useShallow((s) => ({ select: s.select, updateNode: s.updateNode, moveNode: s.moveNode })));
  const layout = useLayout();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropPos>(null);
  const dragId = useRef<string | null>(null);
  const anchor = useRef<string | null>(null);
  const cancelRename = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  // Expand ancestors of the selection so selected layers are visible.
  useEffect(() => {
    if (!selection.length) return;
    const anc = new Set<string>();
    for (const id of selection) pathTo(nodes, id).slice(0, -1).forEach((a) => anc.add(a));
    if ([...anc].some((a) => collapsed.has(a))) setCollapsed((c) => new Set([...c].filter((x) => !anc.has(x))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  // Keep the (last) selected row in view when the selection changes from the canvas.
  useEffect(() => {
    const id = selection[selection.length - 1];
    if (!id || !scroller.current) return;
    const el = scroller.current.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selection]);

  const rows = useMemo(() => {
    const out: RowInfo[] = [];
    const sel = new Set(selection);
    const visit = (list: SceneNode[], depth: number, parentId: string | null, ancSel: boolean, parentHidden: boolean, forward: boolean) => {
      for (let k = 0; k < list.length; k++) {
        const i = forward ? k : list.length - 1 - k;
        const n = list[i];
        out.push({ node: n, depth, parentId, index: i, ancestorSelected: ancSel, parentHidden, forward });
        if (n.type === 'frame' && !collapsed.has(n.id)) visit(n.children, depth + 1, n.id, ancSel || sel.has(n.id), parentHidden || !n.visible, n.layout !== 'none');
      }
    };
    visit(nodes, 0, null, false, false, false);
    return out;
  }, [nodes, collapsed, selection]);

  const flatIds = rows.map((r) => r.node.id);

  const onRowClick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor.current && flatIds.includes(anchor.current)) {
      const a = flatIds.indexOf(anchor.current);
      const b = flatIds.indexOf(id);
      const anchorParent = rows[a].parentId;
      const range = rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter((r) => r.parentId === anchorParent).map((r) => r.node.id);
      select([...new Set([...selection, ...range])]);
      return;
    }
    if (e.ctrlKey || e.metaKey) select(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]);
    else select([id]);
    anchor.current = id;
  };

  const onDrop = () => {
    const id = dragId.current;
    const d = drop;
    setDrop(null);
    dragId.current = null;
    if (!id || !d || d.id === id) return;
    // Never drop a frame into itself or one of its descendants.
    if (pathTo(nodes, d.id).includes(id)) return;
    const row = rows.find((r) => r.node.id === d.id);
    if (!row) return;
    if (d.where === 'inside' && row.node.type === 'frame') moveNode(id, row.node.id, row.node.children.length);
    else moveNode(id, row.parentId, (d.where === 'above') === row.forward ? row.index : row.index + 1);
  };

  const toggleCollapsed = (id: string) =>
    setCollapsed((c) => {
      const nc = new Set(c);
      if (nc.has(id)) nc.delete(id);
      else nc.add(id);
      return nc;
    });

  if (!nodes.length)
    return (
      <div className="panel-scroll">
        <EmptyState icon={<IconLayers size={28} weight="light" />} title="No layers yet">
          Everything you add shows up here.
        </EmptyState>
      </div>
    );

  return (
    <div
      ref={scroller}
      className="panel-scroll layers"
      role="tree"
      aria-label="Layers"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onClick={(e) => e.target === e.currentTarget && select([])}
    >
      {rows.map((r) => {
        const n = r.node;
        const isSel = selection.includes(n.id);
        const isFrame = n.type === 'frame';
        const hasKids = isFrame && n.children.length > 0;
        const isCollapsed = collapsed.has(n.id);
        const box = r.depth === 0 ? layout.get(n.id) : undefined;
        const slide = box ? Math.floor((box.x + box.w / 2) / W) + 1 : null;
        const dropCls = drop?.id === n.id ? `drop-${drop.where}` : '';
        return (
          <div
            key={n.id}
            data-layer-id={n.id}
            role="treeitem"
            aria-selected={isSel}
            aria-expanded={hasKids ? !isCollapsed : undefined}
            className={`layer-row ${isSel ? 'sel' : ''} ${r.ancestorSelected && !isSel ? 'anc' : ''} ${!n.visible || r.parentHidden ? 'hidden' : ''} ${n.locked ? 'locked' : ''} ${dropCls}`}
            style={{ paddingLeft: 4 + r.depth * 16 }}
            onClick={(e) => onRowClick(e, n.id)}
            draggable={renaming !== n.id}
            onDragStart={(e) => {
              dragId.current = n.id;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', n.id);
            }}
            onDragOver={(e) => {
              if (!dragId.current) return;
              e.preventDefault();
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              const t = (e.clientY - rect.top) / rect.height;
              const where = isFrame && t > 0.3 && t < 0.7 ? 'inside' : t < 0.5 ? 'above' : 'below';
              if (drop?.id !== n.id || drop.where !== where) setDrop({ id: n.id, where });
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDrop();
            }}
            onDragEnd={() => {
              setDrop(null);
              dragId.current = null;
            }}
          >
            <span
              className={`layer-caret ${hasKids ? 'has-kids' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (hasKids) toggleCollapsed(n.id);
              }}
            >
              {hasKids ? isCollapsed ? <IconChevronRight size={10} weight="fill" /> : <IconChevronDown size={10} weight="fill" /> : null}
            </span>
            <span className={`layer-icon ${isFrame ? 'frame' : ''}`}>
              <NodeIcon n={n} />
            </span>
            {renaming === n.id ? (
              <input
                className="layer-rename"
                autoFocus
                defaultValue={n.name}
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    cancelRename.current = true;
                    e.currentTarget.blur();
                  }
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (!cancelRename.current && v && v !== n.name) updateNode(n.id, { name: v });
                  cancelRename.current = false;
                  setRenaming(null);
                }}
              />
            ) : (
              <span
                className="layer-name"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setRenaming(n.id);
                }}
              >
                {layerLabel(n)}
              </span>
            )}
            {slide !== null && kind !== 'email' && <span className="layer-slide">{kind === 'document' ? 'P' : 'S'}{slide}</span>}
            <span className={`layer-toggles ${n.locked || !n.visible ? 'pinned' : ''}`} onClick={(e) => e.stopPropagation()}>
              <IconButton
                className={`small ${n.locked ? 'active' : ''}`}
                title={n.locked ? 'Unlock' : 'Lock'}
                shortcut={`${MOD}+Shift+L`}
                side="right"
                onClick={() => updateNode(n.id, { locked: !n.locked })}
              >
                {n.locked ? <IconLock size={ICON_DENSE} /> : <IconUnlock size={ICON_DENSE} />}
              </IconButton>
              <IconButton
                className={`small ${!n.visible ? 'active' : ''}`}
                title={n.visible ? 'Hide' : 'Show'}
                shortcut={`${MOD}+Shift+H`}
                side="right"
                onClick={() => updateNode(n.id, { visible: !n.visible })}
              >
                {n.visible ? <IconEye size={ICON_DENSE} /> : <IconEyeOff size={ICON_DENSE} />}
              </IconButton>
            </span>
          </div>
        );
      })}
    </div>
  );
}
