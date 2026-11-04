/** The Spread mark ("Seam"): two slides side by side, one disc crossing the gutter.
 *  Same geometry as docs/brand/spread-mark.svg; on a 64-unit grid the gutter sits at x 30–34, so at
 *  16px its edges land on half pixels and stay crisp on Retina. Colours follow the theme tokens. */
export function BrandMark({ size = 16, className = 'brand-mark' }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path fill="var(--accent)" d="M12 6H28a2 2 0 0 1 2 2V56a2 2 0 0 1-2 2H12a8 8 0 0 1-8-8V14a8 8 0 0 1 8-8Z" />
      <path fill="var(--purple)" d="M36 6H52a8 8 0 0 1 8 8V50a8 8 0 0 1-8 8H36a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
      <path fill="#fff" d="M30 17.134A15 15 0 1 0 30 46.866Z" />
      <path fill="#fff" d="M34 17.134A15 15 0 1 1 34 46.866Z" />
    </svg>
  );
}
