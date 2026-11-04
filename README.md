# Spread

A free, local design canvas that Claude can drive. Make carousels, emails and any page-based work on your own computer: no account, no paywall, no cloud. It's open source, so you can change it to fit how you work.

I built Spread for my own marketing work, to replace a phone carousel app plus Figma for type. Claude does the layout and iteration, and you direct it and make the final tweaks by hand, on Mac or Windows.

- **Seamless carousels**: one long canvas cut into slides. Photos, shapes and text can cross the seams, and each slide exports as its own PNG, so the post swipes as one continuous image.
- **Figma-style layout**: frames, auto layout (row or column, gap, padding, hug/fill/fixed sizing), layout grids, smart snapping, layers, alignment, real typography controls and your own font files.
- **Pages for any medium**: resumes, flyers, posters, one-pagers, decks, banners, thumbnails. Print sizes (Letter, A4, posters…) are in points with margins and a baseline grid, and export to PDF with real, selectable text and embedded fonts that match the canvas line for line. Screen sizes are in px and export to PNG.
- **Layout checks**: the app checks margins, page edges, cut-off text, near-miss alignment, spacing off the grid, line length, stranded words, contrast and type sprawl, so Claude fixes the mechanics and spends its attention on the design.
- **Variation rows**: a project holds several boards stacked as rows (A, B, C…), so you (or Claude) can lay several directions side by side, pick one and promote it.
- **E-blasts**: email boards built from auto-layout sections with built-in or saved templates, compiled to inbox-safe HTML plus images.
- **Local files only**: no cloud, no storage limits. Projects save as `.spread` files. Exports go to a folder you pick, ready to post.
- **Comments for Claude**: press **C**, click a layer or a spot, and pin a note. Claude picks it up in the chat beside the canvas (desktop app only).
- **Claude drives it**: from the Claude desktop app or Claude Code, Claude imports photos, lays out pages and slides, sets type, looks at what it made and exports. You make the final tweaks by hand. One click in Spread connects it.

## Quick start

You need [Node.js](https://nodejs.org) 22 or newer. Claude features also need [Claude Code](https://claude.com/claude-code) or the Claude desktop app and your own Claude account; the canvas works without them.

```bash
git clone https://github.com/throughnateseyes/spread.git
cd spread
npm install
npm run app        # build + open the desktop app
```

While developing, `npm run dev` gives hot reload. `npm run web` runs it in a browser tab only, without native file dialogs or the Claude bridge.

To build an installer, run `npm run dist:win` (NSIS installer plus a portable `.exe` in `release/`). Run `npm run dist:mac` on a Mac to get a `.dmg`; macOS builds have to be made on macOS.

## How it works

1. **Drop a folder** of photos onto the canvas, or use **Photos → Folder**.
2. The **Arrange** dialog opens. Pick a layout:
   - **Panorama**: one continuous row; seams cut through photos (the classic SCRL look).
   - **Collage**: wide and narrow tiles so seams land inside photos.
   - **Brick**: two offset rows.
   - **One per slide**: full-bleed photos.

   Set gap, margin and radius, and optionally add a headline placeholder.
3. **Tweak**:
   - Double-click a photo to crop it: the whole photo shows past the frame; drag to reposition, drag a corner or use the slider to zoom.
   - Drag photos from the tray onto a slide, or onto an existing photo to replace it. Shift-drag one photo onto another to swap them.
   - Hold **Alt** to measure distances to the slide edges; pink guides show equal spacing.
   - Press **T** for text. Double-click text to edit it.
   - Select some layers and press **Shift+A** to wrap them in auto layout (price pills, stat rows).
   - Turn on the layout grid (**Ctrl+'**) and things snap to columns, slide edges, seams and other layers.
4. **Preview**: swipe through it in an Instagram phone mock, including the 3:4 profile-grid crop.
5. **Export**: 1x, 2x or 3x PNG or JPG, one file per slide, plus an optional full-strip panorama.

**Effects:** select a photo and press **+** next to Effects to pick a look (dither, grain, blur and more) from the library. Hover any look or setting to see a before and after on your own photo. Effects never change the photo itself, and you can hide or remove them at any time. For frosted glass, select a shape or frame, lower its fill's opacity and raise **Blur behind**.

**Gradients:** set any shape or frame's fill to **Gradient**, then choose Linear, Radial or Mesh. For a mesh, drag the dots, double-click to add a color, start from a preset, or press **Shuffle**. **Grain** keeps a gradient from looking digital.

**Variations:** press **Variation** in the bottom dock (or **Ctrl+Alt+D**) to copy the board as a new row, then change the copy. **Alt+↑/↓** moves between rows, **Shift+1** fits all of them.

**E-blasts:** **New → Email** and pick one of your templates or a built-in one (Listing spotlight, Newsletter, Resident notice, Event) or Blank. Add sections from **Section** in the dock. Set the subject and preview text under **Inbox** in the right panel. **Export → Upload to WordPress** uploads the images to your media library and copies HTML that points at them; without WordPress, upload the images yourself and enter their base URL.

**Library:** a row's ⋯ menu has **Save as template** and **Save as reference**; right-click an email section to save just that block. Templates show up in New board and the Section menu of every project. References are designs you rate highly, with a line on why, and Claude looks at them before designing something similar. **Spread menu → Library…** manages both.

**Home and tabs:** the house icon opens Home, which shows every project with a thumbnail. Filter by Social, Email or Pages, search by name, and drag a card onto a folder to organize. Keep separate work in separate projects (one for each building's e-blasts, one for the newsletter) and open as many as you like: each gets a tab above the toolbar. **Ctrl+K** jumps to any project by name. A row's ⋯ menu has **Copy to another project…**, and copying and pasting layers works between tabs, photos included. Open tabs come back when you restart.

Every project is a normal `.spread` file, in `Pictures/Spread` unless you save it elsewhere. Spread saves it for you two seconds after a change and keeps the last three safety copies in `~/.spread/backups`. Folders only live on Home, so organizing never moves your files. In the browser version your work autosaves locally (IndexedDB) instead.

## Connecting Claude

### The Claude panel (inside Spread)

Click **Claude** in the top bar (or press **Ctrl+J**) to open a chat beside the canvas. It runs your own Claude Code, signed in with your Claude account. The first time, the panel asks you to **Sign in**: a Terminal window runs `claude auth login` and opens your browser.

- **No permission clicks for design.** Spread's tools and reading files are pre-approved, so Claude can design, look and fix without stopping. Anything else (editing a file, running a command, the web) shows up in the chat as an **Allow / Allow for this chat / Deny** card.
- **It knows what you're looking at.** Every message carries the active row, the selection, your picks and reasons, and the project's brand, so *"tighten this"* or *"push row C"* just works. The chips above the input show what will be sent.
- **Design docs.** Link a brand kit to its `DESIGN.md` (under **Brands**), or put a `DESIGN.md` next to the `.spread` file. Claude reads it before designing. Your `CLAUDE.md` applies too, because Claude Code runs in the project's folder.
- **References.** Drop files or folders onto the panel (or use the paperclip) to hand them to Claude.
- **One conversation per project.** It picks up where you left off when you reopen the file. **New chat** starts over.
- **A senior designer, not a generator.** New work starts with a short brief as tappable question cards (goal, channel, how many directions, which territory), then named direction concepts for you to approve before anything is built. Starter flows on the empty panel (listing carousel, open house flyer, e-blast, campaign, resume) kick this off. The playbook is `.claude/skills/spread-director/`, served to every Claude as `spread_guide('director')`.

### The Claude desktop app and Claude Code

Open **Spread menu → Connect Claude…** for one button per Claude:

- **Claude desktop app → Install.** Spread hands Claude its extension (`Spread.mcpb`); click **Install** in the window Claude opens. After that, any chat can use Spread: *"Make me a one-page resume in Spread from my resume.pdf."* No terminal, no project folder.
- **Claude Code → Set up.** Registers Spread for every folder (`claude mcp add --scope user`), so Claude Code can use it from wherever you work, not only inside this repo.

The dialog shows when Claude last used Spread. Claude can open Spread itself (`spread_launch`) once you've opened it once.

How it works: Spread runs a small automation bridge on `127.0.0.1`. It is token-protected and refuses browser origins. `mcp/server.mjs` exposes it as `spread_*` tools. `npm run connector` packs that server, its dependencies and the design guides into `release/Spread.mcpb` (the app rebuilds it when you click Install in development, and installers ship it). Inside this repo `.mcp.json` also registers it for Claude Code at project scope.

The design workflow travels with the connector: `spread_guide` (and the **Spread: Pages / Carousel / Email** prompts in Claude's prompt menu) serve the same guides as the skills in `.claude/skills/`, so Claude follows the same rules in a desktop chat as in Claude Code.

- The skill in `.claude/skills/spread-carousel/` teaches Claude two modes: a **quick post** (one carousel: import, arrange, type, render-and-check, export) and **directions** (three structurally different directions, each composed from named slide moves such as type cover, seam bridge, punch-in and finale, checked against a quality bar and a separate critic pass before you see them). `spread_make_variants` then pushes the one you pick.
- The skill in `.claude/skills/spread-document/` designs pages for any medium (resumes, flyers, posters, one-pagers, decks, banners): brief first, a type and spacing scale up front, auto-layout structure, `spread_lint` until clean, a critic pass, then a PDF checked with `spread_pdf_text`. It includes a resume playbook.
- The skill in `.claude/skills/spread-eblast/` builds e-blasts as email rows from your saved templates (or the built-in ones), sets the subject and preview text, checks the compiled HTML and exports `email.html` with the images uploaded to your WordPress media library.

A project holds several **boards** stacked as rows on one canvas. Emails next to each other sit side by side, top-aligned, so variations of any height are easy to compare. Each board is a carousel or an email with its own name and a note explaining the idea. Rows are lettered A, B, C… from the top. Claude builds the directions, has a critic review them, fixes what fails, and recommends one. You answer with the keyboard: **Ctrl+Enter** picks the active row, **Ctrl+Backspace** rejects it (kept, just muted), and **Promote** on a picked row moves it to the top. Claude reads your picks, rejects and hand edits before its next change, and never overwrites your hand edits without asking. Select something in Spread and say "make this bigger" in Claude Code; Claude reads your selection and active row first.

Try:

- *"Take today's photos in `~/Pictures/2026-10-26` and make a 6-slide seamless carousel for the two-bedroom at 123 Main St, $3,450, available Nov 1. Export 2x PNGs."*
- *"Give me three directions for an 8-slide carousel from these photos."* Pick one with Ctrl+Enter, then: *"Push the one I picked further, try a darker palette."* Then: *"Go with C. Export it."*
- *"Make a listing blast in Spread for 123 Main St #3 from these photos."*

See [`docs/claude-workflow.md`](docs/claude-workflow.md) for setup and example prompts, and [`mcp/README.md`](mcp/README.md) for the tool list.

## Brands

A **brand kit** is a design system Spread keeps on your computer (`~/.spread/brands/<id>/`): colors with roles, fonts (with their files), a type scale, a spacing unit, voice, and do/don't rules. Each project uses **one brand or none**, picked from the chip next to the project name. Your company's kit never leaks into a personal project, and you can switch any time (undoable, and the design itself is untouched).

With a brand on:

- Claude reads the kit every turn and designs with only its fonts, colors and scale.
- The layout check flags anything off-brand: a font that isn't a brand font, a color outside the palette, a size off the scale.
- Color fields offer the palette, and the font menu lists the brand's fonts first.
- A saved `.spread` file carries a copy of the kit, so it opens on-brand on another computer.

**Importing.** Ask Claude: *"Import my brand into Spread from my Claude design system / DESIGN.md / brand CSS."* It reads the source and fills in the kit. Then refine it under **Brands** (Spread menu, or *Manage brands…* on the chip).

**Learned rules.** When you pick or reject a row, a **Why?** chip appears in the row header. Choose a reason (*Too busy*, *Generic*, *Love the type*…) or write your own. When a reason keeps coming up, Claude offers to make it a rule of the brand, marked *learned*, so the next project starts from your taste, not from scratch.

## Shortcuts

| Keys | Action |
| --- | --- |
| V H F P R O T | Move, Hand, Frame, Photo frame, Rectangle, Ellipse, Text |
| Space+drag, Scroll, Ctrl+Scroll | Pan, Pan, Zoom |
| Shift+1 / Shift+2 / Shift+0 | Fit / Zoom to selection / 100% |
| Ctrl+A, Ctrl+Z / Ctrl+Shift+Z | Select all, Undo / Redo |
| Ctrl+D, Ctrl+G, Shift+A, Ctrl+Shift+G | Duplicate, Frame, Auto layout, Ungroup |
| Ctrl+C, then Ctrl+V over another slide | Paste onto that slide, same spot |
| Ctrl+Shift+V | Paste in place |
| Ctrl+] / Ctrl+[ | Bring forward / send backward |
| Ctrl+' | Toggle the layout grid |
| Ctrl+J | Show / hide the Claude panel |
| Ctrl+K or Ctrl+T | Jump to a project |
| Ctrl+Tab, Ctrl+1–9, Ctrl+W | Next tab, go to a tab, close the tab |
| Shift (resizing), Alt (dragging) | Keep proportions, disable snapping |

Press **?** (or open the **Spread** menu → Keyboard shortcuts) for the full list. On Mac, Ctrl is ⌘.

## How it's built

- Electron + Vite + React + TypeScript, with a [Konva](https://konvajs.org) canvas.
- `src/types.ts`: the document model (plain JSON). `src/store.ts`: Zustand + Immer with undo history.
- `src/layout.ts`: the auto layout engine (hug, fill and fixed sizing, gap, padding, justify, align).
- `src/components/Canvas.tsx`: selection, transform, snapping, crop, creation tools. `NodeView.tsx` renders nodes.
- `src/exporter.ts`: renders each slide offscreen with **full-resolution** photos. On-canvas photos are downscaled previews so large shoots stay fast.
- `src/automation.ts` + `electron/main.cjs` + `mcp/server.mjs`: the Claude bridge (MCP tools).
- `electron/chat.cjs` + `src/chat.ts` + `src/components/ClaudePanel.tsx`: the Claude panel. It runs `claude -p` in stream-json mode with Spread's MCP server pre-approved, answers other permission requests from the panel, and keeps one session per project in `~/.spread/chats/`.
- `.spread` files are zips of `project.json` plus the original photo and font files.

## Known gaps

- There are no vector pen tool, components or variants. Boards are full rows (carousels or emails), not free-floating artboards.
- Text editing uses an overlay, so line breaks can differ by a pixel or two while you type; the canvas and export match each other.

## Contributing

Spread started as one person's tool, so it fits one workflow best. Fork it and bend it to yours. Issues and pull requests are welcome; keep changes small and run `npm run build` first. It checks types and builds the app, and there's no test suite beyond that yet.

## License

[MIT](LICENSE). Third-party code and fonts keep their own licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
