# Code syntax highlighting with theme selection — design

## Goal

Colour fenced code blocks in the preview (keywords, strings, numbers, comments),
with the theme chosen in settings: a named theme, an **auto** mode that follows
the editor's light/dark theme, or **off**.

## What the user experiences

Code in the preview is no longer flat grey — it reads like code, coloured by a
theme. The theme is picked in the extension settings from a small curated list,
plus **Auto** (default, follows the editor's light/dark theme) and **Off** (plain
monospaced code, as before). With Auto, switching the editor between a light and
a dark theme re-colours the code instantly, with no flicker. The colour appears
everywhere the rendered Markdown shows: the main view, the bilingual view, and
the hover peek.

## Structure and flow

Highlighting is computed where the preview HTML is already assembled — on the
extension side, before anything reaches the webview. That keeps the webview
client small and means every surface that already renders through the shared
renderer gains highlighting for free. A highlighter tags each fragment of code
with class names (keyword, string, comment, …); the actual colours come from a
theme stylesheet. Highlighting is applied **after** translation, so a translated
comment is still a comment token and is coloured as one — it never bleeds into
the colour of code.

The markup a highlighter emits is identical for every theme; only the stylesheet
differs. That is the whole trick behind theme selection:

- a **named** theme injects that theme's stylesheet;
- **auto** injects both a light and a dark stylesheet, each scoped under the
  editor's light/dark body signal, so the preview follows the editor with no
  script and no round-trip to the extension when the editor theme changes;
- **off** injects nothing; code falls back to a plain monospaced block (a base
  code-block look is added regardless, since the preview had none before).

Changing the *setting itself* re-colours already-open previews by swapping the
one stylesheet in place — again no re-render.

## The theme set

Around eight curated themes (dark: GitHub Dark, Monokai, Nord, Atom One Dark,
Dracula; light: GitHub Light, Solarized Light), plus **auto** (default) and
**off**. Their stylesheets are small and are vendored with the extension so they
ship in the package (the highlighter's own library files are not shipped).

## Configuration

One new setting in a new *Appearance* section: the code-highlight theme, a
dropdown of human-readable names, defaulting to **auto**. It behaves like the
other enum settings and modifies no document.

## Decisions and trade-offs

- **Extension-side, not client-side.** The highlighter library is large; running
  it on the extension keeps the webview client under its size budget and reuses
  the existing render path for every surface.
- **Sanitisation.** The sanitiser would strip the highlighter's class names, so
  its allow-list is widened for exactly those two element kinds. Class names are
  inert (no scripts run — the content policy forbids them, and no style or event
  attributes are allowed), so this cannot execute anything; it only lets the
  theme stylesheet find its hooks.
- **Unlabelled blocks are auto-detected.** A block that declares a language is
  coloured by it; a block with none is best-effort auto-detected. If that proves
  noisy in practice, it can be narrowed to labelled-only later.
- **Block indexing is untouched.** Highlighting only adds spans inside a code
  element, so the block-to-source-line correspondence the scroll sync and
  write-back rely on stays exactly as it was.

## Testing

The theme selector yields no stylesheet for *off*, an unscoped stylesheet for a
named theme, and a light+dark pair — each gated on the editor body signal, with
no unscoped rule leaking — for *auto*. The renderer colours a fenced block
(including its comment), leaves inline code alone, and does not fail on an
unknown language. A live check confirms *auto* paints the exact light and dark
theme colours when the editor body signal flips.
