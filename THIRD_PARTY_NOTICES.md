# Third-party notices

Spread's own code is under the [MIT licence](LICENSE). Built copies of the app also include the
open-source work below, which keeps its own licence.

## heic-to (LGPL-3.0)

Spread uses [heic-to](https://github.com/hoppergee/heic-to) to read iPhone HEIC photos. It is
licensed under the GNU Lesser General Public License v3.0, and its full text ships in
`node_modules/heic-to/LICENSE`. To swap it, change the version in `package.json` and rebuild.

## Fonts (SIL Open Font License 1.1)

Archivo, Bebas Neue, DM Sans, DM Serif Display, Fraunces, Inter, Instrument Serif, Playfair Display
and Space Grotesk ship through [Fontsource](https://fontsource.org). Each font keeps its own
licence, included in its package under `node_modules/@fontsource*/`.

## Other libraries

Electron, React, Konva, Zustand, Immer, Phosphor Icons and the other runtime libraries use
permissive licences (MIT, ISC, BSD or Apache-2.0). pdf.js is Apache-2.0. To list everything:

```bash
npx license-checker --summary
```
