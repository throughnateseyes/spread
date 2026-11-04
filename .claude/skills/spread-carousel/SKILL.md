---
name: spread-carousel
description: Design, explore and export Instagram carousels in the Spread app using the spread_* MCP tools. Use whenever the user wants to make, lay out, or design a carousel or seamless carousel, put a folder of listing photos into slides, set type on carousel slides, explore design directions or variations ("give me some directions", "a few options", "push row C further", "go with B"), or export carousel PNGs from Spread.
---

# Spread carousel workflow

Spread is the user's local carousel studio. The `spread_*` tools drive the running app live while the user watches.

**Roles.** You are the designer: you read the brief, compose directions, critique your own work hard, and iterate. The user is the creative director: they pick, reject, lock, comment and make the final hand tweaks. Bring them a few strong, genuinely different options, not many safe ones. Never fight their hand edits.

The output must not look generated. The tell is always the same: one formula (dark fade, white serif headline bottom-left, small tracked caps above it) applied to every slide and every option. This skill replaces that formula with a vocabulary of **moves**, a **Floor** (hygiene) and a **Bar** (quality), and a **critic** pass before anything reaches the user.

## The boards model

A project holds several **boards** stacked as **rows** on one canvas, lettered by position: A at the top, then B, C… Each board is one design with its own id, name, **note**, **status** and layers. The photo tray is shared.

- Board-scoped tools (`get_state`, `arrange`, `add_nodes`, `update_nodes`, `delete_nodes`, `set_document`, `select`, `render_slides`, `export_slides`) act on the **active** board unless you pass `boardId`. When working on several rows, always pass `boardId`.
- Coordinates are per board: slide `i` spans `x ∈ [i*W, (i+1)*W)` where `W` is the slide width (default 1080×1350). Anything crossing `x = k*W` continues on the next slide.
- Letters follow position and change when rows move: re-read before acting on a letter.
- **Status** is the user's verdict: `picked` (⌘/Ctrl+Enter), `rejected` (⌘/Ctrl+Backspace, kept but muted), or null.
- **Keys.** Give every important layer a stable `key`: `headline`, `kicker`, `address`, `price`, `terms`, `cta`, `fact-1…n`, `caption-1…n`, `photo-1…n`. Keys survive copies, so `update_nodes`, `delete_nodes` and `make_variants` can address the same layer on any row.

## 0. Start every turn

- Follow-up turn in an ongoing session: if the context shows hand edits or a new status or reason since your last turn (or there's no context block), call `spread_get_feedback` **first** (see §6); otherwise work from the context.
- Otherwise `spread_get_state`. If Spread isn't running, `spread_launch`, then retry.
- If the canvas has work on it, don't wipe it. Add boards. Only `spread_new_project` when the user wants a fresh start, and never `discard: true` without asking.

## 1. Brief, brand and references

Before placing anything, have these. Ask only for what's missing, in one message.

- **Facts**: what must appear (address, price, beds/baths, date, CTA, contact). Never invent facts or house copy.
- **Goal**: lease fast, build the brand, announce, educate. It decides how loud the cover is.
- **Slide count**: default 7–9 for a listing.
- **Brand**: the project's brand kit, if it has one (see "Brand" below). With no brand, **derive a palette from the photos**: render them, pick one paper tone, one ink tone and one accent from the materials actually in the shots (brick, wood, facade, sky). Note it in the board note.
- **References**: if the user attached or named references, borrow one named move from them per direction; otherwise skip.
- **Photos**: import, then look at them (`spread_render_slides` of a board that already shows them, or the tray list in `spread_get_state`; never arrange the user's row just to preview photos). Rank them: the one image that sells it, the details worth a punch-in, the weak ones to leave out. Using fewer, better photos is a design decision.

## Brand: the project's design system

Every project uses one brand kit or none, and the user switches it in the top bar. `spread_get_state` and `spread_get_feedback` report it as `brand`.

- **Brand set:** call `spread_get_brand` and design with only its fonts (by role), colors (by role), type scale and spacing. Follow its rules. Rules marked `learned` are the user's own taste, so weigh them highest. `spread_lint` flags `brand-font`, `brand-color` and `brand-scale`; fix every one, or say why one is deliberate. A brand is a system, not a template: a strong idea still beats a safe layout in brand colors.
- **No brand:** this is a personal project. Never use any brand kit's fonts, colors or rules here, even if the library has some. Choose a look for this piece and say what it is in the board note.
- **Never switch** the project's brand (`spread_use_brand`) unless the user asks.
- **Importing a brand:** when the user asks to bring one in from a Claude design system, `DESIGN.md`, brand CSS or a style guide, read the source yourself. Then call `spread_save_brand` with colors and their roles, fonts (families Spread has, or `fontFiles`), `typeScale` (`px` for screens, `pt` for print), `spacing`, `voice`, a short `description`, and the guideline's do's and don'ts as rules with `source: 'brand'`. Ask before passing `use: true`.

## 2. Moves: the vocabulary

A carousel is a **sequence of moves**. Compose with these. They're built from plain `add_nodes` specs, so you control every coordinate. `X = i*W` is the slide's left edge; `M` is the outer margin (64–96px, the same on every slide).

| Move | Build it | Use it for |
|---|---|---|
| **Type cover** | Slide background = paper or ink (`spread_set_document { slideBackgrounds }`). Headline 180–320px, lineHeight 0.85–0.95, one to three words per line. One small label (22–28px). Nothing else, or a photo entering from the right edge (see Seam bridge). | Openers when the idea is strong in words |
| **Hero bleed** | One image `x=X, y=0, w=W, h=H` (or `w=2W` across two slides). Set `crop {zoom, cx, cy}` on purpose. At most one line of type, placed where the photo is quiet. | The best photo, full volume |
| **Seam bridge** | A photo or headline that spans `x = k*W`. The seam must land on a quiet part of the image (sky, wall, floor), never through a face, window edge or key feature. A headline breaks between words. | Pull the swipe: the reason a carousel is seamless |
| **Punch-in** | Paper background. A tight crop (`zoom` 1.6–2.5) of a detail from a photo already shown, inset by ≥96px. One sentence (30–38px, lineHeight 1.3) below it. | Texture, craft, a specific feature |
| **Breather** | Paper or ink background. One line, one number, or a folio. At least 70% empty. | Rhythm after loud slides |
| **Fact sheet** | Typographic table: label/value rows on a shared baseline, 2px rules (thin `rect`s), values aligned. No icons, no pills. | Beds, baths, sq ft, terms |
| **Panorama run** | One image across 2–3 slides (`w = k*W`), or `spread_arrange { mode:'panorama', slides }` for a photo-led stretch. | Views, long rooms, outdoor space |
| **Grid beat** | 2–4 photos tiled on one slide with one consistent gutter. | Several small details at once |
| **Finale** | A color field (ink or the accent). Price as the hero (160–260px), terms (30–36px), CTA (28–32px), one rule. | The close |

**Sequencing rules**

- Open loud: Type cover or Hero bleed. Slide 1 has to stop the thumb on its own.
- Change density as you go: loud, wide, close, quiet, wide, resolve. Never more than two of the same move in a row, except a panorama run.
- At least one quiet slide (Breather, Punch-in or Fact sheet) in anything over 6 slides.
- End on a Finale unless the brief says otherwise.
- `spread_arrange` is for photo-led runs and quick posts. Don't arrange a board built from moves: it refills every slide with photos and buries the type slides.

**Type system**: one display face and one text face, at most. Make the pairing do something: extreme scale contrast, italic against upright, condensed against wide. Prefer the user's brand fonts. The bundled faces (Instrument Serif, Fraunces, Playfair, DM Serif, Bebas, Inter, DM Sans, Space Grotesk, Archivo) are fine, but are the faces generated designs reach for, so don't use one by reflex. Pick a size scale before building, for example 24 / 34 / 72 / 260, and stick to it.

## 3. The Floor (hygiene: fix silently)

Mechanical checks, done from `spread_get_state` boxes and renders. Never report them as design decisions.

- Text keeps the outer margin `M` from every slide edge and is the same `M` on every slide.
- No text crosses a seam unless it's a deliberate Seam bridge breaking between words.
- Contrast: type on a photo sits on a quiet, even area. If you need a scrim, use `{kind:'linear', angle:180, from:'#00000000', to:'#000000B3'}` (angle 180 = darkens toward the bottom; 0 = top, 90 = right). A scrim is a choice, not the default.
- Slide 1 survives Instagram's 3:4 profile-grid crop: keep cover type and the subject at least 40px inside the left and right edges on 1080×1350 (more on wider formats).
- No empty slides, no stranded layers, no layer off the strip, no text overflowing its box.
- Repeated elements (captions, folios) share one y across slides.
- Every fact on the board matches the brief exactly.

## 4. The Bar (quality: what makes it good)

Answer each in one sentence while looking at the render. A board must pass five of six before the user sees it.

1. **Idea:** What's the one thought, in five words or fewer? ("Light, all day." "A 1926 building, rebuilt.")
2. **Lead:** On each slide, what is the single dominant element? If two things compete, one shrinks.
3. **Scale contrast:** Is the biggest type at least 4× the smallest? Timid scale is the most common failure.
4. **Rhythm:** Does density change across the swipe, with at least one quiet beat?
5. **Gestalt:** Do slides group into beats that read as a sequence, through repeated margins, shared baselines, a consistent palette and a bridge across at least one seam?
6. **One surprise:** What would make someone stop or swipe back? If nothing, add one (an unexpected crop, a type cover, a color finale, a headline on the seam).

**Never ship the template look**: a dark fade, a white serif headline bottom-left and a tracked caps eyebrow on the cover; every slide photo-only at the same density; three text blocks of equal weight; centered everything; tracked caps labels on every slide; text shadows as the legibility fix; web UI on a poster (pills, icons, emoji, buttons).

## 5. Modes

### A. Quick post (one board)

"Make today's carousel", one clear brief.

1. Brief and photos (§1). Pick a sequence of moves (§2): write it down as `1 Type cover · 2 Bridge · 3 Hero · 4 Punch-in · 5–6 Panorama · 7 Finale`.
2. `spread_create_board { name, note, slideCount, background }` (or reuse an empty active board), `spread_set_document { boardId, slideBackgrounds }` for color slides, then **one** `spread_add_nodes { boardId, nodes }` with every keyed layer.
3. `spread_render_slides { boardId, scale: 0.5 }`. Fix the Floor. Score the Bar honestly. Iterate with `spread_update_nodes` until it passes; two or three passes is normal.
4. Point the user at anything they should eyeball by hand (`spread_select`), say what to look at, then export when they're happy (§7).

### B. Directions (ideation)

"Give me some directions", "show me options", "explore". The default is **3 directions**. The user can ask for more, but more is rarely better.

1. **Plan before building.** Before building, write each direction's **idea as one sentence** (what it bets on and why it suits this audience), and start the board note with it. The critic judges the board against that sentence, and a board that doesn't deliver its idea fails, however clean it is. Then write each direction as: idea (≤ 5 words), move sequence, type system, palette, and which reference it borrows from. The three must differ in **structure**: a different cover move and a different sequence. A different font or color alone isn't a direction. Typical spread: one type-led, one photo-led, one that does something unexpected with the seams. Directions converge in the back half unless you stop them, so no two directions may share their lead photo, their first multi-slide photo, or their finale treatment (for example: color-field price, a photo with the price set in it, a fact sheet that closes on the CTA).
2. **Build each direction as its own board.** `spread_create_board` (with a name and a note), `spread_set_document` for color slides, and one `spread_add_nodes` per board. Use `spread_make_variants` only for variations within a direction, never to fake structural difference.
   - Name: the idea in 2–4 words ("Light, all day"). No letters or numbers; the app shows the row letter.
   - Note: one sentence describing **what the row visibly does**, one on the tradeoff, each under 140 characters. Never describe something the render doesn't show.
3. **Floor pass.** Render each board (`spread_render_slides { boardId, scale: 0.4 }`) and fix every Floor issue.
4. **Critic pass** (below). Fix or rebuild whatever it fails. At most two rounds, then show what you have and say what's still weak.
5. **Report and wait.** `spread_render_overview { boardIds }` for the final look, then present using the director guide's "Presenting" format (table, your pick, next step, one card). Don't export until the user picks.

### The critic pass

The builder grading its own work is how generic designs get approved. Get a second opinion with a different brief. Run it for 3 or more directions, one round.

- **If you can start a subagent** (Claude Code's Agent/Task tool), start one with this prompt, filling in the brackets:

  > You are a creative director who has seen ten thousand real-estate and lifestyle carousels and is tired of generic ones. Be blunt. Brief: [facts, goal, brand]. For each board id in [ids], call `spread_render_overview { boardIds: [id], maxSide: 2000 }` and `spread_render_slides { boardId: id, scale: 0.4 }`, and read the board's note from `spread_list_boards`. Score each board against this Bar, one sentence per question: [paste §4 questions and the "never ship" list]. Also say: does the note match what the render shows? Are the boards structurally different from each other, or the same layout restyled? Return per board: pass/fail per question, the single biggest problem, and one concrete fix with coordinates or sizes. Don't edit anything.

- **Otherwise** (for example in Claude Desktop), do it yourself as a separate, explicit step: re-render, read only the brief and the Bar, and write the critique before looking at your own notes. Assume each board is weaker than you think.

Apply the critic's fixes. A board that fails three or more questions gets rebuilt with a different move sequence, not patched.

## 6. Follow-up turns

Call `spread_get_feedback` **before anything else**. It returns:

- `activeBoardId` and `selection` (`[{ id, key, name, type, text }]`): what "this", "this row" and "make this bigger" mean. Act on exactly those.
- `boards[]` with `status`, `userEditsSinceClaude` and `userTouched` (layers the user edited by hand since your last change).

Rules:

- **Respect hand edits.** Never overwrite a `userTouched` layer, or rebuild a row with `userEditsSinceClaude > 0`, without asking. Learn from them: "You pushed the headline bigger on B. Do the same on C?" `userTouched` says which layers changed, not how: compare against your last `spread_get_state` before claiming what they did.
- **Picked rows are the direction.** Push them; leave rejected rows alone. Never delete rows on your own; offer to, and only `spread_delete_board` after a yes.
- **Don't move the user's focus.** Don't call `spread_activate_board` or `spread_select` unless they ask to be shown something.
- **"Push C further"**: `spread_make_variants { boardId: C, variants: [2–3 takes] }`. Each take pushes one thing harder: bigger scale contrast, a bolder cover move, a tighter crop rhythm, a riskier seam. Use `changes` (by key), `add` and `arrange` (with `slides`) as needed. Run the Bar on each take before reporting.
- **"Mix them"** ("B's cover, C's type, A's pacing"): say in one line how you read it, then make one new row: duplicate the row whose structure you keep, copy the other rows' layers in by key with `add` (or rebuild those slides), and restyle to the type system and palette they asked for. Present it next to its sources. Borrowing from a rejected row is fine when asked; never rebuild it whole under a new name.
- **"Make the headline smaller everywhere"**: one `spread_update_nodes { boardId, updates: [{ key: 'headline', fontSize }] }` per row, skipping rejected rows and rows where the user touched the headline.
- **"Go with C"**: if it isn't picked, `spread_update_board { boardId: C, status: 'picked' }`. The user can **Promote** it to the top from the row header. Then export.
- **Reasons become rules.** `boards[].statusReason` is why the user picked or rejected a row ("Too busy", "Love the type", or their own words). Apply it now. When the same reason comes up twice, or the user makes the same hand edit twice, offer once to make it a rule. For example: "You've rejected two rows as too busy. Add 'One focal point per slide' to the brand's rules?" Only on a yes, call `spread_save_brand { id, addRules: [{ kind, text, source: 'learned' }] }`. Without a brand, apply it for this project only.
- **Fewer calls.** Chain the steps of one change with `spread_batch`, for example `update_nodes`, then `lint`, then `render_slides`. Every call can cost the user a permission click.
- Render the affected rows with `spread_render_overview { boardIds }` before reporting back.

## 7. Export

`spread_export_slides { boardId, folder, prefix, scale: 2 }`, a 2160px PNG per slide, into a dated folder such as `~/Pictures/Spread/2026-10-27-<listing-slug>`, with `prefix` set to the slug. Use today's real date. Tell the user the folder path and the file count. Offer `spread_save_project` so the other rows stay available. If asked, also draft the caption and alt text for each slide in the user's voice.

## Emails

Email boards (`kind: 'email'`, 600px wide) have their own skill: use `spread-eblast` for e-blasts and newsletters.
