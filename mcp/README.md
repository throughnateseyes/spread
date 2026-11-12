# Spread MCP server

Lets Claude (the Claude desktop app, Claude Code, or any MCP client) drive the running Spread app: import a folder of photos, arrange them seamlessly, set type, look at rendered slides, build rows of variations to compare, and export. Everything happens live on the canvas, so you can take over and tweak by hand at any point. Nothing goes through Figma, so there are no API limits.

## How it connects

```
Claude ──stdio──> mcp/server.mjs ──HTTP (127.0.0.1, bearer token)──> Spread app bridge ──> canvas
```

When the Spread app starts, it writes `~/.spread/bridge.json` (`~/.spread-dev/` for `npm run dev`; set `SPREAD_HOME` to point the server at either) (`{ port, token, pid }`). The MCP server re-reads that file on every call, so restarting the app is fine. The bridge listens on localhost only. The app also writes `~/.spread/app.json` (how to start it), which `spread_launch` uses, so the server can live anywhere.

## Setup

The easy way: in Spread, click **Claude** in the top bar.

- **Claude desktop app → Install** opens `release/Spread.mcpb`, a Claude Desktop extension with the server bundled (Claude runs it on its own Node). Build it yourself with `npm run connector`.
- **Claude Code → Set up** runs `claude mcp add --scope user spread -- node <repo>/mcp/server.mjs`, so it works from every folder.

In this repo `.mcp.json` also registers the server at project scope; approve it the first time Claude Code asks.

To check the bridge by hand while the app is running:

```bash
node mcp/smoke.mjs
```

## Tools

Every tool carries MCP safety hints: looking tools are marked read-only, and only deleting rows or layers and replacing the open project are marked destructive, so clients can ask for permission less often.

| Tool | What it does |
| --- | --- |
| `spread_launch` | Start the app if it isn't running |
| `spread_guide` | The design workflow and quality bar for a medium (`document`, `carousel`, `eblast`); the same text as the skills. Also offered as the prompts `spread-document`, `spread-carousel`, `spread-eblast` |
| `spread_get_state` | One board: slides, node tree with absolute boxes, selection, photo tray, plus the list of all boards. `detail: 'outline'` trims the tree to ids, names and boxes |
| `spread_list_links` | Every link on a board, with empty, placeholder and invalid ones flagged |
| `spread_wrap_nodes` | Wrap existing layers in a frame or auto layout frame without rebuilding them; auto layout keeps their direction, gap and alignment, like Figma's Shift+A |
| `spread_repeat` | Fill a grid from data: one card plus rows, with photos from links or files |
| `spread_list_styles` | Text styles and spacing tokens, plus text that has no style yet |
| `spread_save_styles` | Add or change named styles; every linked layer on every board follows |
| `spread_import_photos` | Import files or folders (images and fonts) by absolute path |
| `spread_arrange` | Lay photos across slides: `one-per-slide`, `panorama`, `collage`, `brick`; `slides` sets the slide count |
| `spread_add_nodes` | Add text, image, rect, ellipse or frame layers (auto layout supported) |
| `spread_update_nodes` | Patch layers by id or `key` (a key hits every layer with that key on the board) |
| `spread_delete_nodes` | Delete layers by id or `key` |
| `spread_set_document` | Board name, slide size, slide count, background, per-slide backgrounds, layout grid; page margins and baseline grid on document boards |
| `spread_select` | Select layers in the app |
| `spread_render_slides` | Render one board's slides as images so Claude can check its work |
| `spread_export_slides` | Write one board's slides as PNG or JPEG files to a folder (1x, 2x or 3x) |
| `spread_export_pdf` | Write a board as a PDF with real, selectable text and embedded fonts (one page per page/slide; photos at 300 dpi). Emails print as one long page or US Letter pages, with clickable links |
| `spread_pdf_text` | Read a PDF's text per page in reading order, the way an applicant-tracking system or screen reader sees it |
| `spread_lint` | The app's layout checks: off-page, crosses-page, margin, overflow, tiny text, line length, widows, baseline, contrast, overlap, alignment near-misses, spacing, type sprawl, empty pages. With a project brand, also `brand-font`, `brand-color` and `brand-scale` |
| `spread_batch` | Several methods in one call, stopping at the first error (fewer round trips and permission prompts); rendered images come back as images |
| `spread_list_brands` | The brand kits in the library and which one the project uses |
| `spread_get_brand` | A brand kit in full: colors and roles, fonts and roles, type scale, spacing, voice, rules |
| `spread_save_brand` | Create or update a kit (import from a design system, DESIGN.md or CSS; `addRules` for learned rules; `fontFiles` to copy fonts in) |
| `spread_use_brand` | Switch the project to a brand, or to none |
| `spread_list_projects` | Every project on Home: name, path, kinds, boards, folder and last change |
| `spread_save_project` / `spread_open_project` / `spread_new_project` | `.spread` project files; open and new use their own tab |
| `spread_undo` / `spread_redo` | History |
| `spread_list_fonts` | Font families you can use |

### Boards (rows)

A project holds several boards stacked as rows on one canvas. Each board is a `carousel` or an `email` (600px wide, height grows with the content) with its own id, name, note, slide size and layers. The photo tray is shared.

| Tool | What it does |
| --- | --- |
| `spread_list_boards` | All rows, top first: id, index, name, kind, note, active, slide count |
| `spread_activate_board` | Make a row active (the app highlights it) |
| `spread_create_board` | Add an empty carousel, email or document row (document: page presets for print and screen, page count, margins, baseline grid) |
| `spread_make_variants` | **The ideation tool.** Copy a row once per variant and restyle each copy in one call: `arrange` (re-lay out photos in place; the slide count fits the new layout, captions follow their photo, last-slide layers move to the new last slide), `changes` by key, `add`. Copies land below the source; the user's focus is untouched; one undo step per variant |
| `spread_get_feedback` | What the user said with the mouse: active row, selection, picked/rejected rows, hand edits since Claude's last change (`userTouched`, and `handEdits`: the net changes in words) |
| `spread_design_notes` | The user's design notes: lessons from finished work, kept across projects (also appended to every `spread_guide`) |
| `spread_add_design_notes` | Save lessons from a finished piece (or rewrite the notes) |
| `spread_duplicate_board` | Plain copy of a row N times, with `names[]` and `notes[]`; copies land directly below |
| `spread_update_board` | Rename a row, edit its note, or set its `status` (`picked` / `rejected` / null) |
| `spread_delete_board` | Delete a row (not the last one) |
| `spread_render_overview` | One full-strip image per row, each labelled "Row C (3) — name — [status] — note — boardId" |

Every board-scoped tool (`get_state`, `arrange`, `add_nodes`, `update_nodes`, `delete_nodes`, `set_document`, `select`, `render_slides`, `export_slides`) takes an optional `boardId`. Without it, the tool acts on the active board; with it, the app switches to that board first. Layer ids are per board, and duplicated boards get new layer ids. Layer `key`s (stable role names such as `headline`, `price`, `cta`, `photo-1`) survive duplication, so key the important layers and address them by key across rows.

Rows are lettered A, B, C… by position. The user picks a row with Ctrl+Enter and rejects one with Ctrl+Backspace (rejected rows are kept, never deleted).

### Email boards

| Tool | What it does |
| --- | --- |
| `spread_list_email_templates` | Email templates and insertable sections |
| `spread_create_email` | New email row from a template (`listing-spotlight`, `newsletter`, `resident-notice`, `event`, `blank`) |
| `spread_add_email_section` | Insert a section into an email row |
| `spread_email_html` | Compile to inbox-safe HTML without writing files: size, warnings, image list |
| `spread_history` | Who changed what and when, filtered by board, layer, person or words |
| `spread_set_overlay` | Lay a past design over a board to compare: a picture, an email's HTML, another board or a saved reference |
| `spread_compare_overlay` | Measure a board against its reference: pixels changed, where, which layers, and what moved up or down |
| `spread_send_check` | Subject, unsubscribe, address, links and alt text: is this email ready to send? |
| `spread_preview_email` | See the real HTML as inboxes show it: desktop, phone, fallback fonts, images off, with checks and pictures |
| `spread_export_email` | Write `email.html` plus images to a folder; re-export with `baseUrl` once the images are hosted |

Coordinates are strip-space pixels, per board. Slide `i` spans `x ∈ [i*slideWidth, (i+1)*slideWidth)`. Anything that crosses `x = k*slideWidth` is split across slides, which is how the seamless effect works.

The Claude Code skill in `.claude/skills/spread-carousel` covers the quick-post and ideation workflows; `.claude/skills/spread-eblast` covers e-blasts. [`docs/claude-workflow.md`](../docs/claude-workflow.md) is the guide for people using it.
