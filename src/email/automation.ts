import { useStore, currentLayout } from '../store';
import { homeDir, native, picturesDir, writeFiles } from '../platform';
import { safeFileName } from '../project';
import { blobToDataUrl, fontFaceCss } from '../pdf';
import { buildEmailHtml, collectEmailImages, joinUrl } from './html';
import { fontSwaps, inboxChecks, inboxHtml, inboxMetrics, measureHtml, viewWidth, type InboxDevice, type InboxFonts, type InboxSource, type InboxView } from './preview';
import { renderEmailImages } from './images';
import { EMAIL_SECTIONS, EMAIL_TEMPLATES } from './templates';
import { createEmailBoard, emailRootOf, insertEmailSection } from './boards';
import { hostEmailImages } from './hosting';
import { createFromTemplate, insertSavedSection, useLibrary } from '../library';

// Automation (Claude) methods for email boards. Registered by src/automation.ts.

type Params = Record<string, any>;

function activeEmailRoot() {
  const doc = useStore.getState().doc;
  const root = emailRootOf(doc);
  if (!root) throw new Error(`Board "${doc.name}" is not an email board (create one with create_email).`);
  return { doc, root };
}

function compile(p: Params, hosted: Record<string, string> = {}) {
  const { doc, root } = activeEmailRoot();
  const layout = currentLayout();
  const urls: Record<string, string> = { ...hosted, ...(p.urls ?? {}) };
  const base: string = p.baseUrl ?? '';
  const result = buildEmailHtml(root, layout, {
    title: p.title ?? doc.email?.subject ?? doc.name,
    preheader: p.preheader ?? doc.email?.preheader ?? '',
    imageUrl: (nodeId, fileName) => urls[nodeId] ?? (base ? joinUrl(base, fileName) : fileName),
    links: p.links,
    tracking: doc.email?.tracking,
  });
  return { doc, root, layout, result };
}

function base64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const emailHandlers: Record<string, (p: Params) => Promise<unknown> | unknown> = {
  list_email_templates: () => {
    const brandId = useStore.getState().project.brandId ?? null;
    const saved = useLibrary.getState().templates.filter((t) => t.boardKind === 'email' && (t.brandId === null || t.brandId === brandId));
    const mine = (scope: 'board' | 'section') =>
      saved.filter((t) => t.scope === scope).map((t) => ({ id: `saved:${t.id}`, name: t.name, description: t.description ?? 'Saved by the user', saved: true }));
    return {
      templates: [...mine('board'), ...EMAIL_TEMPLATES.map(({ id, name, description }) => ({ id, name, description }))],
      sections: [...mine('section'), ...EMAIL_SECTIONS.map(({ id, name, description }) => ({ id, name, description }))],
      note: saved.length ? 'Ids starting saved: are the user\'s own templates and sections. Prefer them: they are the house look.' : undefined,
    };
  },

  async create_email(p) {
    const tpl = p.template ?? 'blank';
    if (String(tpl).startsWith('saved:')) return { boardId: await createFromTemplate(tpl, { name: p.name, note: p.note, photoIds: p.photoIds }) };
    if (tpl !== 'blank' && !EMAIL_TEMPLATES.some((t) => t.id === tpl)) {
      throw new Error(`Unknown template "${tpl}". Use one of: ${EMAIL_TEMPLATES.map((t) => t.id).join(', ')}, blank`);
    }
    const id = createEmailBoard(tpl, p.name, p.photoIds);
    if (p.note) useStore.getState().updateBoard(id, { note: p.note });
    return { boardId: id };
  },

  async add_email_section(p) {
    if (String(p.sectionId).startsWith('saved:')) {
      activeEmailRoot();
      return { sectionId: await insertSavedSection(p.sectionId, { index: p.index, photoIds: p.photoIds }) };
    }
    if (!EMAIL_SECTIONS.some((s) => s.id === p.sectionId)) {
      throw new Error(`Unknown section "${p.sectionId}". Use one of: ${EMAIL_SECTIONS.map((s) => s.id).join(', ')}`);
    }
    activeEmailRoot();
    const id = insertEmailSection(p.sectionId, p.index, p.photoIds);
    return { sectionId: id };
  },

  /** Compiled HTML (for Claude to read/check) without writing files. */
  email_html(p) {
    const { result } = compile(p);
    const max = p.maxChars ?? 60000;
    return {
      bytes: result.bytes,
      warnings: result.warnings,
      placeholders: result.placeholders,
      images: result.images.map((i) => ({ nodeId: i.nodeId, fileName: i.fileName, alt: i.alt, width: i.width, height: i.height })),
      html: result.html.length > max ? result.html.slice(0, max) + '\n<!-- …truncated -->' : result.html,
    };
  },

  /** The compiled email as an inbox shows it: checks always, pictures when the desktop app can take them. */
  async preview_email(p) {
    const { doc, root } = activeEmailRoot();
    const layout = currentLayout();
    const compiled = buildEmailHtml(root, layout, { title: '', imageUrl: (_id, f) => f, tracking: doc.email?.tracking });
    const swaps = fontSwaps(compiled.fonts);
    const fontCss = await fontFaceCss(new Set(swaps.map((s) => s.family)));
    const views: InboxView[] = ((p.views as { device?: InboxDevice; fonts?: InboxFonts; images?: boolean }[] | undefined) ?? [{ device: 'desktop' }, { device: 'mobile' }]).map((v) => ({
      device: v.device ?? 'desktop',
      fonts: v.fonts ?? 'fallback',
      images: v.images ?? true,
    }));
    const src: InboxSource = { root, layout, title: doc.email?.subject ?? '', preheader: doc.email?.preheader ?? '', tracking: doc.email?.tracking, pictures: {} };
    const metrics = await inboxMetrics(src, fontCss, swaps.length > 0);
    const checks = inboxChecks(src, src.title, compiled.images, compiled.fonts, metrics).map(({ view: _view, ...c }) => c);
    const heights = { desktop: metrics.desktop.fallback.height, phone: metrics.mobile.fallback.height };
    const base = { subject: doc.email?.subject ?? null, preheader: doc.email?.preheader ?? null, checks, heights };
    if (!native) return { ...base, images: [], note: 'Pictures of the preview need the desktop app.' };
    if (views.some((v) => v.images)) {
      for (const f of await renderEmailImages(root, layout, compiled.images, 1)) src.pictures[f.nodeId] = await blobToDataUrl(f.blob);
    }
    const images = [];
    for (const v of views) {
      const html = inboxHtml(src, v, fontCss);
      const width = viewWidth(v.device);
      const { height } = await measureHtml(html, width);
      const data = await native.renderHtml({ html, width, height });
      images.push({ label: `${v.device === 'mobile' ? 'Phone' : 'Desktop'}, ${v.fonts === 'design' ? 'your fonts' : 'fallback fonts'}, images ${v.images ? 'on' : 'off'} (${width}×${height})`, base64: base64(data), mime: 'image/jpeg' });
    }
    return { ...base, images };
  },

  async export_email(p) {
    // Pictures first, so they can be uploaded and the HTML compiled with their hosted URLs.
    const { root } = activeEmailRoot();
    const layout = currentLayout();
    const images = await renderEmailImages(root, layout, collectEmailImages(root, layout), p.scale ?? 2);
    const hosting = p.host === 'wordpress' && images.length ? await hostEmailImages(images) : null;
    const { doc, result } = compile(p, hosting?.urls);
    const folder: string = p.folder ?? `${picturesDir ?? homeDir ?? '.'}/Spread/${safeFileName(doc.name)}-email-${today()}`;
    const files = [
      ...images.map((i) => ({ name: i.fileName, data: i.blob })),
      { name: 'email.html', data: new Blob([result.html], { type: 'text/html' }) },
    ];
    await writeFiles(folder, files);
    useStore.getState().toast(`Exported email + ${images.length} images`, 'success');
    return {
      folder,
      htmlFile: 'email.html',
      images: images.map((i) => i.fileName),
      bytes: result.bytes,
      warnings: result.warnings,
      placeholders: result.placeholders,
      subject: doc.email?.subject ?? null,
      preheader: p.preheader ?? doc.email?.preheader ?? null,
      ...(hosting ? { hosted: { uploaded: hosting.uploaded, reused: hosting.reused, urls: hosting.urls } } : {}),
      note:
        hosting || p.baseUrl || p.urls || !images.length
          ? undefined
          : 'Image src attributes are bare file names. If WordPress is connected (the user connects it once in Export → Upload to WordPress), export again with host: "wordpress"; otherwise ask for the base URL the images were uploaded to and export with baseUrl.',
    };
  },
};
