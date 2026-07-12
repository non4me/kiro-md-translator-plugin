/* Preview_Panel webview client (browser sandbox). Vanilla TS, no frameworks. */
import { trimFragment, type Fragment } from '../fragments'
import type { FragmentAnchor } from '../types'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

const api = acquireVsCodeApi()
const post = (message: unknown): void => api.postMessage(message)

const HOVER_MS = 500
const HIDE_MS = 250 // grace period so the pointer can travel to the tooltip
const MODAL_MS = 1000
const TIP_GAP = 6

const content = document.getElementById('content') as HTMLElement
const tooltip = document.getElementById('tooltip') as HTMLElement
const translateBtn = document.getElementById('translate-btn') as HTMLButtonElement
const bilingualBtn = document.getElementById('bilingual-btn') as HTMLButtonElement
const autoBadge = document.getElementById('auto-badge') as HTMLElement
const settingsLink = document.getElementById('settings-link') as HTMLAnchorElement
const statusEl = document.getElementById('status') as HTMLElement
const modal = document.getElementById('modal') as HTMLElement
const modalStorage = document.getElementById('modal-storage') as HTMLTextAreaElement
const modalTarget = document.getElementById('modal-target') as HTMLTextAreaElement
const modalError = document.getElementById('modal-error') as HTMLElement
const modalCancel = document.getElementById('modal-cancel') as HTMLButtonElement
const modalSave = document.getElementById('modal-save') as HTMLButtonElement
const commentModal = document.getElementById('comment-modal') as HTMLElement
const commentList = document.getElementById('comment-list') as HTMLElement
const commentInput = document.getElementById('comment-input') as HTMLTextAreaElement
const commentAdd = document.getElementById('comment-add') as HTMLButtonElement
const commentClose = document.getElementById('comment-close') as HTMLButtonElement
const orphanedEl = document.getElementById('orphaned') as HTMLElement
const selToolbar = document.getElementById('sel-toolbar') as HTMLElement
const selEdit = document.getElementById('sel-edit') as HTMLButtonElement
const selComment = document.getElementById('sel-comment') as HTMLButtonElement

// Comments (req 11). `commentCounts` drives the 💬 indicators; `openThreadIndex`
// is the block whose thread modal is open; `threadMode` routes a commentThread
// reply to either the modal or a hover popover (they can be requested apart).
let commentCounts = new Map<number, number>()
// The fragment a NEW comment binds to (formed from the selection when the comment
// action fires). Undefined for a whole-block comment or an existing-thread open.
let modalFragment: FragmentAnchor | undefined
// paragraphIndex → the fragment quotes on that block, so the highlight can be repainted
// after every content re-render (the DOM is rebuilt, so ranges must be recomputed).
let blockFragments = new Map<number, string[]>()
let openThreadIndex = -1
let threadMode: 'popover' | 'modal' = 'popover'
let threadReqIndex = -1
// The block a popover request was fired from — so the peek anchors to the hovered
// pane in bilingual, not always the first (source) cell that blocks().find returns.
let threadAnchorEl: HTMLElement | undefined

let editIndex = -1
let suppressScroll = false
let hoverTimer: number | undefined
let hideTimer: number | undefined
let hoveredEl: HTMLElement | undefined

// Translate <-> Original toggle. The webview caches BOTH renderings so switching
// is instant and never re-hits the translation API; the host stays the source of
// truth for hover direction, kept in sync via a 'displayModeChanged' message.
let sourceHtml: string | undefined
let translatedHtml: string | undefined
let displaying: 'source' | 'translation' = 'source'
let storageCode = ''
let targetCode = ''

// Bilingual (two-column) view state (req 10). Purely webview-local: it reuses the
// cached source/translation HTML and shared data-paragraph-index — no API, no new
// host message. `pendingBilingual` waits for a first translation before entering.
let bilingual = false
let pendingBilingual = false
// Bilingual pair highlight (req 10.7): the paragraph index currently highlighted
// across BOTH panes; tracked so an intra-block pointer move does not re-toggle it.
let pairIndex: string | undefined

function langBadge(code: string): string {
  return code ? code.split('-')[0].toUpperCase() : ''
}

function updateButtonLabel(): void {
  const label =
    displaying === 'translation'
      ? `Original${storageCode ? ` (${langBadge(storageCode)})` : ''}`
      : `Translate${targetCode ? ` (${langBadge(targetCode)})` : ''}`
  // Outline icon button (variant B): the label is the tooltip, the SVG stays intact.
  translateBtn.title = label
  translateBtn.setAttribute('aria-label', label)
}

/**
 * Render markup that was produced AND sanitized on the extension host
 * (rehype-sanitize) and delivered over postMessage. We parse it into a detached
 * fragment — scripts never execute that way — instead of assigning innerHTML,
 * and the webview CSP additionally forbids inline/remote scripts.
 */
function setSanitizedHtml(target: HTMLElement, html: string): void {
  const fragment = document.createRange().createContextualFragment(html)
  target.replaceChildren(fragment)
}

/** Swap the visible content and (re)bind hover on the fresh block elements. */
function showContent(html: string): void {
  hideTooltipNow() // the open tooltip/hoveredEl reference the DOM we're detaching
  setSanitizedHtml(content, html)
  content.setAttribute('aria-busy', 'false')
  statusEl.textContent = ''
  bindHover()
  drawBlockControls() // the gutter comment marker (actions live on the cursor toolbar now)
  highlightFragments() // repaint fragment highlights on the rebuilt DOM from cached quotes
  // The DOM was replaced → any comment markers are gone. Pull fresh comment data so
  // the host re-anchors and re-emits; this covers every re-render path uniformly.
  post({ type: 'requestComments' })
  refreshFind() // the old match ranges point at the detached DOM — recompute if the bar is open
}

// --- bilingual (two-column) view (req 10) ------------------------------------

/** Rebuild the bilingual view as ONE grid: pair the top-level blocks of source and
 *  translation into grid rows (row height = the taller side) so every block sits
 *  exactly across from its translation regardless of differing heights (req 10.4).
 *  Source and translation share identical block structure, so children pair 1:1 by
 *  position. The view scrolls as one — no per-pane scroll sync. Binds NO hover
 *  tooltip (req 10.5); the delegated pair highlight (req 10.7) still applies. */
function renderBilingualPanes(): void {
  hideTooltipNow()
  const srcKids = Array.from(document.createRange().createContextualFragment(sourceHtml ?? '').children)
  const tgtKids = Array.from(document.createRange().createContextualFragment(translatedHtml ?? '').children)
  const grid = document.createElement('div')
  grid.className = 'bgrid'
  const rows = Math.max(srcKids.length, tgtKids.length)
  for (let i = 0; i < rows; i++) {
    const l = document.createElement('div')
    l.className = 'bcell bcell-l'
    if (srcKids[i]) l.appendChild(srcKids[i]) // appendChild MOVES it out of the fragment
    const r = document.createElement('div')
    r.className = 'bcell bcell-r'
    if (tgtKids[i]) r.appendChild(tgtKids[i])
    grid.append(l, r) // L,R interleaved → each pair is one grid row (2 columns)
  }
  content.replaceChildren(grid)
  content.setAttribute('aria-busy', 'false')
  statusEl.textContent = ''
  pairIndex = undefined // the previously highlighted nodes were just detached
  drawBlockControls() // req 10.8: edit/comment icons per block
  post({ type: 'requestComments' }) // fills the comment-icon counts / persistent bubbles
  refreshFind() // recompute match ranges against the rebuilt bilingual grid
}

const SVG_NS = 'http://www.w3.org/2000/svg'
// Feather-style outline glyphs (stroke, no fill): edit-2 pencil + message-square.
const EDIT_ICON = 'M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z'
const COMMENT_ICON = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'
// Toolbar glyphs (variant B), matching the native editor-title SVGs (media/*.svg):
// a dictionary book with 文A (translate) and split columns (bilingual).
const TRANSLATE_ICON = [
  'M6 3 h12 a2 2 0 0 1 2 2 v14 a2 2 0 0 1 -2 2 h-12 a2 2 0 0 1 -2 -2 v-14 a2 2 0 0 1 2 -2 z', // book cover
  'M6.8 8 h4', // 文 — top stroke
  'M8.8 6.8 v1.2', // 文 — tick
  'M8.8 9.2 l-2.2 4.2', // 文 — left leg
  'M8.8 9.2 l2.2 4.2', // 文 — right leg
  'M12.4 17.2 l2 -5 l2 5', // A — legs
  'M13.1 15.3 h2.6', // A — crossbar
]
const BILINGUAL_ICON = 'M3 4h18v16H3z M12 4v16'
const GUTTER_INSET_PX = 6 // where the icon column sits inside the pane's left gutter

/** Build a stroked (outline) 24×24 icon from one path or several. */
function icon(pathD: string | string[]): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  for (const d of Array.isArray(pathD) ? pathD : [pathD]) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

// Outline icons for the toolbar buttons (variant B). The label text lives in the
// button's title/aria-label (set by updateButtonLabel/updateBilingualBtn).
translateBtn.appendChild(icon(TRANSLATE_ICON))
bilingualBtn.appendChild(icon(BILINGUAL_ICON))
selEdit.appendChild(icon(EDIT_ICON))
selComment.appendChild(icon(COMMENT_ICON))

/** Draw the gutter marker for every block. As of the affordance redesign (stage 2) the
 *  gutter shows ONLY the existing-comment marker — the edit and new-comment actions moved
 *  to the cursor toolbar (`#sel-toolbar`) that appears on text selection. The marker stays
 *  here because it belongs to the block, not the selection: it must be visible without any
 *  interaction so you can see at a glance which blocks carry comments. Reuses existing host
 *  messages; works in BOTH single and bilingual view. */
function drawBlockControls(): void {
  for (const el of blocks()) {
    // Skip a block nested inside ANOTHER indexed block (a loose list's inner <p> — its
    // <li> already carries the marker) so the two don't draw an overlapping duplicate.
    if (el.parentElement?.closest('[data-paragraph-index]')) continue
    if (el.querySelector(':scope > .bctl')) continue // fresh render, but stay idempotent
    const idx = Number(el.dataset.paragraphIndex)

    const cmt = document.createElement('button')
    cmt.className = 'bctl-comment'
    cmt.title = 'Comments'
    cmt.appendChild(icon(COMMENT_ICON))
    cmt.appendChild(Object.assign(document.createElement('span'), { className: 'cmt-count' }))
    cmt.addEventListener('mouseenter', () => {
      threadAnchorEl = el // anchor the popover to THIS block (its own pane in bilingual)
      requestThread(idx, 'popover') // popover shown only if comments exist
    })
    // Bilingual has no bindHover, so give the popover a pointer dismiss path here.
    cmt.addEventListener('mouseleave', scheduleHide)
    cmt.addEventListener('click', (e) => {
      e.stopPropagation()
      openCommentModal(idx)
    })

    const ctl = document.createElement('span')
    ctl.className = 'bctl'
    // Only a double-click on an ICON is ours; the rest of .bctl is the transparent gutter
    // bridge below, and double-clicking empty gutter must still reach #content (open source).
    ctl.addEventListener('dblclick', (e) => {
      if ((e.target as Element | null)?.closest('button')) e.stopPropagation()
    })
    ctl.append(cmt)
    // Pull the icon row into the pane's left gutter regardless of the block's own
    // indentation (list items / blockquotes sit further right). The indent is padding-
    // based, so it is width-independent and stays correct across resizes.
    const pane = (el.closest('.bcell') as HTMLElement | null) ?? content
    const paneRect = pane.getBoundingClientRect()
    if (paneRect.width > 0) {
      const indent = el.getBoundingClientRect().left - paneRect.left
      ctl.style.left = `${GUTTER_INSET_PX - indent}px`
      // Stretch the control across the empty gutter up to the block's own left edge. The
      // icons only appear while the BLOCK is hovered, and the gutter they are drawn in is
      // NOT part of the block's box — so without this bridge the pointer loses the hover on
      // its way to them and they vanish (or, worse, the neighbour lights up instead).
      // `.bctl` is a DOM descendant of the block, so anywhere inside it still counts as
      // hovering the block. Never narrower than the icons themselves (min-width in CSS).
      ctl.style.width = `${Math.max(0, indent - GUTTER_INSET_PX)}px`
    }
    el.appendChild(ctl)
  }
}

/** Reflect commentCounts on the comment icons (both views): a persistent (marked)
 *  bubble for blocks that have comments, plus a number when > 1. */
function updateBlockCommentCounts(): void {
  for (const el of blocks()) {
    const cmt = el.querySelector<HTMLElement>(':scope > .bctl > .bctl-comment')
    if (!cmt) continue
    const count = commentCounts.get(Number(el.dataset.paragraphIndex)) ?? 0
    cmt.classList.toggle('has', count > 0)
    const c = cmt.querySelector<HTMLElement>('.cmt-count')
    if (c) c.textContent = count > 1 ? String(count) : ''
  }
}

function enterBilingual(): void {
  if (translatedHtml === undefined) return // nothing to show on the right yet
  bilingual = true
  pendingBilingual = false
  content.classList.add('bilingual')
  renderBilingualPanes()
  updateBilingualBtn()
}

function exitBilingual(): void {
  highlightPair(undefined) // drop the pair highlight before the panes are torn down
  bilingual = false
  content.classList.remove('bilingual')
  // Restore the single view (translation if we have it, else source) and keep the
  // host's hover direction in sync via the existing displayModeChanged message.
  if (translatedHtml !== undefined) {
    displaying = 'translation'
    showContent(translatedHtml)
    post({ type: 'displayModeChanged', displaying: 'translation' })
  } else {
    displaying = 'source'
    showContent(sourceHtml ?? '')
    post({ type: 'displayModeChanged', displaying: 'source' })
  }
  updateButtonLabel()
  updateBilingualBtn()
}

function updateBilingualBtn(): void {
  bilingualBtn.disabled = targetCode === '' // no target → no translation to pair (req 10.2)
  const label = bilingual ? 'Single view' : 'Bilingual'
  bilingualBtn.title = label
  bilingualBtn.setAttribute('aria-label', label)
}

/** Bilingual pair highlight (req 10.7): highlight the hovered block AND its
 *  counterpart (same data-paragraph-index) in the other pane. Highlight-only —
 *  no tooltip (req 10.5) and no host round-trip; `idx === pairIndex` short-circuits
 *  so an intra-block pointer move does not thrash the class list. */
function highlightPair(idx: string | undefined): void {
  if (idx === pairIndex) return
  for (const el of Array.from(content.querySelectorAll<HTMLElement>('.pair-highlight'))) {
    el.classList.remove('pair-highlight')
  }
  pairIndex = idx
  if (idx === undefined) return
  for (const el of Array.from(content.querySelectorAll<HTMLElement>(`[data-paragraph-index="${idx}"]`))) {
    el.classList.add('pair-highlight')
  }
}

function blocks(): HTMLElement[] {
  return Array.from(content.querySelectorAll<HTMLElement>('[data-paragraph-index]'))
}

function hideTooltipNow(): void {
  window.clearTimeout(hideTimer)
  window.clearTimeout(hoverTimer) // also drop a pending show for a block being torn down
  tooltip.style.display = 'none'
  hoveredEl?.classList.remove('paragraph-highlight')
  hoveredEl = undefined
}

function scheduleHide(): void {
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(hideTooltipNow, HIDE_MS)
}

function cancelHide(): void {
  window.clearTimeout(hideTimer)
}

function bindHover(): void {
  for (const el of blocks()) {
    el.addEventListener('mouseover', (e) => {
      // Pointer over the gutter icons (DOM children of the block) is NOT hovering the
      // text — don't arm the reverse-translation tooltip, and cancel any pending one.
      if ((e.target as Element | null)?.closest('.bctl')) {
        window.clearTimeout(hoverTimer)
        return
      }
      cancelHide() // returning from the tooltip must not hide it
      if (hoveredEl && hoveredEl !== el) hoveredEl.classList.remove('paragraph-highlight')
      el.classList.add('paragraph-highlight') // < 50 ms (req 7.1)
      hoveredEl = el
      window.clearTimeout(hoverTimer)
      hoverTimer = window.setTimeout(() => {
        post({ type: 'paragraphHover', paragraphIndex: Number(el.dataset.paragraphIndex) })
      }, HOVER_MS)
    })
    el.addEventListener('mouseleave', () => {
      window.clearTimeout(hoverTimer) // cancel a still-pending show
      scheduleHide() // keep it alive long enough to reach the tooltip
    })
  }
}

// The tooltip is itself hoverable: entering cancels the pending hide so its Edit
// button is clickable; leaving it (without going back to the paragraph) hides it.
tooltip.addEventListener('mouseenter', cancelHide)
tooltip.addEventListener('mouseleave', scheduleHide)

/** Position the tooltip ABOVE the block by default; flip below only if it would
 *  clip the top of the viewport. Horizontal position is clamped into view. */
function openTooltip(el: HTMLElement, ...nodes: Node[]): void {
  // NB: do NOT cancelHide() here — a reply arriving after the pointer already
  // left the block must let the pending hide run (otherwise the tooltip sticks).
  // The hide is cancelled only by an actual mouseenter on the block or tooltip.
  tooltip.replaceChildren(...nodes)
  tooltip.style.display = 'block'
  const rect = el.getBoundingClientRect()
  const tipH = tooltip.offsetHeight
  const tipW = tooltip.offsetWidth
  const fitsAbove = rect.top - tipH - TIP_GAP >= 0
  const top = fitsAbove
    ? window.scrollY + rect.top - tipH - TIP_GAP
    : window.scrollY + rect.bottom + TIP_GAP
  const maxLeft = window.scrollX + document.documentElement.clientWidth - tipW - 4
  const left = Math.max(window.scrollX + 4, Math.min(window.scrollX + rect.left, maxLeft))
  tooltip.style.top = `${top}px`
  tooltip.style.left = `${left}px`
}

function textNode(tag: string, text: string): HTMLElement {
  const el = document.createElement(tag)
  el.textContent = text
  return el
}

// Element-level scroll sync: report the topmost visible block (req 2.3).
window.addEventListener('scroll', () => {
  hideTooltipNow() // dismiss the hover tooltip on scroll
  window.clearTimeout(hoverTimer)
  if (bilingual) return // bilingual scrolls as one grid; no editor scroll sync here
  if (suppressScroll) {
    suppressScroll = false
    return
  }
  const top = blocks().find((el) => el.getBoundingClientRect().bottom > 48)
  if (top) post({ type: 'scrollChanged', topParagraphIndex: Number(top.dataset.paragraphIndex) })
})

// The button toggles Translate <-> Original. Both directions reuse cached HTML
// (no API) once a translation exists; the first translation asks the host. Named so
// BOTH the toolbar button and the native editor-title command (hostToggleTranslate)
// run the exact same logic.
function doTranslateToggle(): void {
  if (bilingual) return // the single-view toggle must not tear down the two-pane layout
  if (displaying === 'translation') {
    if (sourceHtml === undefined) return
    showContent(sourceHtml)
    displaying = 'source'
    updateButtonLabel()
    post({ type: 'displayModeChanged', displaying: 'source' })
  } else if (translatedHtml !== undefined) {
    showContent(translatedHtml)
    displaying = 'translation'
    updateButtonLabel()
    post({ type: 'displayModeChanged', displaying: 'translation' })
  } else {
    post({ type: 'translateRequest' }) // host translates (reuses the segment cache)
  }
}
// Bilingual toggle: enter needs a translation — request one first if absent. Shared
// by the toolbar button and the native editor-title command (hostToggleBilingual).
function doBilingualToggle(): void {
  if (bilingual) {
    exitBilingual()
    return
  }
  if (targetCode === '') return // disabled anyway (req 10.2)
  if (translatedHtml === undefined) {
    pendingBilingual = true
    post({ type: 'translateRequest' }) // enter once translationComplete arrives
    return
  }
  enterBilingual()
}
translateBtn.addEventListener('click', doTranslateToggle)
bilingualBtn.addEventListener('click', doBilingualToggle)
// The "configure settings" link shown when required settings are missing (req 3.20).
settingsLink.addEventListener('click', (e) => {
  e.preventDefault()
  post({ type: 'openSettings' })
})
content.addEventListener('dblclick', () => post({ type: 'dblclick' }))

// Bilingual pair highlight (req 10.7). Delegated on the stable #content element so
// it survives pane re-renders; a no-op outside bilingual view. Uses the shared
// data-paragraph-index to pair a block with its translation in the other pane.
content.addEventListener('mouseover', (e) => {
  if (!bilingual) return
  const block = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-paragraph-index]')
  highlightPair(block?.dataset.paragraphIndex)
})
content.addEventListener('mouseleave', () => {
  if (bilingual) highlightPair(undefined)
})

function debounce(fn: () => void, ms: number): () => void {
  let h: number | undefined
  return () => {
    window.clearTimeout(h)
    h = window.setTimeout(fn, ms)
  }
}

modalStorage.addEventListener(
  'input',
  debounce(() => post({ type: 'modalSyncRequest', field: 'storage', text: modalStorage.value }), MODAL_MS),
)
modalTarget.addEventListener(
  'input',
  debounce(() => post({ type: 'modalSyncRequest', field: 'target', text: modalTarget.value }), MODAL_MS),
)
/** The ONE way the edit modal closes without saving — the ✕/Cancel button and Esc must
 *  stay identical, including telling the host the edit was abandoned. */
function closeEditModal(): void {
  modal.hidden = true
  post({ type: 'cancelParagraphEdit' })
}

modalCancel.addEventListener('click', closeEditModal)
modalSave.addEventListener('click', () => {
  modal.hidden = true
  post({
    type: 'saveParagraph',
    paragraphIndex: editIndex,
    storageText: modalStorage.value,
    targetText: modalTarget.value,
  })
})

// --- comments (req 11) -------------------------------------------------------

/** Ask the host for a block's thread; `mode` routes the reply (hover vs modal). */
function requestThread(index: number, mode: 'popover' | 'modal'): void {
  threadMode = mode
  threadReqIndex = index
  post({ type: 'requestCommentThread', paragraphIndex: index })
}

function openCommentModal(index: number, fragment?: FragmentAnchor): void {
  openThreadIndex = index
  modalFragment = fragment // undefined when opening an existing thread from the gutter marker
  commentInput.value = ''
  commentList.replaceChildren()
  commentModal.hidden = false
  requestThread(index, 'modal')
}

/** Re-pull the open modal's thread after a mutation so the list reflects it. */
function refreshOpenThread(): void {
  if (openThreadIndex >= 0) requestThread(openThreadIndex, 'modal')
}

function renderCommentList(comments: Array<{ id: string; body: string; updatedAt: string }>): void {
  commentList.replaceChildren()
  for (const c of comments) {
    const item = document.createElement('div')
    item.className = 'cmt-item'
    const body = textNode('div', c.body)
    body.className = 'cmt-body'
    const meta = textNode('div', c.updatedAt)
    meta.className = 'meta'
    const row = document.createElement('div')
    row.className = 'row'
    const edit = document.createElement('button')
    edit.textContent = 'Edit'
    edit.addEventListener('click', () => startEditComment(item, c))
    const del = document.createElement('button')
    del.textContent = 'Delete'
    del.addEventListener('click', () => {
      post({ type: 'deleteComment', commentId: c.id })
      refreshOpenThread()
    })
    row.append(edit, del)
    item.append(body, meta, row)
    commentList.appendChild(item)
  }
}

function startEditComment(item: HTMLElement, c: { id: string; body: string }): void {
  const ta = document.createElement('textarea')
  ta.value = c.body
  const save = document.createElement('button')
  save.textContent = 'Save'
  save.addEventListener('click', () => {
    post({ type: 'editComment', commentId: c.id, body: ta.value })
    refreshOpenThread()
  })
  const cancel = document.createElement('button')
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', refreshOpenThread)
  const row = document.createElement('div')
  row.className = 'row'
  row.append(cancel, save)
  item.replaceChildren(ta, row)
}

commentAdd.addEventListener('click', () => {
  const body = commentInput.value.trim()
  if (!body || openThreadIndex < 0) return
  post({ type: 'addComment', paragraphIndex: openThreadIndex, body, fragment: modalFragment })
  commentInput.value = ''
  refreshOpenThread()
})
/** The ONE way the comment modal closes. Resetting `openThreadIndex` is not cosmetic:
 *  `refreshOpenThread` keys off it, and a stale index keeps re-requesting the thread of a
 *  modal that is no longer on screen. */
function closeCommentModal(): void {
  commentModal.hidden = true
  openThreadIndex = -1
}

commentClose.addEventListener('click', closeCommentModal)

// --- exclude selection from translation (req 3.19) ---------------------------

// Add "Exclude from translation" to the NATIVE right-click menu of the preview (a
// custom-editor webview, where the editor/context menu does not apply). VS Code
// reads `data-vscode-context` at right-click time and forwards it to the command:
// `kiroMdHasSelection` gates the item's `when` clause; `kiroMdSelection` is the
// text the command excludes. No host round-trip is needed — the same context that
// shows the item also carries the selection to the command.
let lastSelectionText = ''
function updateSelectionContext(): void {
  const active = document.activeElement
  // Leave form fields to their native editing menu (Cut/Copy/Paste).
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return
  // Only offer exclusion while the SOURCE (storage language) is shown — the
  // Glossary is a storage-language list, so a translated selection must not be added.
  const text = displaying === 'source' ? (window.getSelection()?.toString() ?? '').trim() : ''
  if (text === lastSelectionText) return // skip redundant writes on caret-only changes
  lastSelectionText = text
  document.body.dataset.vscodeContext = JSON.stringify({
    kiroMdHasSelection: text.length > 0,
    kiroMdSelection: text,
  })
}
document.addEventListener('selectionchange', updateSelectionContext)
updateSelectionContext() // seed an initial (empty) context

// --- cursor toolbar (affordance redesign, stage 2) ---------------------------
// Edit and new-comment appear by the selection instead of in the gutter. `edit`
// targets the whole home block the selection fell into; `comment` (stage 3) will
// bind to the trimmed selection — until then it opens the block's comment modal.
/** The indexed block a non-empty selection sits inside, or undefined. */
function homeBlockOfSelection(): HTMLElement | undefined {
  const active = document.activeElement
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return undefined
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return undefined
  if ((sel.toString() ?? '').trim().length === 0) return undefined
  const node = sel.getRangeAt(0).commonAncestorContainer
  const start = node.nodeType === 1 ? (node as Element) : node.parentElement
  const el = start?.closest<HTMLElement>('[data-paragraph-index]')
  return el && content.contains(el) ? el : undefined
}

function hideSelToolbar(): void {
  selToolbar.hidden = true
}

function positionSelToolbar(): void {
  const el = homeBlockOfSelection()
  if (!el) return hideSelToolbar()
  const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return hideSelToolbar()
  selToolbar.dataset.blockIndex = el.dataset.paragraphIndex ?? ''
  // Centred just above the selection; clamp to the viewport top so it never clips off-screen.
  selToolbar.style.left = `${rect.left + rect.width / 2}px`
  selToolbar.style.top = `${Math.max(rect.top - 4, 30)}px`
  selToolbar.hidden = false
}

document.addEventListener('selectionchange', positionSelToolbar)
// A pointer press inside the toolbar must not collapse the text selection before the click.
selToolbar.addEventListener('mousedown', (e) => e.preventDefault())
selEdit.addEventListener('click', () => {
  const idx = Number(selToolbar.dataset.blockIndex)
  hideSelToolbar()
  if (Number.isFinite(idx)) post({ type: 'editParagraph', paragraphIndex: idx })
})
selComment.addEventListener('click', () => {
  const idx = Number(selToolbar.dataset.blockIndex)
  // Form the fragment BEFORE hiding the toolbar (the selection is still live here —
  // the toolbar's mousedown preventDefault kept it from collapsing).
  const el = homeBlockOfSelection()
  const fragment = el ? fragmentFromSelection(el) : undefined
  hideSelToolbar()
  if (Number.isFinite(idx)) openCommentModal(idx, fragment)
})

/** Build a fragment anchor from the current selection within `blockEl`: the trimmed
 *  selected text plus the block text immediately around it (to disambiguate a repeat).
 *  Undefined when the selection trims to nothing (only whitespace/punctuation). */
function fragmentFromSelection(blockEl: HTMLElement): FragmentAnchor | undefined {
  const trimmed: Fragment | undefined = trimFragment(window.getSelection()?.toString() ?? '')
  if (!trimmed) return undefined
  const blockText = blockEl.textContent ?? ''
  const at = blockText.indexOf(trimmed.text)
  if (at < 0) return { quote: trimmed.text, prefix: '', suffix: '' }
  return {
    quote: trimmed.text,
    prefix: blockText.slice(Math.max(0, at - 24), at),
    suffix: blockText.slice(at + trimmed.text.length, at + trimmed.text.length + 24),
  }
}
// A scroll moves the selection out from under a fixed-position toolbar — hide it.
content.addEventListener('scroll', hideSelToolbar)
window.addEventListener('scroll', hideSelToolbar, true)

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as { type: string; [k: string]: unknown }
  switch (msg.type) {
    case 'renderContent': {
      sourceHtml = msg.html as string // always refresh the cached source for the toggle
      if (bilingual) {
        renderBilingualPanes() // refresh left (source); right keeps the last translation
        break
      }
      if (msg.display === false) break // keep the current translation on screen (req 2.6/3.11)
      translatedHtml = undefined
      displaying = 'source'
      showContent(sourceHtml)
      updateButtonLabel()
      break
    }
    case 'translationComplete': {
      translatedHtml = msg.translatedHtml as string
      if (pendingBilingual) {
        enterBilingual() // the user asked for bilingual before a translation existed
        break
      }
      if (bilingual) {
        renderBilingualPanes() // refresh the right (translation) pane
        break
      }
      displaying = 'translation'
      showContent(translatedHtml)
      updateButtonLabel()
      break
    }
    case 'translationStart':
      content.setAttribute('aria-busy', 'true')
      statusEl.textContent = '⏳'
      break
    case 'translationError':
      statusEl.textContent = `Error ${msg.code}: ${msg.message}`
      content.setAttribute('aria-busy', 'false')
      pendingBilingual = false // a failed request must not capture a later unrelated translation
      break
    case 'tooltipLoading': {
      // Only render if the pointer is STILL over the block this reply is for
      // (the user may have moved to another paragraph while it was in flight).
      if (hoveredEl && Number(hoveredEl.dataset.paragraphIndex) === Number(msg.paragraphIndex)) {
        const spinner = document.createElement('span')
        spinner.className = 'spinner'
        openTooltip(hoveredEl, spinner)
      }
      break
    }
    case 'showTooltip': {
      if (hoveredEl && Number(hoveredEl.dataset.paragraphIndex) === Number(msg.paragraphIndex)) {
        // The peek is host-rendered, host-sanitized HTML — a true mini preview, so a
        // code block keeps its <pre> (newlines, no ``` markers) instead of flat text.
        const box = document.createElement('div')
        setSanitizedHtml(box, String(msg.html))
        openTooltip(hoveredEl, box)
      }
      break
    }
    case 'tooltipError':
      if (hoveredEl && Number(hoveredEl.dataset.paragraphIndex) === Number(msg.paragraphIndex)) {
        openTooltip(hoveredEl, textNode('div', String(msg.message)))
      }
      break
    case 'hideTooltip':
      hideTooltipNow()
      break
    case 'editorScrollSync': {
      const el = blocks().find((b) => Number(b.dataset.paragraphIndex) === msg.paragraphIndex)
      if (el) {
        suppressScroll = true
        el.scrollIntoView({ block: 'start' })
      }
      break
    }
    case 'updateButtonState': {
      // Required settings missing → replace the toolbar buttons with a settings link
      // (req 3.20). The buttons stay in the DOM (Property 6) but are hidden.
      // Comments toggle (req 11.13): a class on #content drives CSS that hides the
      // per-block comment icon; toggling it live reflects a settings change at once.
      content.classList.toggle('comments-off', msg.commentsEnabled === false)
      selComment.hidden = msg.commentsEnabled === false // no new-comment action when disabled
      const hint = msg.settingsHint as string | undefined
      settingsLink.hidden = !hint
      if (hint) settingsLink.textContent = hint
      translateBtn.hidden = Boolean(hint)
      bilingualBtn.hidden = Boolean(hint)
      const auto = msg.mode === 'automatic'
      autoBadge.hidden = !!hint || !auto
      translateBtn.disabled = auto || !msg.translateEnabled
      const newTarget = String(msg.targetLang ?? '')
      if (newTarget !== targetCode) translatedHtml = undefined // target changed → stale
      storageCode = String(msg.storageLang ?? '')
      targetCode = newTarget
      updateButtonLabel()
      // A target change dropped the cached translation → bilingual can't pair anymore.
      if (bilingual && translatedHtml === undefined) exitBilingual()
      updateBilingualBtn()
      break
    }
    case 'hostToggleTranslate': // native editor-title icon (variant A) → same as the button
      doTranslateToggle()
      break
    case 'hostToggleBilingual':
      doBilingualToggle()
      break
    case 'memoryWarning':
      statusEl.textContent =
        msg.level === 'large-file'
          ? 'File exceeds the recommended size. The preview may be slower'
          : 'High memory usage'
      break
    case 'commentsForBlocks': {
      const list =
        (msg.blocks as Array<{ paragraphIndex: number; count: number; fragments?: string[] }>) ?? []
      commentCounts = new Map(list.map((b) => [Number(b.paragraphIndex), Number(b.count)]))
      blockFragments = new Map(
        list.filter((b) => b.fragments?.length).map((b) => [Number(b.paragraphIndex), b.fragments!]),
      )
      updateBlockCommentCounts()
      highlightFragments()
      break
    }
    case 'commentThread': {
      const idx = Number(msg.paragraphIndex)
      const comments = (msg.comments as Array<{ id: string; body: string; updatedAt: string }>) ?? []
      const threads =
        (msg.threads as Array<{
          fragment?: string
          comments: Array<{ id: string; body: string; updatedAt: string }>
        }>) ?? []
      if (threadMode === 'modal' && openThreadIndex === idx && !commentModal.hidden) {
        // Show only the SELECTED thread — the picked fragment, or the whole-block thread.
        // A brand-new fragment (no thread yet) shows an empty list; addComment creates it.
        const thread = modalFragment
          ? threads.find((t) => t.fragment === modalFragment!.quote)
          : threads.find((t) => !t.fragment)
        renderCommentList(thread?.comments ?? (modalFragment ? [] : comments))
      } else if (threadMode === 'popover' && threadReqIndex === idx && threads.length) {
        // Group popover (stage 4): one row per fragment. Anchor to the exact hovered
        // block so in bilingual it opens over the hovered pane, not the source cell.
        const el =
          threadAnchorEl && Number(threadAnchorEl.dataset.paragraphIndex) === idx
            ? threadAnchorEl
            : blocks().find((b) => Number(b.dataset.paragraphIndex) === idx)
        if (el) {
          const box = document.createElement('div')
          box.className = 'cmt-popover'
          for (const t of threads) {
            const row = document.createElement('div')
            row.className = 'cmt-prow'
            const preview = t.fragment ? `“${t.fragment.slice(0, 40)}”` : 'Whole block'
            row.appendChild(textNode('span', preview))
            const n = textNode('span', ` · ${t.comments.length}`)
            n.className = 'cmt-prow-n'
            row.appendChild(n)
            // Hovering a row highlights exactly that fragment; clicking opens its thread.
            row.addEventListener('mouseenter', () => highlightActiveFragment(idx, t.fragment))
            row.addEventListener('mouseleave', () => highlightActiveFragment(idx, undefined))
            row.addEventListener('click', () => {
              highlightActiveFragment(idx, undefined)
              hideTooltipNow()
              openCommentModal(idx, t.fragment ? { quote: t.fragment, prefix: '', suffix: '' } : undefined)
            })
            box.appendChild(row)
          }
          openTooltip(el, box)
        }
      }
      break
    }
    case 'orphanedComments': {
      const threads = (msg.threads as Array<{ quote: string; comments: Array<{ body: string }> }>) ?? []
      if (!threads.length) {
        orphanedEl.hidden = true
        orphanedEl.replaceChildren()
        break
      }
      orphanedEl.replaceChildren(textNode('strong', `Outdated comments (${threads.length})`))
      for (const t of threads) {
        const div = document.createElement('div')
        div.className = 'oc'
        const q = textNode('span', `“${String(t.quote).slice(0, 80)}” `)
        q.className = 'quote'
        div.appendChild(q)
        for (const c of t.comments) div.appendChild(textNode('span', `${c.body}  `))
        orphanedEl.appendChild(div)
      }
      orphanedEl.hidden = false
      break
    }
    case 'openEditModal':
      editIndex = msg.paragraphIndex as number
      modalStorage.value = String(msg.storageText)
      modalTarget.value = String(msg.targetText)
      modalError.textContent = ''
      modal.hidden = false
      break
    case 'editModalSyncStart':
      (msg.field === 'storage' ? modalStorage : modalTarget).disabled = true
      break
    case 'editModalSyncComplete': {
      const field = msg.field === 'storage' ? modalStorage : modalTarget
      field.value = String(msg.text)
      field.disabled = false
      break
    }
    case 'editModalSyncError': {
      const field = msg.field === 'storage' ? modalStorage : modalTarget
      field.disabled = false
      modalError.textContent = String(msg.message)
      break
    }
  }
})

// --- in-document search (req 1.8) --------------------------------------------
// The native find widget (enableFindWidget) drives Electron's findInPage, inert in
// Code OSS builds (Kiro). window.find works there but couples highlight + caret +
// focus into one stateful selection, which fights the input while typing. Instead we
// split the concern in two INDEPENDENT processes over the CSS Custom Highlight API
// (paint-only — never touches DOM, focus, or selection):
//   • HIGHLIGHT (on input): walk text nodes, collect a Range per match, paint them
//     all via ::highlight(find-matches). Input keeps focus, typing is uninterrupted.
//   • NAVIGATE (Enter / Shift+Enter / buttons): step a cursor over the Range list,
//     scroll the current match into view, paint it stronger via ::highlight(find-current).
// The Highlight API + Highlight ctor are recent (Chromium 105+) and absent from the
// TS lib, so they are feature-detected and typed locally here.
interface HighlightLike { priority: number }
const cssHighlights = (
  CSS as unknown as { highlights?: { set(n: string, h: HighlightLike): void; delete(n: string): void } }
).highlights
const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => HighlightLike }).Highlight
const HL_OK = !!cssHighlights && !!HighlightCtor

/** First Range of `needle` within `root`'s text, or undefined. Skips the gutter control
 *  text. Matches within a single text node (a fragment spanning inline markup is rare and
 *  simply not painted — never mis-painted). */
function findTextRange(root: HTMLElement, needle: string): Range | undefined {
  if (!needle) return undefined
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('.bctl')) continue
    const i = (node.nodeValue ?? '').indexOf(needle)
    if (i >= 0) {
      const r = document.createRange()
      r.setStart(node, i)
      r.setEnd(node, i + needle.length)
      return r
    }
  }
  return undefined
}

/** Paint a highlight over every commented fragment (stage 3). Paint-only via the CSS
 *  Custom Highlight API — no DOM mutation, so the block-index / lineMap contract is
 *  untouched and overlapping fragments are handled natively. Recomputed after every
 *  content re-render (the DOM, hence the ranges, is rebuilt). */
function highlightFragments(): void {
  if (!HL_OK) return
  cssHighlights!.delete('comment-fragments')
  const ranges: Range[] = []
  for (const el of blocks()) {
    const quotes = blockFragments.get(Number(el.dataset.paragraphIndex))
    if (!quotes) continue
    for (const q of quotes) {
      const r = findTextRange(el, q)
      if (r) ranges.push(r)
    }
  }
  if (ranges.length) cssHighlights!.set('comment-fragments', new HighlightCtor!(...ranges))
}

/** Paint the ONE fragment a popover row points at, stronger than the resting highlight
 *  (stage 4). `quote` undefined clears it. */
function highlightActiveFragment(idx: number, quote: string | undefined): void {
  if (!HL_OK) return
  cssHighlights!.delete('comment-fragment-active')
  if (!quote) return
  const el = blocks().find((b) => Number(b.dataset.paragraphIndex) === idx)
  const r = el && findTextRange(el, quote)
  if (r) {
    const h = new HighlightCtor!(r)
    h.priority = 2 // wins over the resting comment-fragments highlight
    cssHighlights!.set('comment-fragment-active', h)
  }
}

const findBar = document.getElementById('find-bar') as HTMLElement
const findInput = document.getElementById('find-input') as HTMLInputElement
const findStatus = document.getElementById('find-status') as HTMLElement
const findPrev = document.getElementById('find-prev') as HTMLButtonElement
const findNext = document.getElementById('find-next') as HTMLButtonElement
const findClose = document.getElementById('find-close') as HTMLButtonElement

let findRanges: Range[] = []
let findCursor = -1 // -1 = nothing selected yet; first Navigate lands on the first match

function clearHighlights(): void {
  cssHighlights?.delete('find-matches')
  cssHighlights?.delete('find-current')
  findRanges = []
  findCursor = -1
}

function paintCurrent(): void {
  if (!HL_OK) return
  const r = findRanges[findCursor]
  if (r) {
    const h = new HighlightCtor!(r)
    h.priority = 1 // wins over find-matches where they overlap
    cssHighlights!.set('find-current', h)
  } else {
    cssHighlights!.delete('find-current')
  }
}

function updateFindStatus(): void {
  const n = findRanges.length
  findStatus.textContent = !findInput.value ? '' : n === 0 ? 'No results'
    : findCursor < 0 ? `${n} found` : `${findCursor + 1}/${n}`
}

// HIGHLIGHT process: recompute + paint all matches for the current query. Pure paint,
// no scroll, no focus change — so it is safe to run on every keystroke and on re-render.
function highlightMatches(): void {
  clearHighlights()
  const query = findInput.value
  if (query) {
    const needle = query.toLowerCase()
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const hay = (node.nodeValue ?? '').toLowerCase()
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
        const r = document.createRange()
        r.setStart(node, i)
        r.setEnd(node, i + needle.length)
        findRanges.push(r)
      }
    }
    if (HL_OK && findRanges.length) cssHighlights!.set('find-matches', new HighlightCtor!(...findRanges))
  }
  updateFindStatus()
}

function scrollRangeIntoView(r: Range): void {
  const rect = r.getBoundingClientRect()
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    window.scrollBy({ top: rect.top - window.innerHeight / 2, behavior: 'smooth' })
  }
}

// NAVIGATE process: move the cursor to the next/previous match and reveal it. Never
// touches focus, so the input stays active and Enter keeps stepping.
function gotoMatch(delta: number): void {
  if (findRanges.length === 0) return
  findCursor = findCursor < 0
    ? (delta < 0 ? findRanges.length - 1 : 0)
    : (findCursor + delta + findRanges.length) % findRanges.length
  paintCurrent()
  updateFindStatus()
  scrollRangeIntoView(findRanges[findCursor])
}

function openFindBar(): void {
  findBar.hidden = false
  findInput.focus()
  findInput.select()
  highlightMatches() // repaint against the current content (e.g. reopened after a re-render)
}

function closeFindBar(): void {
  findBar.hidden = true
  clearHighlights()
  findStatus.textContent = ''
  content.focus()
}

// Re-run the highlight after the content DOM is swapped (translate / bilingual / edit)
// so matches track the freshly rendered text. No-op while the bar is closed.
function refreshFind(): void {
  if (!findBar.hidden) highlightMatches()
}

findInput.addEventListener('input', highlightMatches)
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    gotoMatch(e.shiftKey ? -1 : 1)
  }
})
findPrev.addEventListener('click', () => gotoMatch(-1))
findNext.addEventListener('click', () => gotoMatch(1))
findClose.addEventListener('click', closeFindBar)

document.addEventListener('keydown', (e) => {
  // e.code is the physical key (layout-independent): e.key would be the character the
  // current layout produces, so on a non-Latin layout (e.g. Cyrillic) Ctrl+F yields
  // e.key='а' and the shortcut would silently never fire.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyF') {
    e.preventDefault()
    openFindBar()
  }
})
/**
 * Dismiss the topmost open layer; false when there is nothing to dismiss (so Esc keeps its
 * default meaning elsewhere). The ORDER is the whole point: the dialogs sit on top of the
 * find bar, so Esc with both open must close the dialog, not the bar underneath it. This
 * is also why there is a single handler rather than one per surface — two listeners would
 * both fire and close two layers at once.
 */
function dismissTopLayer(): boolean {
  if (!commentModal.hidden) {
    // An in-progress comment edit is a layer of its own: Esc cancels the edit and returns
    // to the list. Closing the whole modal here would silently throw away what was typed.
    if (commentList.querySelector('textarea')) {
      refreshOpenThread()
      return true
    }
    closeCommentModal()
    return true
  }
  if (!modal.hidden) {
    closeEditModal()
    return true
  }
  if (!findBar.hidden) {
    closeFindBar()
    return true
  }
  if (!selToolbar.hidden) {
    hideSelToolbar()
    return true
  }
  return false
}

// Handled in the CAPTURE phase on the document so it wins over the webview's default
// focus-move (which otherwise just shifts focus to the next control instead of closing)
// and works regardless of which control — textarea, button, input — currently has focus.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!dismissTopLayer()) return
  e.preventDefault()
  e.stopPropagation()
}, true)

post({ type: 'ready' })

export {} // module scope (isolates top-level consts from other webview scripts)
