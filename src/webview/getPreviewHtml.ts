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
    #content { padding: 1rem 1.2rem; }
    /* Bilingual: two independently scrolling panes (source | translation). */
    #content.bilingual { display: grid; grid-template-columns: 1fr 1fr; gap: 0; padding: 0; }
    #content.bilingual .pane { overflow-y: auto; max-height: calc(100vh - 2.6rem); padding: 1rem 1.2rem; }
    #content.bilingual .pane:first-child { border-right: 1px solid var(--vscode-panel-border); }
    .paragraph-highlight { background: var(--vscode-editor-hoverHighlightBackground); }
    /* Bilingual pair highlight (req 10.7): the hovered block and its counterpart in
       the other pane. Inset box-shadow draws the left accent without shifting text. */
    .pair-highlight { background: var(--vscode-editor-hoverHighlightBackground);
      box-shadow: inset 3px 0 0 var(--vscode-focusBorder); }
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
    /* Comments (req 11): a 💬 indicator next to a commented block; a thread modal. */
    .cmt-indicator { cursor: pointer; margin-left: .35rem; opacity: .7; user-select: none; font-size: .9em; }
    .cmt-indicator:hover { opacity: 1; }
    .cmt-count { font-size: .75em; vertical-align: super; }
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
