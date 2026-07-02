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
    .paragraph-highlight { background: var(--vscode-editor-hoverHighlightBackground); }
    #tooltip { position: absolute; max-width: 28rem; padding: .5rem .7rem; border-radius: 4px;
      background: var(--vscode-editorHoverWidget-background);
      border: 1px solid var(--vscode-editorHoverWidget-border); display: none; z-index: 10; }
    /* Shown state is display:flex (centres the box); the initial [hidden] attribute
       + the [hidden] rule below keep it hidden until openEditModal removes hidden. */
    #modal { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex;
      align-items: center; justify-content: center; z-index: 20; }
    #modal .box { background: var(--vscode-editor-background); padding: 1rem; border-radius: 6px;
      width: min(40rem, 90vw); display: flex; flex-direction: column; gap: .5rem; }
    textarea { width: 100%; min-height: 4rem; }
    [hidden] { display: none !important; }
    .spinner::after { content: '…'; }
  </style>
</head>
<body>
  <header>
    <button id="translate-btn" aria-label="Translate">Translate</button>
    <span id="auto-badge" hidden>Auto</span>
    <span id="status" aria-live="polite"></span>
  </header>
  <article id="content" aria-busy="false"></article>

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

  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`
}
