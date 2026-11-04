import { create } from 'zustand';
import { guessMime, registerFont } from './assets';
import { BUNDLED_FONTS, SYSTEM_FONTS, uploadedFonts } from './fonts';
import { native } from './platform';
import { useStore } from './store';
import { uid } from './tree';
import type { AssetMeta, Brand, BrandColor, BrandFont, BrandRule } from './types';

// Brand kits in the renderer: the library (loaded from ~/.spread/brands through the desktop app) and
// the project's choice of brand. A project uses one brand or none; switching never touches the
// design itself, it changes what Claude designs with, what the layout check holds the board to,
// and which colors and fonts the panels offer first.

export type LibraryBrand = Brand & { dir?: string };

export const useBrands = create<{ brands: LibraryBrand[]; loaded: boolean }>(() => ({ brands: [], loaded: false }));

export async function loadBrands() {
  if (!native) return useBrands.setState({ loaded: true });
  try {
    useBrands.setState({ brands: await native.brandsList(), loaded: true });
  } catch (e) {
    console.warn('Could not load brands', e);
    useBrands.setState({ loaded: true });
  }
}

export const brandById = (id: string | null | undefined) => (id ? (useBrands.getState().brands.find((b) => b.id === id) ?? null) : null);

/** The open project's brand, or null for a project with no brand. */
export const activeBrand = () => brandById(useStore.getState().project.brandId);

export function useActiveBrand() {
  const id = useStore((s) => s.project.brandId);
  return useBrands((s) => (id ? (s.brands.find((b) => b.id === id) ?? null) : null));
}

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'brand';

/** Compares families loosely: "DM Sans" is the bundled "DM Sans Variable". */
export const fontKey = (family: string) =>
  family
    .toLowerCase()
    .replace(/\s+variable$/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The family Spread actually has for a brand font (bundled, uploaded or system), else the name as given. */
export function resolveFamily(family: string) {
  const k = fontKey(family);
  const pool = [...BUNDLED_FONTS, ...uploadedFonts(useStore.getState().doc), ...SYSTEM_FONTS];
  return pool.find((f) => fontKey(f.family) === k)?.family ?? family;
}

function cleanHex(h: unknown) {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(h ?? '').trim());
  return m ? '#' + m[1].toUpperCase() : null;
}

const nums = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => n > 0 && Number.isFinite(n)))].sort((a, b) => a - b) : undefined);

/** Builds a valid brand from loose input (Claude's import, the editor, a project file). */
export function normalizeBrand(input: Partial<Brand> & { name: string }, prev?: Brand | null): Brand {
  const colors: BrandColor[] = (input.colors ?? prev?.colors ?? [])
    .map((c) => ({ name: String(c.name ?? '').trim() || 'Color', hex: cleanHex(c.hex) ?? '', ...(c.role ? { role: String(c.role) } : {}) }))
    .filter((c) => c.hex);
  const fonts: BrandFont[] = (input.fonts ?? prev?.fonts ?? [])
    .filter((f) => f && String(f.family ?? '').trim())
    .map((f) => ({ family: String(f.family).trim(), ...(f.role ? { role: String(f.role) } : {}), ...(f.files?.length ? { files: f.files } : {}) }));
  const rules: BrandRule[] = (input.rules ?? prev?.rules ?? [])
    .filter((r) => r && String(r.text ?? '').trim())
    .map((r) => ({ id: r.id || uid(), kind: r.kind === 'dont' ? 'dont' : 'do', text: String(r.text).trim(), source: r.source === 'learned' ? 'learned' : 'brand', addedAt: r.addedAt || Date.now() }));
  const ts = input.typeScale ?? prev?.typeScale;
  const sp = input.spacing ?? prev?.spacing;
  return {
    version: 1,
    id: prev?.id ?? input.id ?? slugify(input.name),
    name: input.name.trim(),
    ...(input.description ?? prev?.description ? { description: input.description ?? prev?.description } : {}),
    colors,
    fonts,
    ...(ts ? { typeScale: { ...(nums(ts.px)?.length ? { px: nums(ts.px) } : {}), ...(nums(ts.pt)?.length ? { pt: nums(ts.pt) } : {}) } } : {}),
    ...(sp ? { spacing: { ...(sp.px ? { px: Number(sp.px) } : {}), ...(sp.pt ? { pt: Number(sp.pt) } : {}) } } : {}),
    ...(input.voice ?? prev?.voice ? { voice: input.voice ?? prev?.voice } : {}),
    rules,
    ...(input.designDoc ?? prev?.designDoc ? { designDoc: input.designDoc ?? prev?.designDoc } : {}),
    ...(input.source ?? prev?.source ? { source: input.source ?? prev?.source } : {}),
    updatedAt: Date.now(),
  };
}

export async function saveBrand(brand: Brand, fontFiles?: { path: string; family: string }[]): Promise<LibraryBrand> {
  if (!native) throw new Error('Brands need the Spread desktop app');
  const saved = await native.brandSave({ brand, fontFiles });
  useBrands.setState((s) => ({ brands: [...s.brands.filter((b) => b.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)) }));
  if (useStore.getState().project.brandId === saved.id) await ensureBrandFonts(saved);
  return saved;
}

export async function deleteBrand(id: string) {
  if (!native) return;
  await native.brandDelete(id);
  useBrands.setState((s) => ({ brands: s.brands.filter((b) => b.id !== id) }));
  if (useStore.getState().project.brandId === id) await setProjectBrand(null);
}

/** Switches the open project to a brand (or to none). Undoable; the design itself is untouched. */
export async function setProjectBrand(id: string | null) {
  const s = useStore.getState();
  if ((s.project.brandId ?? null) === id) return;
  s.changeProject((p) => {
    p.brandId = id;
  });
  const b = brandById(id);
  if (b) await ensureBrandFonts(b);
}

/** Loads the brand's font files into the project (so they render, export and travel with the file). */
export async function ensureBrandFonts(b: LibraryBrand) {
  if (!native || !b.dir) return;
  const s = useStore.getState();
  const have = new Set(Object.values(s.doc.assets).filter((a) => a.kind === 'font').map((a) => a.name));
  const metas: AssetMeta[] = [];
  for (const f of b.fonts) {
    for (const file of f.files ?? []) {
      if (have.has(file)) continue;
      try {
        const r = await native.readFile(`${b.dir}/fonts/${file}`);
        metas.push(await registerFont(new Blob([r.data as BlobPart], { type: guessMime(file) }), file, undefined, f.family));
      } catch (e) {
        console.warn(`Brand font ${file} missing`, e);
      }
    }
  }
  if (!metas.length) return;
  s.addAssets(metas);
  s.bumpFonts();
}

/**
 * A project opened on a computer that doesn't have its brand yet: add the copy carried in the file,
 * with the fonts the project already embeds.
 */
export async function installBrandFromProject(brand: Brand, fonts: { file: string; data: Uint8Array }[]) {
  if (!native || brandById(brand.id)) return;
  for (const f of fonts) await native.brandWriteFont({ id: brand.id, file: f.file, data: f.data });
  await saveBrand(normalizeBrand(brand));
  useStore.getState().toast(`Added the ${brand.name} brand from this project`, 'success');
}

/** A brand's colors with the darker, more saturated ones first: what the little dots should show. */
export function dotColors(b: Brand, n = 3) {
  const light = (hex: string) => {
    const v = parseInt(hex.slice(1), 16);
    return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255) > 200;
  };
  return [...b.colors.filter((c) => !light(c.hex)), ...b.colors.filter((c) => light(c.hex))].slice(0, n);
}

/** Compact view for Claude and the panels. */
export function brandSummary(b: Brand | null) {
  return b ? { id: b.id, name: b.name } : null;
}
