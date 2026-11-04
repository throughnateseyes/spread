# Spread brand

The mark is **Seam** (concept A in [concepts.html](concepts.html)): two slides side by side, with one white disc crossing the gutter between them. The gutter cuts the disc in two but its outline keeps going, which is what Spread does: a photo or a headline runs across the seam between slides and still reads as one picture.

Why this one over the other two: it is the only concept that keeps a clear, recognisable silhouette at 16 and 32 px. "Open spread" (B) reads as a book or a box before it reads as a spread, and "Triptych" (C) looks like a bar chart below 64 px. Seam also grows out of the blue/purple split square the app used before, so the brand changes and the product still looks familiar.

## Files

| File | Use |
|---|---|
| `spread-mark.svg` | The symbol on its 64-unit grid. Use it anywhere the mark appears on its own. |
| `spread-wordmark.svg` | The mark with "Spread" set in Inter SemiBold. The text is outlined, so the file needs no font. Text colour is `#1d1d1f`. On dark backgrounds change it to `#e8e8ea`. |
| `../../assets/icon/icon.svg` | The macOS app icon source (1024 px canvas, 824 px rounded square, drop shadow in the margin). |
| `../../assets/icon/icon-square.svg` | Full-bleed rounded tile for Windows `.ico`, Linux and the Claude extension icon. |
| `../../src/ui/BrandMark.tsx` | The in-app 16 px mark. It draws its colours from the `--accent` and `--purple` theme tokens. |

To regenerate `assets/icon/icon.png`, `icon.icns`, `icon.ico`, `connector/icon.png` and the `build/` copies after editing an icon SVG, run `npm run icon`. This needs macOS and `rsvg-convert` (`brew install librsvg`).

## Colour

| Token | Hex | Role |
|---|---|---|
| Spread Blue | `#0d99ff` | Left slide (same as the app's `--accent`) |
| Spread Purple | `#9747ff` | Right slide (same as the app's `--purple`) |
| White | `#ffffff` | The disc. It stays white on every background. |
| Ink | `#1d1d1f` | Wordmark text on light backgrounds |
| Paper | `#e8e8ea` | Wordmark text on dark backgrounds |
| Icon body | `#2b2b30` to `#131315` | Vertical gradient behind the mark in the app icon |

Keep blue on the left and purple on the right. Do not recolour the mark to a single colour unless the medium forces it (an emboss, a one-colour print). In that case, use the solid ink colour for both slides and cut the disc out of them.

## Geometry

The mark is built on a 64-unit grid:

- The slides run from x 4 to 30 and x 34 to 60, and from y 6 to 58. The outer corners have a radius of 8 and the corners at the gutter have a radius of 2, so the two slides read as one tile that has been split.
- The gutter is 4 units wide. At 16 px it is exactly 1 px wide, with its edges on half pixels, so it stays crisp on Retina screens.
- The disc has a radius of 15 and is centred on the gutter at (32, 32).

## Clear space and minimum size

- **Clear space:** leave at least a quarter of the mark's height (13 grid units) empty on every side. In the wordmark, the gap between the mark and the "S" is 0.42 × the cap height. Keep that gap when you rebuild the lockup.
- **Minimum size:** 16 px for the mark, which is the size in the app's top bar. Set the wordmark no smaller than a 10 px cap height. Below that, use the mark on its own.
- In the wordmark the mark is 1.2 × the cap height and is centred on the cap height, not on the x-height.

## Don'ts

- Don't close the gutter or let the disc bridge it. The cut is the idea.
- Don't add sparkles, gradients on the disc, outlines or shadows to the mark. The app icon's shadow belongs to the icon, not to the mark.
- Don't put the mark in a circle. The icon shape is the macOS rounded square, and the Windows and extension tile is a plain rounded square.
