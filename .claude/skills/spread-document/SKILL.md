---
name: spread-document
description: Design page-based work of any medium in the Spread app with the spread_* MCP tools — resumes and CVs, one-pagers, flyers, posters, leave-behinds, letterheads, business cards, presentation slides, LinkedIn/X banners, YouTube thumbnails, single social posts — and export them as PDF with real text or as PNG. Use whenever the user wants to make, redo, lay out or refine a resume/CV or any single- or multi-page design "in Spread", wants precise control over spacing and alignment, or asks for a PDF from Spread. For Instagram carousels use spread-carousel; for e-blasts use spread-eblast.
---

# Spread pages workflow

Spread is the user's local design canvas. A **document board** (`kind: 'document'`) holds pages of any size for any medium. You do the design work and iterate; the user directs, refines by hand and makes the final call. The goal is work that looks deliberately designed: exact spacing, clear hierarchy, nothing generic.

## How document boards work

- Pages sit side by side like slides: page `i` spans `x ∈ [i*W, (i+1)*W)`, `y ∈ [0, H)`. Unlike carousel slides, **pages never continue into each other**. Nothing may cross a page edge.
- **Units.** Print sizes are in **points** (72 per inch): Letter is 612×792, `fontSize: 10` is 10pt, 36pt is half an inch. Screen sizes (presentation, banners, thumbnails) are in **px**. `spread_get_state` reports `page.units`.
- `page.margins` (t, r, b, l) and `page.baseline` (grid step, 0 = off) live on the board. The layout grid is on by default and shows the live area inside the margins. For column structure, set it with `spread_set_document { grid: { columns: { count: 12, gutter: 12 } } }`. Everything snaps to the grid.
- Board-scoped tools act on the active board unless you pass `boardId`. Key every important layer (`name`, `contact`, `summary`, `section-experience`, `role-1`, `dates-1`, …) so edits and variations can find it again.
- Exports: `spread_export_pdf` gives vector PDF with real, selectable text and embedded fonts, with line breaks identical to the canvas. Photos are embedded at 300 dpi. `spread_export_slides` gives PNG per page (pass `scale: 300/72` for 300 dpi on print sizes).

## 0. Start every turn

Follow-up turn: `spread_get_feedback` first. Read the selection, the hand edits (`userTouched`) and the picks before changing anything. Otherwise `spread_get_state`. If Spread isn't running, `spread_launch`. Never wipe existing work. Add a board, or ask.

## 1. Brief first

Before touching the canvas, settle these. Ask only for what's missing, in one message.

1. **What and where.** The medium, the size, and where it's seen: printed, attached to an application, shown on a screen, posted.
2. **Audience and goal.** Who reads it and what they should do or remember. For a resume: the target role and industry.
3. **Content source.** Where the words come from. Keep the canonical copy in a text file in the user's project folder (for a resume, `resume.md`) and lay it out from there. Never invent facts, numbers, titles or dates. If something is missing, ask or leave a visible `{{TODO}}`.
4. **Constraints.** Page count, must-keep elements, and the output: PDF, PNG or both. Fonts and colors come from the project's brand kit when it has one (see "Brand" below).
5. **References.** 2–5 examples the user loves. If the Spread repo has a `taste/` folder, read the references that fit, and everything in `taste/anti/`.

Write the brief in one or two sentences as the board's `note`.

## Brand: the project's design system

Every project uses one brand kit or none, and the user switches it in the top bar. `spread_get_state` and `spread_get_feedback` report it as `brand`.

- **Brand set:** call `spread_get_brand` and design with only its fonts (by role), colors (by role), type scale and spacing. Follow its rules. Rules marked `learned` are the user's own taste, so weigh them highest. `spread_lint` flags `brand-font`, `brand-color` and `brand-scale`; fix every one, or say why one is deliberate. A brand is a system, not a template: a strong idea still beats a safe layout in brand colors.
- **No brand:** this is a personal project. Never use any brand kit's fonts, colors or rules here, even if the library has some. Choose a look for this piece and say what it is in the board note.
- **Never switch** the project's brand (`spread_use_brand`) unless the user asks.
- **Importing a brand:** when the user asks to bring one in from a Claude design system, `DESIGN.md`, brand CSS or a style guide, read the source yourself. Then call `spread_save_brand` with colors and their roles, fonts (families Spread has, or `fontFiles`), `typeScale` (`px` for screens, `pt` for print), `spacing`, `voice`, a short `description`, and the guideline's do's and don'ts as rules with `source: 'brand'`. Ask before passing `use: true`.

## 2. Set up the page before any design

- `spread_create_board { kind: 'document', preset, pageCount, margins, baseline, name, note }`. Presets: `letter`, `legal`, `tabloid`, `a5`, `a4`, `a3`, `poster-18x24`, `poster-24x36`, `business-card`, `presentation`, `instagram-post`, `story`, `linkedin-post`, `linkedin-banner`, `x-header`, `youtube-thumbnail`. Add `landscape: true` to rotate. Custom sizes: `slideWidth`/`slideHeight` plus `units`.
- **Type scale.** Pick 4–5 sizes before building and use only those. Example for a resume: 9.5 / 11 / 13 / 24. Example for a poster: 14 / 24 / 48 / 144.
- **Spacing scale.** Pick a base unit (4pt on paper, 8px on screen) and use only its multiples for gaps and padding. Set `baseline` to that unit and make line heights land on it (11pt × 1.4545 = 16pt; 9.5pt × 1.4737 = 14pt), so `spread_lint` can hold you to it.
- **Grid.** Decide the structure: one column, a left rail plus main column, or two columns. Turn on a 12-column grid for anything with more than one column: a rail of 3 columns and a main of 9, or a main of 8 and a side of 4.

## 3. Build with auto layout

Exact spacing comes from auto layout, not from hand-placed coordinates.

- Make a `frame` per column with `layout: 'column'`, a `gap` from the spacing scale, `sizingV: 'hug'`, and `fill: null`. Put sections inside as column frames, and entries inside those.
- An entry heading with the dates flush right is a `layout: 'row'` frame with `justify: 'between'`: role and organisation on the left, dates on the right.
- **Proximity:** the gap inside a group is smaller than the gap between groups. Roughly 1:2 or 1:3, for example 4 inside an entry, 12 between entries, 24 between sections.
- Text that wraps needs `sizingH: 'fixed'` and a `w`, or `sizingH: 'fill'` inside an auto-layout column. Keep body lines at 45–90 characters.
- Always set `fontFamily`, `fontWeight` (text defaults to 600, too heavy for body copy), `fontSize`, `lineHeight` and `fill` on every text layer.
- Give every frame and text layer a `key`. Build a whole section in one `spread_add_nodes` call with nested `children`.

## 4. The Floor: run `spread_lint`, fix every error

After every build pass, run `spread_lint { boardId }`. Fix every **error** (off-page, crosses-page, overflow). Fix **warnings** unless there is a stated reason to keep one: margin, alignment near-misses, spacing that's a hair off, widows, line length, baseline, contrast, overlap, tiny text, type system. Re-run until it's clean or every remaining warning is deliberate. Mention any deliberate ones in your report.

Then **look**: `spread_render_slides { boardId, scale }` at 1 for Letter (612px wide) or 0.5 for big formats. Check what lint can't: optical alignment of big type, rag (the ragged right edge of left-aligned text), awkward breaks, and visual weight.

## 5. The Bar: what makes it good

Answer each in a sentence while looking at the render. Pass 5 of 6 before showing the user anything.

1. **Scan path:** in 6 seconds, does the eye go to the right three things in order? For a resume: name, then current or target role, then the section heads.
2. **Hierarchy:** one dominant element, with clear steps down in size, weight or color. No two things compete.
3. **Alignment:** one or two strong vertical axes that everything hangs from. No near misses.
4. **Proximity and rhythm:** spacing makes the groups obvious, and identical things are styled identically.
5. **Restraint:** at most two families, one accent color, no decoration without a job.
6. **One distinctive move:** something a template wouldn't do, that serves the content. For example: hanging dates in the left margin, an oversized name set small and tracked, a hairline rule system, a strong left rail, a bold use of white space.

**Never ship:**
- skill bars or percentages
- icons on every contact line
- a two-tone sidebar template look
- centered everything
- three or more accent colors
- justified text with rivers
- body text under 8pt
- a photo on a US resume, unless asked
- text baked into images
- clip-art dividers
- headings that cost more space than they save

## 6. Directions, the critic, and iteration

- **New designs:** offer up to **3 directions** that differ in **structure**, not just font. Before building, write each direction's **idea as one sentence** (what it bets on and why it suits this audience), and start the board note with it. The critic judges the board against that sentence, and a board that doesn't deliver its idea fails, however clean it is. For a resume: (a) single column, editorial and type-led; (b) left rail for contact and skills with a main column for experience; (c) a centered or asymmetric header with hanging dates. Build each as its own board from the same content. All three must pass lint first.
- **Critic pass:** before showing anything, run a critic subagent if you can (Claude Code's Agent/Task tool). Use the prompt from the `spread-carousel` skill, but swap in this skill's Bar and never-ship list, and add: "Check the PDF text order with spread_pdf_text." Without subagents, do the critique yourself as a separate step and assume each design is weaker than it looks. Fix or rebuild what fails; at most two rounds.
- **Report:** a short table per direction (structure, type pairing, the distinctive move, the critic's main note), then your pick and why. "Pick one with Ctrl+Enter, or tell me what to change."
- **Follow-ups:** act exactly on the selection ("make this tighter", "this up a bit"). Change spacing through the frame's `gap`/`padding`, not by nudging children. Never overwrite a `userTouched` layer without asking. Learn from hand edits: "You tightened the gap between entries to 10. Apply that everywhere?"
- **Reasons become rules.** `boards[].statusReason` is why the user picked or rejected a row ("Too busy", "Love the type", or their own words). Apply it now. When the same reason comes up twice, or the user makes the same hand edit twice, offer once to make it a rule. For example: "You've rejected two rows as too busy. Add 'One focal point per slide' to the brand's rules?" Only on a yes, call `spread_save_brand { id, addRules: [{ kind, text, source: 'learned' }] }`. Without a brand, apply it for this project only.
- **Fewer calls.** Chain the steps of one change with `spread_batch`, for example `update_nodes`, then `lint`, then `render_slides`. Every call can cost the user a permission click.
- **Words vs layout:** content edits go to the source file first (`resume.md`), then to the canvas by `key`. That way the words and the layout never drift apart.

## 7. Export and verify

1. `spread_lint`: clean.
2. `spread_export_pdf { boardId, path }`. Use a dated path the user will find, for example `~/Documents/Resume/2026-10-29-resume.pdf`.
3. `spread_pdf_text { path }`: every word from the source is present, nothing is garbled, and the reading order makes sense: name, contact, then sections top to bottom. Two-column layouts can interleave, so check that a rail doesn't land between experience entries. If the order is wrong, restructure (put the rail after the main column in the layer tree, or go single-column) and export again.
4. Tell the user the path and page count, and anything deliberate in the lint report.

## Resume playbook

**Content (do first, in `resume.md`)**
- Section names applicant-tracking systems recognise: *Experience*, *Education*, *Skills*, *Projects*, *Selected work*. Contact details go in the body, not a header or footer.
- One page under ~10 years of experience; two pages maximum.
- Bullets: verb + what you did + result, with a number when it's real. 1–2 lines each, 3–5 per recent role, fewer for older ones. Cut anything the target role won't care about.
- A 1–2 line summary only if it says something specific about the person. Skip generic objectives.
- Links as readable text (`yourname.com`, an email address), not "Click here".

**Typography (Letter or A4)**
- Margins 36–54pt (0.5–0.75 in). Baseline 2 or 4pt.
- Body 9.5–11pt, leading 1.3–1.45. Section heads 10–12pt, set apart by weight, small caps or tracking (+4–8%) rather than size. Name 18–32pt. Dates and locations one step down, in a muted ink, never smaller than 8pt.
- One family in two or three weights, or a display face for the name only plus one text face. Prefer the user's brand or portfolio fonts so the resume matches their site.
- Dates align on one right edge, or hang in a left column. Never let them float.
- Ink: near-black (#1A1A1A–#222) on white. One accent at most, used for the name or the rules, not both.

**Layout patterns that work**
- *Editorial single column:* name large at the top left; contact on one line under it; sections stacked with a hairline rule; dates flush right in each entry's heading row. Safest for applicant-tracking systems.
- *Left rail:* a 3-column rail (contact, skills, education, links) and a 9-column main (summary, experience). The rail starts at the same baseline as the main. Check `spread_pdf_text` order.
- *Hanging dates:* a narrow date column in the left margin area (2 columns), with the content aligned on one strong axis. Very clear scanning.

## Other mediums: quick rules

- **Flyer or poster:** one message at 3m/10ft; headline 8–15% of the page height; the facts (date, place, URL or QR code) grouped in one block; 0.25in safe margin (print may trim).
- **One-pager or leave-behind:** an executive summary up top, 3–5 scannable blocks, one call to action, contact at the bottom.
- **Presentation slide (1920×1080 px):** one idea per slide, at least 32px body and 72px+ titles, 96px margins, and the same title position on every slide. Export a PDF for the deck.
- **LinkedIn banner (1584×396):** the profile photo covers the bottom left (about 0–400px × 200–396px on desktop). Keep text right of x≈450 and vertically centered.
- **YouTube thumbnail (1280×720):** 3–5 words max, readable at 160px wide, high contrast, and the subject's face large if there is one.
- **Business card:** 9pt minimum, generous margins (at least 12pt), front with the name and back with details if two-sided (use 2 pages).
