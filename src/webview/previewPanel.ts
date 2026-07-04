/* Preview_Panel webview client (browser sandbox). Vanilla TS, no frameworks. */
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
const statusEl = document.getElementById('status') as HTMLElement
const modal = document.getElementById('modal') as HTMLElement
const modalStorage = document.getElementById('modal-storage') as HTMLTextAreaElement
const modalTarget = document.getElementById('modal-target') as HTMLTextAreaElement
const modalError = document.getElementById('modal-error') as HTMLElement
const modalCancel = document.getElementById('modal-cancel') as HTMLButtonElement
const modalSave = document.getElementById('modal-save') as HTMLButtonElement

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

function langBadge(code: string): string {
  return code ? code.split('-')[0].toUpperCase() : ''
}

function updateButtonLabel(): void {
  const label =
    displaying === 'translation'
      ? `Original${storageCode ? ` (${langBadge(storageCode)})` : ''}`
      : `Translate${targetCode ? ` (${langBadge(targetCode)})` : ''}`
  translateBtn.textContent = label
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
}

// --- bilingual (two-column) view (req 10) ------------------------------------

/** Rebuild both panes (left = source, right = translation) from the cached HTML.
 *  Deliberately binds NO hover — both languages are already visible (req 10.5). */
function renderBilingualPanes(): void {
  hideTooltipNow()
  const left = document.createElement('div')
  left.className = 'pane'
  left.appendChild(document.createRange().createContextualFragment(sourceHtml ?? ''))
  const right = document.createElement('div')
  right.className = 'pane'
  right.appendChild(document.createRange().createContextualFragment(translatedHtml ?? ''))
  content.replaceChildren(left, right)
  content.setAttribute('aria-busy', 'false')
  statusEl.textContent = ''
  bindPaneScrollSync(left, right)
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
  bilingualBtn.textContent = bilingual ? 'Single view' : 'Bilingual'
}

/** Paragraph-aligned scroll sync between the two panes (req 10.4): scrolling one
 *  aligns the other on the same data-paragraph-index; a lock suppresses the echo. */
function bindPaneScrollSync(a: HTMLElement, b: HTMLElement): void {
  let lock = false
  const topIndex = (pane: HTMLElement): string | undefined => {
    const top = pane.getBoundingClientRect().top
    const el = Array.from(pane.querySelectorAll<HTMLElement>('[data-paragraph-index]')).find(
      (e) => e.getBoundingClientRect().bottom > top + 4,
    )
    return el?.dataset.paragraphIndex
  }
  const sync = (from: HTMLElement, to: HTMLElement) => (): void => {
    if (lock) return
    const idx = topIndex(from)
    if (idx === undefined) return
    const target = to.querySelector<HTMLElement>(`[data-paragraph-index="${idx}"]`)
    if (target) {
      lock = true // the responding pane must not echo a scroll back
      target.scrollIntoView({ block: 'start' })
      // Release on the next frame regardless of whether scrollIntoView actually
      // moved the pane (a no-op scroll fires no echo event that would clear it).
      requestAnimationFrame(() => {
        lock = false
      })
    }
  }
  a.addEventListener('scroll', sync(a, b))
  b.addEventListener('scroll', sync(b, a))
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
    el.addEventListener('mouseover', () => {
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
  if (bilingual) return // bilingual panes scroll internally; sync handled per-pane
  if (suppressScroll) {
    suppressScroll = false
    return
  }
  const top = blocks().find((el) => el.getBoundingClientRect().bottom > 48)
  if (top) post({ type: 'scrollChanged', topParagraphIndex: Number(top.dataset.paragraphIndex) })
})

// The button toggles Translate <-> Original. Both directions reuse cached HTML
// (no API) once a translation exists; the first translation asks the host.
translateBtn.addEventListener('click', () => {
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
})
// Bilingual toggle: enter needs a translation — request one first if absent.
bilingualBtn.addEventListener('click', () => {
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
})
content.addEventListener('dblclick', () => post({ type: 'dblclick' }))

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
modalCancel.addEventListener('click', () => {
  modal.hidden = true
  post({ type: 'cancelParagraphEdit' })
})
modalSave.addEventListener('click', () => {
  modal.hidden = true
  post({
    type: 'saveParagraph',
    paragraphIndex: editIndex,
    storageText: modalStorage.value,
    targetText: modalTarget.value,
  })
})

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
        const edit = document.createElement('button')
        edit.textContent = 'Edit'
        edit.addEventListener('click', () => {
          hideTooltipNow()
          post({ type: 'editParagraph', paragraphIndex: msg.paragraphIndex })
        })
        openTooltip(hoveredEl, textNode('div', String(msg.reverseTranslation)), edit)
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
      const auto = msg.mode === 'automatic'
      autoBadge.hidden = !auto
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
    case 'memoryWarning':
      statusEl.textContent =
        msg.level === 'large-file'
          ? 'File exceeds the recommended size. The preview may be slower'
          : 'High memory usage'
      break
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

post({ type: 'ready' })

export {} // module scope (isolates top-level consts from other webview scripts)
