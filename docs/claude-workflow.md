# Working with Claude in Spread

Claude can drive Spread live, from the Claude desktop app or Claude Code. It imports photos, lays out slides, sets type, looks at what it made, and exports. Everything happens on your canvas while you watch, and you can take over by hand at any point.

## Setup (once)

1. Open Spread (`npm run app`, or the installed app).
2. Click **Claude** in the top bar (or press **Ctrl+J**). The panel opens beside the canvas.
3. The first message asks you to **Sign in**: a Terminal window runs `claude auth login` and opens your browser. Sign in, then click **Try again**.

That's it: chat in the panel and watch the canvas. Spread's tools never ask for permission there; editing files or running commands shows an Allow card in the chat.

To use Spread from the Claude desktop app or from Claude Code in another folder instead, open **Spread menu → Connect Claude…**:
   - **Claude desktop app → Install**, and click **Install** in the window Claude opens. Any chat can now use Spread.
   - **Claude Code → Set up** to use it from every folder. (Inside the Spread repo `.mcp.json` already registers it; approve it the first time.)

Claude follows the same design guides everywhere: as skills in Claude Code (`.claude/skills/`), and through `spread_guide` or the **Spread:** prompts in the Claude desktop app.

## How Claude runs a job

Claude works like a senior designer and marketing lead (the `spread-director` playbook):

1. It reads the canvas, the photos, the brand and any design doc first, then asks one round of questions as cards with options: the goal, the channel, **how many directions** (1, 3 or 5) and **which territory**. Tap answers, or write your own; **Skip** lets it decide.
2. It plays the strategy back in one line and names each direction concept. You approve, swap or drop them before it builds.
3. It builds each direction as a row, checks it, and presents them with a recommendation and a card to pick one.

Say "just make it" to skip the questions.

## Design docs

Claude treats a `DESIGN.md` as the source of truth for how a brand or project looks:

- **A brand's doc.** In **Brands**, link the kit to its `DESIGN.md` (for example `my-site/DESIGN.md`). Any project using that brand gets it.
- **A project's doc.** A `DESIGN.md` in the same folder as the `.spread` file.

The panel tells Claude about both with every message, and Claude reads them before designing. Projects with no brand get neither brand doc.

## Rows and notes

A project can hold several **boards**, stacked as **rows** on one canvas. Each row is a full carousel (or an email) with its own name and a **note** that explains the idea. When Claude makes variations, each one goes in its own row with a short name like *Collage, Bebas + Inter, warm* and a note saying what it's going for and what it trades off.

- Rows are **lettered** from the top: the chip at the start of each row header says A, B, C… So "row C" is the third one down. Letters follow position, so moving a row changes its letter.
- All rows share the same photo tray.
- Click a row to make it active. Your edits, and anything Claude does without naming a row, apply to the active row. Claude doesn't change your active row or selection when it works on other rows.
- Edit a row by hand whenever you like. Claude reads your hand edits before it changes anything and won't overwrite them without asking.
- Double-click a row's name to rename it, or its note to edit it (add a note to a row that has none from its **⋯** menu).

## Picking and rejecting rows

Tell Claude what you think without typing:

| Key | Header button | What it does |
|---|---|---|
| Ctrl+Enter (⌘+Enter) | ✓ | Pick the active row (again to unpick). Its letter chip turns green with a check. |
| Ctrl+Backspace (⌘+Backspace) | × | Reject the active row (again to unreject). The row is muted but kept. Nothing is ever deleted. |

On a picked row, **Promote** in its header moves it to the top of the canvas (also "Move to top" in the row's ⋯ menu). The other rows stay where they were, in order. Ctrl+Z undoes it.

The ⋯ menu also has Rename, Edit note, Move up/down, Export this row, **Copy row reference for Claude** (puts something like *row C "Brick, Fraunces" (boardId …)* on the clipboard to paste into Claude Code) and Delete row.

On its next turn Claude reads your picks, rejects, selection and hand edits first, so "push the one I picked" or "do two more like this" just works.

## Brands and reasons

The chip next to the project name says which brand the project is designed in, or *No brand*. Claude follows the kit on branded projects and stays brand-free on the rest. After a pick or reject, tap **Why?** on the row and choose a reason. Claude applies it straight away, and when the same reason comes up again it offers to save it as a rule of the brand.

- *"Import our brand into Spread from my-site/public/assets/brand.css."*
- *"Use the Acme brand for this project."*
- *"What are the Acme rules? Drop the one about badges."*

## Example prompts

**Daily post (one carousel)**

> Take today's photos in `C:/…/2026-10-26` and make an 8-slide seamless carousel for the two-bedroom at 123 Main St, $3,450, available Nov 1.

**Ideation (several directions)**

> Use the photos in `C:/…/2026-10-26`. Give me three directions for an 8-slide carousel for 123 Main St.

Claude plans three directions that differ in structure, not just fonts: for example one led by type, one led by a photo, and one that plays with the seams. Each is a sequence of slide moves (type cover, hero bleed, seam bridge, punch-in, breather, fact sheet, panorama run, finale) with its own type system and palette. It builds each as its own row, fixes the basics (margins, seams, contrast, the profile-grid crop), then has a critic review every row against a quality bar (idea, lead, scale contrast, rhythm, grouping, one surprise) and fixes or rebuilds what fails. Then you get a short table of the rows with its pick. Pick with Ctrl+Enter, reject with Ctrl+Backspace, then tell it what to push.

**Iteration**

> Push the one I picked further. Try a darker palette and a bigger headline.

> Push row C further. Two more takes with a serif.

> Make the headline smaller on every row.

> Row A but with the kitchen photo on the cover.

> Go with B. Export it.

When Claude pushes a row, it adds the new takes directly below that row and leaves the original alone, so you can still compare.

**Point at things instead of describing them**

Select something in Spread, then say it in Claude Code:

> Make this bigger.

> Move this text off the seam.

> Use this row's type on all the other rows.

Claude checks your current selection and active row before it acts, so "this" means whatever you have selected.

**Export**

> Export row C at 2x to `~/Pictures/Spread/2026-10-26-main-st`.

> Save the project as `main-st.spread`.

Exports are one PNG per slide. Claude tells you the folder path afterwards.

## Tips

- Say how many slides you want and what has to appear (address, price, date, CTA). Claude won't make up listing details.
- Name the brand fonts once ("use our brand fonts in `C:/…/fonts`"). Claude imports them and uses them on every row.
- Ask for directions that differ on specific things ("one type-led, one photo-led, one with a dark finale") to get variety where you want it.
- Give Claude your brand fonts and palette, or let it pull a palette from the photos. If the repo has a `taste/` folder of reference posts, Claude borrows named moves from them.
- Ask Claude to "show me all rows" for a side-by-side overview at any point.
- Hand tweaks are fine at any stage. Small fixes (nudging a crop, a line break) are usually faster by hand than by prompt.
- Ctrl+Z undoes Claude's changes too. Each Claude edit is one undo step.
- Pick and reject as you look (Ctrl+Enter / Ctrl+Backspace). It's the fastest feedback Claude gets.

## E-blasts

Email boards are rows too: 600px wide, height grows with the content. The `spread-eblast` skill builds e-blasts from your saved templates or the built-in ones (listing spotlight, newsletter, resident notice, event) and follows your brand kit.

> Make a listing blast in Spread for 123 Main St #3 from these photos: `C:/…/2026-10-26`. Listing: https://…

The flow:

1. Claude creates the email row from your saved template if you have one (otherwise a built-in one) and fills in every `{{PLACEHOLDER}}` (text, links, alt text).
2. It proposes three subject line and preview text pairs and sets its pick on the board. You see and edit them under **Inbox** in the right panel.
3. It renders the email to look at it, then compiles the HTML to check for warnings (missing alt text, dead links, size over Gmail's 102 KB clip).
4. It exports with your WordPress connected: the images go to the media library and `email.html` points at them. Paste it into your email tool.

**Preview** in the top bar shows the real HTML the way inboxes will: the inbox line, desktop and phone widths, fallback fonts and images off, with a short list of what changes. Claude gets the same view with `spread_preview_email`. It's one browser engine, not Outlook or Gmail themselves, so still send yourself a test.

You can do the last step yourself: **Export → Upload to WordPress → Preview & export → Upload & copy HTML**. Pictures that haven't changed since the last upload are reused, and a changed picture gets a new file name, so emails you've already sent keep working.

### Connecting WordPress (once)

In WordPress, open **Users → Profile → Application Passwords**, name one "Spread" and click **Add**. In Spread's export dialog choose **Upload to WordPress** and enter the site, your username and that application password. It's checked against the site, encrypted with your Mac's Keychain, and never your login password. Without WordPress, choose **One folder URL** or **URL per picture**, upload the images yourself, and export again.

### Templates and references

- **Save as template** (a row's ⋯ menu) keeps a whole email, with its photos and fonts, in your library. It shows under **Your templates** in **New → Email** in every project, and Claude starts from it.
- **Save section as template** (right-click inside a section) keeps one block, like your masthead or footer. It shows under **Your sections** in the dock's **Section** menu.
- **Save as reference** (a row's ⋯ menu) keeps a design you rate highly, with a line on what makes it good. Claude opens your references before designing something similar and holds new work to them. This works for carousels and pages too.
- **Spread menu → Library…** lists both, with Show in Finder and Delete. They live in `~/.spread/templates` and `~/.spread/references`.

Edit the email on the canvas like any other row. To change a link by hand, select the layer and use the Link section in the right panel; with nothing selected, the same panel lists every link on the email and takes tracking tags for all of them. To change alt text, rename the layer: the `[alt:…]` tag in its name is what the export reads.

For a grid of similar cards, like the units in a monthly blast, build one card, select it and click **Repeat this card** in the right panel. Each text and photo becomes a column in a table, and each row is a card. Paste rows from a spreadsheet, with their column names on the first line to match by name. Photo cells take web links, so a column of image URLs works. Or give Claude the listing links and ask it to fill the grid; it uses `spread_repeat`.

To change type or spacing everywhere at once, give it a name. Pick **New style from this text** at the top of the Text section, or open **Manage styles** to name the looks a project already uses. Layers follow their style on every board, except anything you set by hand on one layer. Spacing tokens work the same way for the gap and padding of auto layout frames. Claude uses `spread_save_styles`.

Edit any card on the canvas. A style change reaches every card, and a change to a value only changes that card's row. Turn off **Changes per card** on a layer to give every card the same text or photo. Write `{{field}}` in a text or link to build it from several columns, such as `{{beds}} bed · {{baths}} bath`, and in a photo's layer name for alt text per card: `Photo [alt:{{unit}} living room]`. Delete a card to remove its row. **Stop repeating** keeps the cards as plain layers.
