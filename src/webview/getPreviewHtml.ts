import type * as vscode from 'vscode'

/**
 * Preview_Panel HTML. CSP is built from `webview.cspSource`: local images via
 * `asWebviewUri`, plus remote `https:`/`data:` images; scripts only via nonce;
 * no other network access (req 15.1). Uses semantic elements + ARIA.
 */
export function getPreviewHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  nonce: string,
): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); padding: 0; margin: 0; }
    header { position: sticky; top: 0; display: flex; gap: .5rem; align-items: center;
      padding: .4rem .8rem; border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background); }
    #content { padding: 1rem 1.2rem 1rem 2.4rem; } /* left gutter holds the edit/comment icons */
    /* Bilingual: one grid where each block PAIR is a row (height = the taller side),
       so a paragraph is always exactly across from its translation (req 10.4). The
       whole view scrolls as one — no per-pane scroll sync. */
    #content.bilingual { padding: 0; }
    .bgrid { display: grid; grid-template-columns: 1fr 1fr; }
    .bgrid .bcell { padding: .15rem 1.2rem .15rem 2.4rem; min-width: 0; overflow-wrap: anywhere; }
    .bgrid .bcell-l { border-right: 1px solid var(--vscode-panel-border); }
    /* Per-block edit + comment controls (req 10.8): outline icons stacked vertically in
       the left gutter, always visible in BOTH views (edit/comment left the tooltip). */
    #content [data-paragraph-index] { position: relative; }
    .bctl { position: absolute; top: .05rem; display: flex; flex-direction: column;
      gap: .15rem; align-items: center; } /* left is set per block in JS for gutter alignment */
    .bctl button { display: flex; padding: 0; margin: 0; border: none; background: none;
      color: var(--vscode-foreground); cursor: pointer; opacity: 0; }
    /* Icons appear only while the block is hovered (req 10.8)... */
    #content [data-paragraph-index]:hover > .bctl button { opacity: 1; }
    /* ...except a block WITH comments keeps its comment icon shown, drawn filled. */
    .bctl-comment.has { opacity: 1; }
    .bctl-comment.has svg { fill: currentColor; }
    .bctl button svg { width: 14px; height: 14px; display: block; }
    .bctl-comment { position: relative; }
    .bctl-comment .cmt-count { position: absolute; top: -5px; right: -6px; font-size: 9px;
      line-height: 1; padding: 0 3px; border-radius: 6px; vertical-align: baseline;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .paragraph-highlight { background: var(--vscode-editor-hoverHighlightBackground); }
    /* Bilingual pair highlight (req 10.7): the hovered block and its counterpart in
       the other pane. The accent bar is a pseudo-element sitting in the cell's left
       padding — to the LEFT of the text — so it never overlaps the first characters. */
    .pair-highlight { position: relative; background: var(--vscode-editor-hoverHighlightBackground); }
    .pair-highlight::before { content: ''; position: absolute; top: 0; bottom: 0; left: -.5rem;
      width: 3px; background: var(--vscode-focusBorder); }
    #tooltip { position: absolute; max-width: 28rem; padding: .5rem .7rem; border-radius: 4px;
      background: var(--vscode-editorHoverWidget-background);
      border: 1px solid var(--vscode-editorHoverWidget-border); display: none; z-index: 10; }
    /* Shown state is display:flex (centres the box); the initial [hidden] attribute
       + the [hidden] rule below keep it hidden until openEditModal removes hidden. */
    #modal, #comment-modal { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex;
      align-items: center; justify-content: center; z-index: 20; }
    #modal .box, #comment-modal .box { background: var(--vscode-editor-background); padding: 1rem;
      border-radius: 6px; width: min(40rem, 90vw); display: flex; flex-direction: column; gap: .5rem; }
    textarea { width: 100%; min-height: 4rem; }
    /* Comments (req 11): the thread modal + comment list. */
    #comment-list { display: flex; flex-direction: column; gap: .4rem; max-height: 42vh; overflow-y: auto; }
    .cmt-item { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: .4rem .5rem;
      display: flex; flex-direction: column; gap: .3rem; }
    .cmt-item .meta { font-size: .72em; opacity: .65; }
    .cmt-item .row { display: flex; gap: .4rem; justify-content: flex-end; }
    .cmt-body { white-space: pre-wrap; word-break: break-word; }
    #orphaned { padding: .4rem 1.2rem; border-top: 1px solid var(--vscode-panel-border); font-size: .85em; }
    #orphaned .oc { margin: .25rem 0; }
    #orphaned .quote { opacity: .7; font-style: italic; }
    [hidden] { display: none !important; }
    .spinner::after { content: '…'; }
  </style>
</head>
<body>
  <header>
    <button id="translate-btn" aria-label="Translate">Translate</button>
    <button id="bilingual-btn" aria-label="Bilingual view" disabled>Bilingual</button>
    <span id="auto-badge" hidden>Auto</span>
    <span id="status" aria-live="polite"></span>
  </header>
  <article id="content" aria-busy="false"></article>
  <section id="orphaned" aria-label="Outdated comments" hidden></section>

  <div id="tooltip" role="tooltip"></div>

  <div id="modal" role="dialog" aria-modal="true" aria-label="Edit paragraph" hidden>
    <div class="box">
      <strong>Edit paragraph</strong>
      <label>Storage <textarea id="modal-storage"></textarea></label>
      <label>Target <textarea id="modal-target"></textarea></label>
      <div id="modal-error" role="alert"></div>
      <div style="display:flex; gap:.5rem; justify-content:flex-end;">
        <button id="modal-cancel">Cancel</button>
        <button id="modal-save">Save</button>
      </div>
    </div>
  </div>

  <div id="comment-modal" role="dialog" aria-modal="true" aria-label="Comments" hidden>
    <div class="box">
      <strong>Comments</strong>
      <div id="comment-list"></div>
      <label>Add a comment <textarea id="comment-input"></textarea></label>
      <div style="display:flex; gap:.5rem; justify-content:flex-end;">
        <button id="comment-close">Close</button>
        <button id="comment-add">Add</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`
}
