import { memo } from 'react';
import { Ellipse, Group, Rect, Shape, Text } from 'react-konva';
import type Konva from 'konva';
import type { Box, FrameNode, ImageNode, SceneNode, ShapeNode, TextNode } from '../types';
import type { LayoutMap } from '../layout';
import { displayText, letterSpacingPx, textFontStyle } from '../layout';
import { cropGeometry, drawSource, ellipsePaintProps, filterString, imageSource, isExporting, paintProps, roundRectPath, shadowProps } from '../render';
import { backdropScene, hasEffects, paintEffects } from '../effects';

export interface RenderState {
  layout: LayoutMap;
  editingTextId: string | null;
  croppingId: string | null;
  /** Live offset for a child being dragged inside an auto layout frame. */
  dragOffset: { id: string; dx: number; dy: number } | null;
}

// Render state travels as a prop (not context) so a memoised leaf only re-renders when its own
// node, its own box or its own editing flags change — editing one layer no longer re-renders all.

export function SceneNodes({ nodes, state }: { nodes: SceneNode[]; state: RenderState }) {
  return (
    <>
      {nodes.map((n) => (
        <NodeView key={n.id} node={n} state={state} />
      ))}
    </>
  );
}

function sameBox(a: Box | undefined, b: Box | undefined) {
  return a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
}

function offOf(s: RenderState, id: string) {
  return s.dragOffset?.id === id ? s.dragOffset : null;
}

const NodeView = memo(
  function NodeView({ node, state }: { node: SceneNode; state: RenderState }) {
    const box = state.layout.get(node.id);
    if (!box) return null;
    const off = offOf(state, node.id);
    const common = {
      id: node.id,
      name: 'node',
      x: box.x + (off?.dx ?? 0),
      y: box.y + (off?.dy ?? 0),
      rotation: node.rotation,
      opacity: node.opacity,
      visible: node.visible,
    };
    const { w, h } = box;
    switch (node.type) {
      case 'image':
        return (
          <Group {...common}>
            <ImageBody n={node} w={w} h={h} />
          </Group>
        );
      case 'text':
        return (
          <Group {...common}>
            <TextBody n={node} w={w} h={h} hidden={state.editingTextId === node.id} />
          </Group>
        );
      case 'rect':
      case 'ellipse':
        return (
          <Group {...common}>
            <ShapeBody n={node} w={w} h={h} />
          </Group>
        );
      case 'frame':
        return <FrameView n={node} common={common} w={w} h={h} state={state} />;
    }
  },
  (a, b) => {
    if (a.node !== b.node) return false;
    if (a.state === b.state) return true;
    // Frames pass the state to their children: let them re-render and let the children bail out.
    if (a.node.type === 'frame') return false;
    const id = a.node.id;
    if (!sameBox(a.state.layout.get(id), b.state.layout.get(id))) return false;
    if ((a.state.editingTextId === id) !== (b.state.editingTextId === id)) return false;
    const ao = offOf(a.state, id);
    const bo = offOf(b.state, id);
    return ao?.dx === bo?.dx && ao?.dy === bo?.dy;
  },
);

function ImageBody({ n, w, h }: { n: ImageNode; w: number; h: number }) {
  const sceneFunc = (kctx: Konva.Context) => {
    const c = (kctx as any)._context as CanvasRenderingContext2D;
    c.save();
    roundRectPath(c, 0, 0, w, h, n.radius);
    c.clip();
    // Device px per node px, from the live transform (zoom × pixel ratio × export scale).
    const m = c.getTransform();
    const dev = Math.hypot(m.a, m.b) || 1;
    const full = imageSource(n.assetId);
    if (!full) {
      c.fillStyle = '#E4E4E7';
      c.fillRect(0, 0, w, h);
      if (Math.min(w, h) * dev >= 60) {
        c.fillStyle = '#A1A1AA';
        const fs = Math.max(12, Math.min(w, h) * 0.07);
        c.font = `600 ${fs}px "Inter Variable", sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('Drop photo', w / 2, h / 2);
      }
    } else if (hasEffects(n)) {
      paintEffects(c, n, w, h, full, dev, isExporting());
    } else {
      // Pick the smallest mip level that still covers the on-screen size.
      const g0 = cropGeometry(n, w, h, full.width, full.height);
      const ds = drawSource(n, g0.k * dev) ?? { src: full, filtered: false };
      const src = ds.src;
      const g = src.width === full.width && src.height === full.height ? g0 : cropGeometry(n, w, h, src.width, src.height);
      if (!ds.filtered) c.filter = filterString(n);
      if (n.flipX || n.flipY) {
        c.translate(n.flipX ? w : 0, n.flipY ? h : 0);
        c.scale(n.flipX ? -1 : 1, n.flipY ? -1 : 1);
      }
      c.imageSmoothingQuality = 'high';
      c.drawImage(src, g.sx, g.sy, g.sw, g.sh, g.dx, g.dy, g.dw, g.dh);
    }
    c.restore();
    if (n.stroke && n.strokeWidth > 0) {
      c.save();
      roundRectPath(c, n.strokeWidth / 2, n.strokeWidth / 2, w - n.strokeWidth, h - n.strokeWidth, n.radius);
      c.strokeStyle = n.stroke;
      c.lineWidth = n.strokeWidth;
      c.stroke();
      c.restore();
    }
  };
  const hitFunc = (kctx: Konva.Context, shape: Konva.Shape) => {
    kctx.beginPath();
    kctx.rect(0, 0, w, h);
    kctx.closePath();
    kctx.fillStrokeShape(shape);
  };
  return (
    <>
      {n.shadow?.enabled && <Rect width={w} height={h} cornerRadius={n.radius} fill="#000" {...shadowProps(n)} listening={false} />}
      <Shape sceneFunc={sceneFunc} hitFunc={hitFunc} width={w} height={h} fill="#000" perfectDrawEnabled={false} />
    </>
  );
}

function TextBody({ n, w, h, hidden }: { n: TextNode; w: number; h: number; hidden: boolean }) {
  return (
    <>
      <Rect width={w} height={h} fill="rgba(0,0,0,0)" />
      <Text
        text={displayText(n)}
        width={w}
        fontFamily={n.fontFamily}
        fontStyle={textFontStyle(n)}
        fontSize={n.fontSize}
        lineHeight={n.lineHeight}
        letterSpacing={letterSpacingPx(n)}
        align={n.align}
        fill={n.fill}
        textDecoration={n.decoration === 'none' ? '' : n.decoration}
        wrap="word"
        opacity={hidden ? 0 : 1}
        perfectDrawEnabled={false}
        listening={false}
        {...shadowProps(n)}
      />
    </>
  );
}

function BackdropBlur({ n, w, h }: { n: ShapeNode | FrameNode; w: number; h: number }) {
  if (!n.backdropBlur) return null;
  return <Shape sceneFunc={backdropScene(n, w, h)} width={w} height={h} listening={false} perfectDrawEnabled={false} />;
}

function ShapeBody({ n, w, h }: { n: ShapeNode; w: number; h: number }) {
  const stroke = n.stroke && n.strokeWidth > 0 ? { stroke: n.stroke, strokeWidth: n.strokeWidth } : {};
  if (n.type === 'ellipse') {
    const paint = ellipsePaintProps(n.fill, w, h);
    return (
      <>
        <BackdropBlur n={n} w={w} h={h} />
        <Rect width={w} height={h} fill="rgba(0,0,0,0)" listening={false} />
        <Ellipse x={w / 2} y={h / 2} radiusX={w / 2} radiusY={h / 2} {...paint} {...stroke} {...shadowProps(n)} perfectDrawEnabled={false} />
      </>
    );
  }
  return (
    <>
      <BackdropBlur n={n} w={w} h={h} />
      <Rect width={w} height={h} cornerRadius={n.radius} {...paintProps(n.fill, w, h)} {...stroke} {...shadowProps(n)} perfectDrawEnabled={false} />
    </>
  );
}

function FrameView({ n, common, w, h, state }: { n: FrameNode; common: Record<string, unknown>; w: number; h: number; state: RenderState }) {
  let bg: Konva.Rect | null = null;
  return (
    <Group
      {...common}
      ref={(g) => {
        // Transformer & selection bounds should be the frame box, not children overflowing it.
        if (g) (g as any).getClientRect = (cfg?: any) => (bg ? bg.getClientRect(cfg) : { x: 0, y: 0, width: w, height: h });
      }}
    >
      <BackdropBlur n={n} w={w} h={h} />
      <Rect
        ref={(r) => {
          bg = r;
        }}
        width={w}
        height={h}
        cornerRadius={n.radius}
        {...paintProps(n.fill, w, h)}
        {...(n.stroke && n.strokeWidth > 0 ? { stroke: n.stroke, strokeWidth: n.strokeWidth } : {})}
        {...shadowProps(n)}
        perfectDrawEnabled={false}
      />
      <Group
        clipFunc={
          n.clip
            ? (kctx: Konva.Context) => {
                roundRectPath((kctx as any)._context, 0, 0, w, h, n.radius);
              }
            : undefined
        }
      >
        <SceneNodes nodes={n.children} state={state} />
      </Group>
    </Group>
  );
}
