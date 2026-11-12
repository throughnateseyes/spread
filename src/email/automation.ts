import { useStore, currentLayout } from '../store';
import { homeDir, native, picturesDir, writeFiles } from '../platform';
import { safeFileName } from '../project';
import { blobToDataUrl, fontFaceCss } from '../pdf';
import { buildEmailHtml, collectEmailImages, parseNameTags, type EmailImage } from './html';
import { fontSwaps, inboxChecks, inboxHtml, inboxMetrics, measureHtml, viewWidth, type InboxDevice, type InboxFonts, type InboxSource, type InboxView } from './preview';
import { renderEmailImages } from './images';
import { EMAIL_SECTIONS, EMAIL_TEMPLATES } from './templates';
import { sendChecks } from './checklist';
import { createEmailBoard, emailRootOf, insertEmailSection } from './boards';
import {
  hostEmailImages,
  imageUrlProblem,
  missingAddressText,
  pictureAddress,
  pictureFileName,
  pictureSources,
  pictureSrc,
  picturesToRender,
  picturesWithoutAddress,
  platformWarnings,
  refreshWordPress,
  renderedNames,
  RENTCAFE_NOTE,
  RENTCAFE_STEPS,
  setBoardHosting,
  setEmailPlatform,
  setImageUrls,
  type PictureSources,
  type WordPress,
} from './hosting';
import { findNode } from '../tree';
import type { Doc, FrameNode } from '../types';
import { createFromTemplate, insertSavedSection, useLibrary } from '../library';

// Automation (Claude) methods for email boards. Registered by src/automation.ts.

type Params = Record<string, any>;

function activeEmailRoot() {
  const doc = useStore.getState().doc;
  const root = emailRootOf(doc);
  if (!root) throw new Error(`Board "${doc.name}" is not an email board (create one with create_email).`);
  return { doc, root };
}

/**
 * Saves what this call says about the pictures on the board (baseUrl, urls, host, platform), so
 * every later export, Copy HTML and the Export window use it too. Returns the updated board.
 */
function savePictureParams(p: Params, root: FrameNode): Doc {
  const id = useStore.getState().doc.id;
  if (typeof p.baseUrl === 'string' && p.baseUrl.trim()) {
    const problem = imageUrlProblem(p.baseUrl);
    if (problem) throw new Error(`baseUrl "${p.baseUrl}": ${problem}`);
    setBoardHosting(id, { mode: 'base', baseUrl: p.baseUrl.trim() });
  } else if (p.host === 'wordpress') {
    setBoardHosting(id, { mode: 'wordpress' });
  }
  if (p.urls && typeof p.urls === 'object') {
    const pictures = new Set(collectEmailImages(root, currentLayout()).map((im) => im.nodeId));
    for (const [nodeId, url] of Object.entries(p.urls as Record<string, string | null>)) {
      if (!pictures.has(nodeId)) throw new Error(`urls: "${nodeId}" isn't a picture in this email. Picture ids: ${[...pictures].join(', ') || 'none'}.`);
      const problem = url?.trim() ? imageUrlProblem(url) : null;
      if (problem) throw new Error(`urls["${nodeId}"] "${url}": ${problem}`);
    }
    setImageUrls(id, p.urls);
  }
  if (p.platform === 'rentcafe' || p.platform === 'other') setEmailPlatform(id, p.platform);
  return useStore.getState().doc;
}

/** The board's picture addresses, after saving this call's params. */
async function sourcesFor(p: Params) {
  const { root } = activeEmailRoot();
  const doc = savePictureParams(p, root);
  const wp = await refreshWordPress();
  return { doc, root, layout: currentLayout(), wp, sources: pictureSources(doc, {}, wp) };
}

function compile(doc: Doc, root: FrameNode, p: Params, sources: PictureSources) {
  const result = buildEmailHtml(root, currentLayout(), {
    title: p.title ?? doc.email?.subject ?? doc.name,
    preheader: p.preheader ?? doc.email?.preheader ?? '',
    imageUrl: (nodeId, fileName) => pictureSrc(sources, nodeId, fileName),
    links: p.links,
    tracking: doc.email?.tracking,
  });
  return { ...result, warnings: platformWarnings(doc, result.warnings) };
}

/** Pictures still without a full web address, with their layer names, and what to do about it. */
function addressCheck(root: FrameNode, sources: PictureSources, images: EmailImage[], wp: WordPress) {
  const missing = picturesWithoutAddress(sources, images).map((m) => ({ ...m, name: parseNameTags(findNode([root], m.nodeId)?.name ?? '').clean || undefined }));
  return { missing, text: missing.length ? missingAddressText(sources, missing, 'claude', wp) : null };
}

/** What Claude sees for each picture: its exported name and where it will load from. */
function pictureList(sources: PictureSources, images: EmailImage[]) {
  return images.map((i) => ({ nodeId: i.nodeId, fileName: pictureFileName(sources, i.nodeId, i.fileName), src: pictureAddress(sources, i.nodeId, i.fileName), alt: i.alt, width: i.width, height: i.height }));
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
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

  /**
   * Compiled HTML (for Claude to read/check) without writing files. The HTML only comes back when
   * every picture has a full web address, or as a draft with allowRelative.
   */
  async email_html(p) {
    const { doc, root, layout, wp, sources } = await sourcesFor(p);
    // A folder address needs the exported (hashed) names, which come from rendering the pictures.
    const base = sources.hosting.mode === 'base' && sources.hosting.baseUrl?.trim();
    const toRender = picturesToRender(sources, collectEmailImages(root, layout));
    if (base && toRender.length) sources.files = renderedNames(await renderEmailImages(root, layout, toRender, p.scale ?? 2));
    const result = compile(doc, root, p, sources);
    const check = addressCheck(root, sources, result.images, wp);
    const ready = !check.missing.length;
    const max = p.maxChars ?? 60000;
    const html = result.html.length > max ? result.html.slice(0, max) + '\n<!-- …truncated -->' : result.html;
    return {
      ready,
      ...(check.text ? { notReady: check.text, missingAddresses: check.missing } : {}),
      bytes: result.bytes,
      warnings: result.warnings,
      placeholders: result.placeholders,
      images: pictureList(sources, result.images),
      platform: doc.email?.platform ?? null,
      ...(ready ? { html } : p.allowRelative ? { draft: true, html } : { html: null }),
    };
  },

  /** The five things to get right before sending, as the strip in the app shows them. */
  send_check() {
    const { doc, root } = activeEmailRoot();
    const checks = sendChecks(doc, root, currentLayout());
    return { ready: !checks.some((c) => c.level === 'fix'), toFix: checks.filter((c) => c.level === 'fix').length, checks: checks.map(({ label: _label, ...c }) => c) };
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
    // Pictures first, so they can be named by their content, uploaded, and the HTML compiled with their addresses.
    const { doc, root, layout, wp, sources } = await sourcesFor(p);
    const toRender = picturesToRender(sources, collectEmailImages(root, layout));
    const upload = sources.hosting.mode === 'wordpress' && toRender.length > 0;
    if (upload && !wp && p.host === 'wordpress') throw new Error('WordPress isn’t connected. Ask the user to connect it once in Export → Upload to WordPress, or upload the pictures elsewhere and export with baseUrl.');
    const images = await renderEmailImages(root, layout, toRender, p.scale ?? 2);
    sources.files = renderedNames(images);
    const hosting = upload && wp ? await hostEmailImages(images) : null;
    if (hosting) sources.uploaded = hosting.urls;
    const result = compile(doc, root, p, sources);
    const check = addressCheck(root, sources, result.images, wp);
    const ready = !check.missing.length;
    // HTML with broken picture addresses is what ends up pasted into a sending tool, so it's only written when ready (or asked for as a draft).
    const writeHtml = ready || !!p.allowRelative;
    const folder: string = p.folder ?? `${picturesDir ?? homeDir ?? '.'}/Spread/${safeFileName(doc.name)}-email-${today()}`;
    const files = [...images.map((i) => ({ name: i.fileName, data: i.blob })), ...(writeHtml ? [{ name: 'email.html', data: new Blob([result.html], { type: 'text/html' }) }] : [])];
    await writeFiles(folder, files);
    const rentcafe = doc.email?.platform === 'rentcafe';
    const copied = rentcafe && ready ? await copyToClipboard(result.html) : false;
    useStore.getState().toast(writeHtml ? `Exported email + ${images.length} images` : `Exported ${images.length} images. The HTML needs picture addresses first.`, writeHtml ? 'success' : 'info');
    return {
      ready,
      ...(check.text ? { notReady: check.text, missingAddresses: check.missing } : {}),
      folder,
      htmlFile: writeHtml ? 'email.html' : null,
      ...(!ready && writeHtml ? { draft: true } : {}),
      images: images.map((i) => i.fileName),
      pictures: pictureList(sources, result.images),
      bytes: result.bytes,
      warnings: result.warnings,
      placeholders: result.placeholders,
      subject: doc.email?.subject ?? null,
      preheader: p.preheader ?? doc.email?.preheader ?? null,
      platform: doc.email?.platform ?? null,
      ...(hosting ? { hosted: { uploaded: hosting.uploaded, reused: hosting.reused, urls: hosting.urls } } : {}),
      ...(rentcafe && ready ? { html: result.html, copiedToClipboard: copied, pasteSteps: RENTCAFE_STEPS, note: RENTCAFE_NOTE } : {}),
    };
  },
};
