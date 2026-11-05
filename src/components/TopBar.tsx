import { useEffect, useRef } from 'react';
import { openSwitcher } from './Switcher';
import { MOD, useStore } from '../store';
import type { Tool } from '../types';
import { Button, IconButton } from '../ui/controls';
import { Menu, useMenuButton, type MenuItem } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { BrandMark } from '../ui/BrandMark';
import {
  ICON_DENSE,
  IconChevronDown,
  IconEllipse,
  IconExport,
  IconFrame,
  IconHand,
  IconMove,
  IconPhotoFrame,
  IconPreview,
  IconRect,
  IconRedo,
  IconSparkle,
  IconComment,
  IconText,
  IconUndo,
  type Icon,
} from '../ui/icons';
import { newProject, openProject, saveProject } from '../project';
import { pickFonts } from '../importer';
import { setThemePref, useTheme } from '../theme';
import { isElectron } from '../platform';
import { toggleChat } from './ClaudePanel';
import { dotColors, setProjectBrand, useActiveBrand, useBrands } from '../brand';

const TOOLS_BEFORE: { id: Tool; Icon: Icon; label: string; key: string }[] = [
  { id: 'move', Icon: IconMove, label: 'Move', key: 'V' },
  { id: 'hand', Icon: IconHand, label: 'Hand tool', key: 'H' },
  { id: 'frame', Icon: IconFrame, label: 'Frame', key: 'F' },
  { id: 'image', Icon: IconPhotoFrame, label: 'Photo frame', key: 'P' },
];
const SHAPES: { id: Tool; Icon: Icon; label: string; key: string }[] = [
  { id: 'rect', Icon: IconRect, label: 'Rectangle', key: 'R' },
  { id: 'ellipse', Icon: IconEllipse, label: 'Ellipse', key: 'O' },
];

const zoomEvent = (name: string, detail?: unknown) => () => window.dispatchEvent(new CustomEvent(name, { detail }));

export default function TopBar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const name = useStore((s) => s.doc.name);
  const kind = useStore((s) => s.doc.kind);
  const zoom = useStore((s) => s.view.zoom);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const dirty = useStore((s) => s.dirty);
  const s = useStore.getState;
  const nameAtFocus = useRef(name);

  return (
    <div className="topbar">
      <div className="topbar-left">
        <SpreadMenu />
        <div className="divider" />
        <div className="toolgroup" role="toolbar" aria-label="Tools">
          {TOOLS_BEFORE.map((t) => (
            <IconButton key={t.id} title={t.label} shortcut={t.key} active={tool === t.id} onClick={() => setTool(t.id)}>
              <t.Icon />
            </IconButton>
          ))}
          <ShapeTool tool={tool} setTool={setTool} />
          <IconButton title="Text" shortcut="T" active={tool === 'text'} onClick={() => setTool('text')}>
            <IconText />
          </IconButton>
          {isElectron && (
            <IconButton title="Comment for Claude" shortcut="C" active={tool === 'comment'} onClick={() => setTool('comment')}>
              <IconComment />
            </IconButton>
          )}
        </div>
        <div className="divider" />
        <IconButton title="Undo" shortcut={`${MOD}+Z`} disabled={!canUndo} onClick={() => s().undo()}>
          <IconUndo />
        </IconButton>
        <IconButton title="Redo" shortcut={`${MOD}+Shift+Z`} disabled={!canRedo} onClick={() => s().redo()}>
          <IconRedo />
        </IconButton>
      </div>

      <div className="topbar-center">
        <Tooltip label="Board name, used for export file names">
          <input
            className="doc-name"
            value={name}
            aria-label="Board name"
            spellCheck={false}
            onFocus={(e) => {
              nameAtFocus.current = name;
              e.currentTarget.select();
            }}
            onChange={(e) => s().change((d) => void (d.name = e.target.value), 'doc-name')}
            onBlur={(e) => {
              if (!e.currentTarget.value.trim()) s().change((d) => void (d.name = nameAtFocus.current || 'Untitled'), 'doc-name');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (name !== nameAtFocus.current) s().change((d) => void (d.name = nameAtFocus.current), 'doc-name');
                e.currentTarget.blur();
              }
            }}
          />
        </Tooltip>
        {dirty && (
          <div className="topbar-meta">
            <Tooltip label={isElectron ? 'Saving…' : 'Unsaved changes, autosaved locally'}>
              <span className="topbar-dirty" aria-label="Unsaved changes" />
            </Tooltip>
          </div>
        )}
        {isElectron && <BrandSwitch />}
      </div>

      <div className="topbar-right">
        <ZoomMenu zoom={zoom} />
        <div className="divider" />
        {isElectron && <ClaudeButton />}
        {kind === 'carousel' && (
          <Button onClick={() => s().set({ modal: 'preview' })} title="Swipe through it like Instagram">
            <IconPreview size={ICON_DENSE} weight="fill" /> Preview
          </Button>
        )}
        {kind === 'email' && (
          <Button onClick={() => s().set({ modal: 'inbox' })} title="See it as an inbox will: desktop, phone, fallback fonts, images off">
            <IconPreview size={ICON_DENSE} weight="fill" /> Preview
          </Button>
        )}
        <Button primary onClick={() => s().set({ modal: 'export' })} title={kind === 'document' ? 'Export PDF or images' : kind === 'email' ? 'Export HTML and images' : 'Export slides'} shortcut={`${MOD}+Shift+E`}>
          <IconExport size={ICON_DENSE} /> Export
        </Button>
      </div>
    </div>
  );
}

/** The app menu behind the brand mark: file actions, fonts, theme and the shortcut list. */
function SpreadMenu() {
  const { at, close, triggerProps } = useMenuButton();
  const theme = useTheme();
  const set = useStore((s) => s.set);
  const items: MenuItem[] = [
    ...(isElectron ? [{ label: 'Go to project…', kbd: `${MOD}+K`, fn: () => openSwitcher() }, null] : [{ label: 'New project', fn: () => newProject() }]),
    { label: 'Open…', kbd: `${MOD}+O`, fn: () => openProject() },
    { label: 'Save', kbd: `${MOD}+S`, fn: () => saveProject() },
    { label: 'Save as…', kbd: `${MOD}+Shift+S`, fn: () => saveProject(true) },
    null,
    { label: 'Upload fonts…', fn: pickFonts },
    ...(isElectron ? [{ label: 'Brands…', fn: () => set({ modal: 'brands' }) }, { label: 'Library…', fn: () => set({ modal: 'library' }) }, { label: 'Connect Claude…', fn: () => set({ modal: 'claude' }) }] : []),
    null,
    { label: 'Match system theme', checked: theme.pref === 'system', fn: () => setThemePref('system') },
    { label: 'Light theme', checked: theme.pref === 'light', fn: () => setThemePref('light') },
    { label: 'Dark theme', checked: theme.pref === 'dark', fn: () => setThemePref('dark') },
    null,
    { label: 'Keyboard shortcuts', kbd: '?', fn: () => set({ modal: 'shortcuts' }) },
  ];
  return (
    <>
      <Tooltip label="Spread menu" disabled={!!at}>
        <button className={`brand ${at ? 'open' : ''}`} aria-label="Spread menu" {...triggerProps}>
          <BrandMark />
          <span className="brand-text">Spread</span>
          <IconChevronDown size={12} />
        </button>
      </Tooltip>
      {at && <Menu at={at} items={items} onClose={close} />}
    </>
  );
}

/** Which brand this project is designed in, or none. Switching is per project and undoable. */
function BrandSwitch() {
  const brands = useBrands((s) => s.brands);
  const active = useActiveBrand();
  const { at, close, triggerProps } = useMenuButton();
  const items: MenuItem[] = [
    { label: 'No brand (personal)', checked: !active, fn: () => void setProjectBrand(null) },
    ...brands.map((b) => ({ label: b.name, checked: active?.id === b.id, fn: () => void setProjectBrand(b.id) })),
    null,
    { label: 'Manage brands…', fn: () => useStore.getState().set({ modal: 'brands' }) },
  ];
  return (
    <>
      <Tooltip label={active ? `Designed in the ${active.name} brand` : 'No brand: Claude designs without one'} disabled={!!at}>
        <button className={`brand-switch ${active ? 'on' : ''} ${at ? 'open' : ''}`} aria-label="Project brand" {...triggerProps}>
          {active && (
            <span className="brands-dots">
              {dotColors(active).map((c, i) => (
                <i key={i} style={{ background: c.hex }} />
              ))}
            </span>
          )}
          {active ? active.name : 'No brand'}
          <IconChevronDown size={10} />
        </button>
      </Tooltip>
      {at && <Menu at={at} items={items} onClose={close} />}
    </>
  );
}

const INTRO_SEEN = 'spread.chatIntroSeen';

/** Opens Connect Claude; the dot turns green once Claude is set up or has used Spread. The dialog opens by itself once, on first run. */
function ClaudeButton() {
  const open = useStore((s) => s.chatOpen);
  // First run: open the panel once so people find it.
  useEffect(() => {
    try {
      if (localStorage.getItem(INTRO_SEEN)) return;
      localStorage.setItem(INTRO_SEEN, '1');
    } catch {
      return;
    }
    toggleChat(true);
  }, []);
  return (
    <Button className={`claude-btn ${open ? 'on' : ''}`} onClick={() => toggleChat()} title={open ? 'Hide Claude' : 'Design with Claude'} shortcut={`${MOD}+J`}>
      <IconSparkle size={ICON_DENSE} weight={open ? 'fill' : 'regular'} /> Claude
    </Button>
  );
}

/** Rectangle and Ellipse share one toolbar slot (R / O still pick either); the caret switches. */
function ShapeTool({ tool, setTool }: { tool: Tool; setTool: (t: Tool) => void }) {
  const last = useRef<Tool>('rect');
  if (tool === 'rect' || tool === 'ellipse') last.current = tool;
  const cur = SHAPES.find((t) => t.id === last.current)!;
  const on = tool === 'rect' || tool === 'ellipse';
  const { at, close, triggerProps } = useMenuButton();
  const items: MenuItem[] = SHAPES.map((t) => ({ label: t.label, kbd: t.key, checked: last.current === t.id, fn: () => setTool(t.id) }));
  return (
    <div className={`split-tool ${on ? 'on' : ''}`}>
      <IconButton title={cur.label} shortcut={cur.key} active={on} onClick={() => setTool(cur.id)}>
        <cur.Icon />
      </IconButton>
      <Tooltip label="Shapes" disabled={!!at}>
        <button className={`split-caret ${at ? 'open' : ''}`} aria-label="Choose shape" {...triggerProps}>
          <IconChevronDown size={10} />
        </button>
      </Tooltip>
      {at && <Menu at={at} items={items} onClose={close} />}
    </div>
  );
}

/** Zoom level; its menu holds the zoom commands and the canvas view toggles. */
function ZoomMenu({ zoom }: { zoom: number }) {
  const { at, close, triggerProps } = useMenuButton();
  const hasSel = useStore((s) => s.selection.length > 0);
  const showSeams = useStore((s) => s.showSeams);
  const showComments = useStore((s) => s.showComments);
  const showIgCrop = useStore((s) => s.showIgCrop);
  const snap = useStore((s) => s.snap);
  const grid = useStore((s) => s.doc.grid.visible);
  const { set, change } = useStore.getState();
  const items: MenuItem[] = [
    { label: 'Zoom in', kbd: `${MOD}+=`, fn: zoomEvent('spread:zoom-step', 1) },
    { label: 'Zoom out', kbd: `${MOD}+−`, fn: zoomEvent('spread:zoom-step', -1) },
    { label: 'Zoom to 100%', kbd: 'Shift+0', fn: zoomEvent('spread:zoom-to', 1) },
    { label: 'Zoom to fit all', kbd: 'Shift+1', fn: zoomEvent('spread:fit', 'all') },
    { label: 'Zoom to selection', kbd: 'Shift+2', disabled: !hasSel, fn: zoomEvent('spread:zoom-selection') },
    { label: 'Zoom to row', kbd: 'Shift+3', fn: zoomEvent('spread:fit') },
    null,
    { label: 'Slide seams', checked: showSeams, fn: () => set({ showSeams: !showSeams }) },
    ...(isElectron ? [{ label: 'Comments', checked: showComments, fn: () => set({ showComments: !showComments, openComment: null }) }] : []),
    { label: 'Layout grid', kbd: `${MOD}+'`, checked: grid, fn: () => change((d) => void (d.grid.visible = !d.grid.visible)) },
    { label: 'IG profile-grid crop (3:4)', checked: showIgCrop, fn: () => set({ showIgCrop: !showIgCrop }) },
    { label: 'Snap to grid, seams & layers', checked: snap, fn: () => set({ snap: !snap }) },
  ];
  return (
    <>
      <Tooltip label="Zoom and view options" disabled={!!at}>
        <button className={`topbar-zoom-label ${at ? 'open' : ''}`} aria-label="Zoom and view options" {...triggerProps}>
          {Math.round(zoom * 100)}%
          <IconChevronDown size={10} />
        </button>
      </Tooltip>
      {at && <Menu at={at} items={items} onClose={close} />}
    </>
  );
}
