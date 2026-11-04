---
name: spread-eblast
description: Build e-blasts and newsletters as email boards in the Spread app using the spread_* MCP tools, then export inbox-safe HTML plus images. Use whenever the user wants an email, e-blast, newsletter, resident notice, event invite or listing blast made "in Spread", wants to lay out or edit an email visually on the Spread canvas, or asks to export an email board's HTML.
---

# E-blasts in Spread

Spread has **email boards**: rows on the same canvas as the carousels, 600px wide, height growing with the content. You build the email from templates, fill in the facts, look at it, and Spread compiles it to table-based, inline-styled HTML plus image files. The user sees every change live and can fix things by hand.

**House rules come from the project.** Follow the project's brand kit if it has one, and if the user has their own email skill or style guide, read it before writing copy or delivering. The built-in templates use a neutral style (Georgia + Arial, one accent colour, 8/12/20/32/48 spacing, 32px side padding, square corners, one underlined text-link CTA). Don't restyle them unless asked. The rules broken most often:

- Sentence case on headings and the CTA. No superlatives.
- For housing, never describe who a place suits (fair housing).
- Never invent square footage, rent, availability, amenities or walk times. Pull facts from listing pages the user gives you, or ask.
- One CTA per email. Live text for anything that matters (dates, addresses, CTAs), never baked into an image.
- Footer keeps the mailing address and the unsubscribe link.

## How an email board is built

- One root auto-layout column frame, 600px wide. Its children are **sections**: frames named `Section / …` (masthead, hero, listing, story, CTA, footer…).
- Edit with the normal tools: `spread_get_state { boardId }` for ids, `spread_update_nodes` to change text and props, `spread_add_nodes { parentId }` to add inside a section (or the root), `spread_delete_nodes` to remove a section.
- Template copy marks every fact as a `{{TOKEN}}` (`{{ADDRESS}}`, `{{BEDS}}`, `{{LISTING_URL}}`, `{{HERO_ALT}}`…). Tokens appear in **text** and in **layer names**.
- The compiler reads tags in **layer names**:
  - `[link:URL]` makes the layer a link (the CTA is `See the listing > [link:{{LISTING_URL}}]`).
  - `[alt:…]` sets an image's alt text. Describe the content ("Sunny living room with bay windows"), not the file.
  - `[button]` marks a bulletproof button. The templates use text links instead.
  - `[stack]` / `[nostack]` decides whether a row frame stacks on phones.
  - `[raster]` flattens a frame into one picture. Avoid it for anything with words.
- To change a link or alt text, rename the layer and keep the tag: `spread_update_nodes { updates: [{ id, name: 'CTA [link:https://example.com/…]' }] }`.

## Brand: the project's design system

Every project uses one brand kit or none, and the user switches it in the top bar. `spread_get_state` and `spread_get_feedback` report it as `brand`.

- **Brand set:** call `spread_get_brand` and design with only its fonts (by role), colors (by role), type scale and spacing. Follow its rules. Rules marked `learned` are the user's own taste, so weigh them highest. `spread_lint` flags `brand-font`, `brand-color` and `brand-scale`; fix every one, or say why one is deliberate. A brand is a system, not a template: a strong idea still beats a safe layout in brand colors.
- **No brand:** this is a personal project. Never use any brand kit's fonts, colors or rules here, even if the library has some. Choose a look for this piece and say what it is in the board note.
- **Never switch** the project's brand (`spread_use_brand`) unless the user asks.
- **Importing a brand:** when the user asks to bring one in from a Claude design system, `DESIGN.md`, brand CSS or a style guide, read the source yourself. Then call `spread_save_brand` with colors and their roles, fonts (families Spread has, or `fontFiles`), `typeScale` (`px` for screens, `pt` for print), `spacing`, `voice`, a short `description`, and the guideline's do's and don'ts as rules with `source: 'brand'`. Ask before passing `use: true`.

## Flow

1. **Intake.** Work out the email type (listing blast, newsletter, resident notice, event) and gather the facts, links and photos. Read listing pages the user links. Ask only for what's genuinely missing, in one short list.
2. **Photos.** `spread_import_photos { paths }` if they aren't in the tray yet. Note the asset ids in the order you want them used.
3. **Create from the right template.** `spread_list_email_templates`, then `spread_create_email { template, name, note, photoIds }`. The user's own templates come first (ids start with `saved:`); prefer them, because they are the house look. Built-in: `listing-spotlight` (one unit), `newsletter`, `resident-notice`, `event`, or `blank`. The board lands below the active row and becomes active.
4. **Shape it.** Add sections with `spread_add_email_section { sectionId, index, photoIds }`, again preferring the user's `saved:` sections. Without an index a section lands just above the footer. Delete sections the email doesn't need. One job per email.
5. **Fill every token.** `spread_get_state { boardId }`, find each `{{…}}` in `text` and in `name`, and replace it with `spread_update_nodes` (one call, many updates). Write the copy in the brand's voice.
   **Subject and preview text live on the board.** Propose three subject + preview pairs in your reply, set your pick with `spread_update_board { subject, preheader }` (subject under ~60 characters; preview 40–90, not repeating the subject). The user sees and edits them under Inbox in the right panel, and the export uses them.
6. **Look.** `spread_render_slides { boardId, scale: 0.6 }` renders the email as one tall image. Check hierarchy, spacing rhythm, crops, and that nothing reads as a template.
7. **Check the compile.** `spread_email_html { boardId }`. Fix every warning you can: unfilled tokens, missing alt text, links to `#`, missing unsubscribe, unsupported effects (shadows, gradients, rotation). Keep `bytes` under about 100 KB (Gmail clips at 102 KB). Then check that dates match their weekdays and every link works.
8. **Export with hosting.** `spread_export_email { boardId, host: 'wordpress' }` renders the images, uploads them to the user's WordPress media library (pictures that haven't changed are reused, so iterating is cheap) and writes `email.html` with the hosted URLs into a dated folder under `~/Pictures/Spread`. Subject and preview text come from the board.
9. **If WordPress isn't connected,** the export says so. Ask the user to connect it once (Export → Upload to WordPress: site, username, an Application Password from Users → Profile). Without it, export without `host`, have them upload the image files to a public host (not Drive or Box), ask for the base URL, and export again with `baseUrl` (or `urls: { nodeId: url }`).
10. Check `warnings` once more. The user can also do all of this themselves in Export → Upload & copy HTML.

## Delivering

In this order, and nothing more:

1. One line on what was built, with the folder path and `email.html`.
2. Anything unverified, flagged plainly: dates, prices, walk times, links.
3. Placeholders still needing real values (the export's warnings list them).

The user pastes `email.html` into their email tool. Offer `spread_save_project` so the email board stays editable.

## The system: templates and references

- **Templates.** When an email (or one section of it: a masthead, an event list, a footer) is right, the user saves it from the row's ⋯ menu or by right-clicking the section. With their OK you can do it too: `spread_save_template { boardId | sectionId, name, description }`. Saved templates appear in New board, the Section menu and `spread_list_email_templates`, with their photos and fonts.
- **References.** Before a new email, `spread_list_library { boardKind: 'email' }` and open the references' images with Read. Their `why` is the quality bar: match it. When the user loves a result, offer once to save it as a reference, with a specific why (`spread_save_reference`).

## Iterating

- Follow-up turns: call `spread_get_feedback` first. The user may have edited the email by hand (`userTouched`); don't overwrite those layers without asking. `selection` says what "this" means.
- For alternative versions (subject angle, hero choice, section order), `spread_make_variants { boardId, variants }` copies the email board below itself. Address layers by `key`, or by the source board's ids.
- Re-run `spread_email_html` after every round of changes before exporting again.
- **Reasons become rules.** `boards[].statusReason` is why the user picked or rejected a row ("Too busy", "Love the type", or their own words). Apply it now. When the same reason comes up twice, or the user makes the same hand edit twice, offer once to make it a rule. For example: "You've rejected two rows as too busy. Add 'One focal point per slide' to the brand's rules?" Only on a yes, call `spread_save_brand { id, addRules: [{ kind, text, source: 'learned' }] }`. Without a brand, apply it for this project only.
- **Fewer calls.** Chain the steps of one change with `spread_batch`, for example `update_nodes`, then `lint`, then `render_slides`. Every call can cost the user a permission click.
