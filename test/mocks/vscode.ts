/**
 * Hand-written stub of the `vscode` extension API for Node/vitest.
 * Only the surface the plugin actually uses is implemented. Methods are plain
 * functions so tests can `sinon.stub` them; a few helpers (EventEmitter,
 * CancellationTokenSource, MemSecretStorage, config store) are real so tests
 * get useful behaviour out of the box.
 *
 * The second half of this file exists for INTEGRATION tests — the ones that wire
 * several real modules together instead of stubbing the collaborators. Those need a
 * host that actually *does* something: a filesystem that remembers, events that
 * really fire, a document that can be edited. Everything here is additive; the
 * seams above kept their behaviour so the unit suite is untouched.
 *
 * Test seams (all prefixed `__`, all safe to call from any test):
 *
 *   Config    __setConfig(section, key|object[, value]) / __clearConfig()
 *   Host      __setAppName(name) / __setLmModels(models)
 *   Files     __setFile(uri|path, string|bytes) / __getFile(uri|path) /
 *             __listFiles() / __resetFs()
 *   Events    __fireConfigChange(section?) / __fireDocChange(event) /
 *             __fireVisibleRanges(event) / __fireRenameFiles(files)
 *   Workspace __setWorkspaceFolders(folders|undefined)
 *   Editing   __addTextDocument(doc) / __resetDocuments() /
 *             __setApplyEditResult(true|false|undefined)
 *   Window    __setActiveTextEditor(editor) / __registeredCustomEditors() /
 *             __progressReports() / __cancelProgress()
 *   Wholesale __resetHost()  — files + documents + folders + window state.
 *             Config, secrets and lm models keep their own seams on purpose:
 *             a test that seeded them rarely wants them wiped mid-flight.
 *
 * Three VS Code behaviours are reproduced DELIBERATELY, because production code
 * reasons about them and a friendlier mock would let a wrong fix look right:
 *
 *   1. `workspace.applyEdit` RESOLVES FALSE (it never throws) when the document
 *      version moved after the edit was recorded. Bump a version with
 *      `doc.__setText(...)` between `edit.replace(...)` and `applyEdit(...)` to
 *      reproduce it, or force the answer with `__setApplyEditResult(false)`.
 *   2. `TextDocument.save()` RESOLVES FALSE when the document was merely NOT
 *      DIRTY — "nothing to save" is indistinguishable from "save failed" through
 *      the return value alone. That is why the comment layer probes `isDirty` as
 *      well; a past data-loss bug lived exactly there.
 *   3. `workspace.fs.readFile` REJECTS with a `FileSystemError` carrying
 *      `code === 'FileNotFound'` for a missing entry — the sidecar and draft
 *      comment backends branch on the rejection, not on a falsy return.
 *
 * Known, deliberate divergences from the real API: `Uri.joinPath` does not
 * normalize (the filesystem below normalizes `.`/`..` when it derives its map key,
 * so a joined uri still finds its file, but a Uri STRING is a poor assertion
 * target — compare with `.endsWith(...)`); `WorkspaceConfiguration.update` ignores
 * its ConfigurationTarget; `inspect()` reports every seeded value as `globalValue`;
 * documents assume LF line endings.
 */

export class Disposable {
  constructor(private readonly fn: () => void) {}
  dispose(): void {
    this.fn()
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = []
  event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener)
    return new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    })
  }
  fire(data: T): void {
    for (const l of [...this.listeners]) l(data)
  }
  dispose(): void {
    this.listeners = []
  }
}

export class CancellationTokenSource {
  private emitter = new EventEmitter<void>()
  token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  }
  cancel(): void {
    this.token.isCancellationRequested = true
    this.emitter.fire()
  }
  dispose(): void {
    this.emitter.dispose()
  }
}

export const ViewColumn = { One: 1, Two: 2, Beside: -2 } as const
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const
export const EndOfLine = { LF: 1, CRLF: 2 } as const

export class Position {
  constructor(public line: number, public character: number) {}
  compareTo(other: Position): number {
    return this.line - other.line || this.character - other.character
  }
  isEqual(other: Position): boolean {
    return this.compareTo(other) === 0
  }
  isBefore(other: Position): boolean {
    return this.compareTo(other) < 0
  }
  isAfter(other: Position): boolean {
    return this.compareTo(other) > 0
  }
}

/**
 * Both real overloads: `(start, end)` and the 4-number `(sLine, sChar, eLine, eChar)`.
 * The 4-number form is the one production uses for a whole-document replace
 * (`new Range(0, 0, document.lineCount, 0)`), so a Position-only mock silently turned
 * every such edit into an empty range. Ends are ordered like the real class.
 */
export class Range {
  readonly start: Position
  readonly end: Position
  constructor(start: Position, end: Position)
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number)
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const start = typeof a === 'number' ? new Position(a, b as number) : a
    const end = typeof a === 'number' ? new Position(c as number, d as number) : (b as Position)
    const flipped = start.compareTo(end) > 0
    this.start = flipped ? end : start
    this.end = flipped ? start : end
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end)
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line
  }
}

/** The shape every `Uri` in this mock has; enough for keys, joins and assertions. */
export interface UriLike {
  scheme: string
  fsPath: string
  path: string
  toString(): string
}

export const Uri = {
  file: (p: string): UriLike => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` }),
  parse: (s: string): UriLike => ({ scheme: 'file', fsPath: s, path: s, toString: () => s }),
  joinPath: (base: any, ...parts: string[]): UriLike => ({
    scheme: base.scheme ?? 'file',
    fsPath: [base.fsPath, ...parts].join('/'),
    path: [base.path, ...parts].join('/'),
    toString: () => [base.toString(), ...parts].join('/'),
  }),
}

/** vscode.FileSystemError — carries a `code` the callers branch on. */
export class FileSystemError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = `${code} (FileSystemError)`
  }
  static FileNotFound(uri?: UriLike | string): FileSystemError {
    return new FileSystemError(`Unable to resolve nonexistent file '${uri ?? ''}'`, 'FileNotFound')
  }
  static FileExists(uri?: UriLike | string): FileSystemError {
    return new FileSystemError(`File already exists '${uri ?? ''}'`, 'FileExists')
  }
  static FileNotADirectory(uri?: UriLike | string): FileSystemError {
    return new FileSystemError(`File is not a directory '${uri ?? ''}'`, 'FileNotADirectory')
  }
  static FileIsADirectory(uri?: UriLike | string): FileSystemError {
    return new FileSystemError(`File is a directory '${uri ?? ''}'`, 'FileIsADirectory')
  }
  static NoPermissions(uri?: UriLike | string): FileSystemError {
    return new FileSystemError(`No permissions '${uri ?? ''}'`, 'NoPermissions')
  }
}

interface FileEntry {
  data: Uint8Array
  ctime: number
  mtime: number
}

const files = new Map<string, FileEntry>()
const directories = new Set<string>()
let fsClock = 0

/**
 * Map key for a uri. `.`/`..` are collapsed here rather than in `Uri.joinPath`
 * (which the unit suite already depends on leaving alone), so a sidecar uri built as
 * `<doc>/../<name>.comments.json` still finds the file a test seeded by plain path.
 * A bare path string is read as a `file:` uri, so `__setFile('/docs/a.md', …)` and
 * `__setFile(Uri.file('/docs/a.md'), …)` address the same entry.
 */
function fsKey(target: UriLike | string): string {
  const raw = typeof target === 'string' ? (target.includes('://') ? target : `file://${target}`) : target.toString()
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)?$/i.exec(raw)
  if (!m) return raw
  const segments: string[] = []
  for (const segment of (m[2] ?? '').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `${m[1]}/${segments.join('/')}`
}

/** The containing directory's key, or undefined at the scheme root. */
function parentKey(key: string): string | undefined {
  const i = key.lastIndexOf('/')
  if (i <= 0) return undefined
  const parent = key.slice(0, i)
  if (parent.endsWith('//')) return `${parent}/` === key ? undefined : `${parent}/`
  return parent
}

function registerAncestors(key: string): void {
  for (let dir = parentKey(key); dir; dir = parentKey(dir)) directories.add(dir)
}

/** Prefix every child of a directory key starts with. The scheme root already ends
 *  in `/`, so appending another one would match nothing. */
function childPrefix(key: string): string {
  return key.endsWith('/') ? key : `${key}/`
}

function fsWrite(target: UriLike | string, content: Uint8Array | string): void {
  const key = fsKey(target)
  const data = typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(content)
  const previous = files.get(key)
  files.set(key, { data, ctime: previous?.ctime ?? ++fsClock, mtime: ++fsClock })
  registerAncestors(key)
}

/** Test seam: seed a file. Accepts a Uri or a plain path, text or bytes. */
export function __setFile(target: UriLike | string, content: Uint8Array | string): void {
  fsWrite(target, content)
}

/** Test seam: read a file back as UTF-8 text; undefined when it does not exist. */
export function __getFile(target: UriLike | string): string | undefined {
  const entry = files.get(fsKey(target))
  return entry && new TextDecoder().decode(entry.data)
}

/** Test seam: every file key currently in the filesystem, sorted. */
export function __listFiles(): string[] {
  return [...files.keys()].sort()
}

/** Test seam: empty the filesystem (files and directories both). */
export function __resetFs(): void {
  files.clear()
  directories.clear()
  fsClock = 0
}

/** In-memory SecretStorage (vscode.SecretStorage shape). */
export class MemSecretStorage {
  private data = new Map<string, string>()
  async get(key: string): Promise<string | undefined> {
    return this.data.get(key)
  }
  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }
}

/** In-memory Memento (vscode.Memento shape) — what `ExtensionContext.globalState` is. */
export class MemMemento {
  private data = new Map<string, unknown>()
  keys(): readonly string[] {
    return [...this.data.keys()]
  }
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.data.has(key) ? (this.data.get(key) as T) : defaultValue
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key)
    else this.data.set(key, value)
  }
}

/** Backing store for getConfiguration; tests can seed via __setConfig. */
const configStore = new Map<string, unknown>()
export function __setConfig(section: string, key: string, value: unknown): void
export function __setConfig(section: string, values: Record<string, unknown>): void
export function __setConfig(section: string, keyOrValues: string | Record<string, unknown>, value?: unknown): void {
  if (typeof keyOrValues === 'string') {
    configStore.set(`${section}.${keyOrValues}`, value)
    return
  }
  for (const [key, val] of Object.entries(keyOrValues)) {
    configStore.set(`${section}.${key}`, val)
  }
}
export function __clearConfig(): void {
  configStore.clear()
}

/** A recorded edit, plus the document version at the moment it was recorded. */
interface EditEntry {
  uri: UriLike
  range: Range
  newText: string
  version: number | undefined
}

export class WorkspaceEdit {
  private readonly edits: EditEntry[] = []
  replace(uri: UriLike, range: Range, newText: string): void {
    // Capture the version NOW, like the real class does — that snapshot is what
    // makes a later applyEdit resolve false once the document has moved on.
    this.edits.push({ uri, range, newText, version: findDocument(uri)?.version })
  }
  insert(uri: UriLike, position: Position, newText: string): void {
    this.replace(uri, new Range(position, position), newText)
  }
  delete(uri: UriLike, range: Range): void {
    this.replace(uri, range, '')
  }
  set(uri: UriLike, edits: Array<{ range: Range; newText: string }>): void {
    for (const e of edits) this.replace(uri, e.range, e.newText)
  }
  has(uri: UriLike): boolean {
    return this.edits.some((e) => fsKey(e.uri) === fsKey(uri))
  }
  get(uri: UriLike): Array<{ range: Range; newText: string }> {
    return this.edits.filter((e) => fsKey(e.uri) === fsKey(uri)).map(({ range, newText }) => ({ range, newText }))
  }
  entries(): Array<[UriLike, Array<{ range: Range; newText: string }>]> {
    const byUri = new Map<string, [UriLike, Array<{ range: Range; newText: string }>]>()
    for (const e of this.edits) {
      const key = fsKey(e.uri)
      if (!byUri.has(key)) byUri.set(key, [e.uri, []])
      byUri.get(key)![1].push({ range: e.range, newText: e.newText })
    }
    return [...byUri.values()]
  }
  /** Number of affected resources, as in the real API — not the number of edits. */
  get size(): number {
    return this.entries().length
  }
  /** Internal: what applyEdit consumes, versions included. */
  __edits(): readonly EditEntry[] {
    return this.edits
  }
}

/** Documents the host knows about; `workspace.textDocuments` IS this array. */
const documents: MockTextDocument[] = []

function findDocument(uri: UriLike): MockTextDocument | undefined {
  const key = fsKey(uri)
  return documents.find((d) => fsKey(d.uri) === key)
}

/**
 * A TextDocument the real controllers can drive: text, versioning, dirty state and
 * the line/offset math `Range`-based edits need. `save()` reproduces the
 * not-dirty-resolves-false trap; `__setText` is the "somebody else edited it" seam.
 */
export class MockTextDocument {
  version = 1
  isDirty = false
  isClosed = false
  readonly isUntitled: boolean
  readonly eol = EndOfLine.LF
  private text: string
  private lines: string[]
  private saveFails = false

  constructor(
    readonly uri: UriLike,
    text = '',
    public languageId = 'markdown',
    isUntitled = false,
  ) {
    this.text = text
    this.lines = text.split('\n')
    this.isUntitled = isUntitled
  }

  get fileName(): string {
    return this.uri.fsPath
  }

  get lineCount(): number {
    return this.lines.length
  }

  getText(range?: Range): string {
    if (!range) return this.text
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end))
  }

  lineAt(lineOrPosition: number | Position): {
    lineNumber: number
    text: string
    range: Range
    rangeIncludingLineBreak: Range
    firstNonWhitespaceCharacterIndex: number
    isEmptyOrWhitespace: boolean
  } {
    const n = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line
    const text = this.lines[n]
    if (text === undefined) throw new RangeError(`Illegal value for line: ${n}`)
    const last = n === this.lines.length - 1
    return {
      lineNumber: n,
      text,
      range: new Range(n, 0, n, text.length),
      rangeIncludingLineBreak: last ? new Range(n, 0, n, text.length) : new Range(n, 0, n + 1, 0),
      firstNonWhitespaceCharacterIndex: text.length - text.trimStart().length,
      isEmptyOrWhitespace: text.trim().length === 0,
    }
  }

  /** Clamped like the real one: a position past the end maps to the end of the text. */
  offsetAt(position: Position): number {
    if (position.line < 0) return 0
    if (position.line >= this.lines.length) return this.text.length
    let offset = 0
    for (let i = 0; i < position.line; i++) offset += this.lines[i].length + 1
    return offset + Math.max(0, Math.min(position.character, this.lines[position.line].length))
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length))
    let consumed = 0
    for (let line = 0; line < this.lines.length; line++) {
      const end = consumed + this.lines[line].length
      if (clamped <= end) return new Position(line, clamped - consumed)
      consumed = end + 1
    }
    const last = this.lines.length - 1
    return new Position(last, this.lines[last].length)
  }

  /**
   * FAITHFUL TRAP: the real `save()` resolves FALSE when there was nothing to save
   * (the document is not dirty), not only when the write failed. `ActivationController`
   * leans on the distinction — `(await doc.save()) || !doc.isDirty` — so a mock that
   * always resolved true would make that reasoning untestable.
   */
  async save(): Promise<boolean> {
    if (this.saveFails || !this.isDirty) return false
    this.isDirty = false
    fsWrite(this.uri, this.text)
    return true
  }

  /** Test seam: make `save()` resolve false even when the document IS dirty. */
  __failSave(fail = true): void {
    this.saveFails = fail
  }

  /** Test seam: set the dirty flag without touching the text. */
  __setDirty(dirty: boolean): void {
    this.isDirty = dirty
  }

  /** Test seam: replace the text as another editor would — bumps `version`, marks the
   *  document dirty and fires `onDidChangeTextDocument`. Call it between building a
   *  WorkspaceEdit and applying it to reproduce the stale-edit rejection. */
  __setText(text: string): void {
    this.__commit(text, [
      {
        range: new Range(0, 0, this.lineCount, 0),
        rangeOffset: 0,
        rangeLength: this.text.length,
        text,
      },
    ])
  }

  /** Internal: commit new text and announce it. */
  __commit(text: string, contentChanges: unknown[]): void {
    this.text = text
    this.lines = text.split('\n')
    this.version += 1
    this.isDirty = true
    docChangeEmitter.fire({ document: this, contentChanges, reason: undefined })
  }
}

/** Test seam: register a document with the host (`workspace.textDocuments`). */
export function __addTextDocument(doc: MockTextDocument): MockTextDocument {
  const existing = findDocument(doc.uri)
  if (existing) documents.splice(documents.indexOf(existing), 1)
  documents.push(doc)
  return doc
}

/** Test seam: forget every registered document. */
export function __resetDocuments(): void {
  documents.length = 0
}

/** An unopened file still has to be editable — the host opens a model on demand. */
function resolveDocument(uri: UriLike): MockTextDocument | undefined {
  const open = findDocument(uri)
  if (open) return open
  const entry = files.get(fsKey(uri))
  if (!entry) return undefined
  return __addTextDocument(new MockTextDocument(uri, new TextDecoder().decode(entry.data)))
}

let applyEditResult: boolean | undefined

/** Test seam: force every `workspace.applyEdit` to resolve this value; undefined
 *  restores the modelled behaviour. */
export function __setApplyEditResult(result: boolean | undefined): void {
  applyEditResult = result
}

/**
 * FAITHFUL TRAP: resolves FALSE — never throws — when an edit is stale (the document
 * version moved since `edit.replace()` recorded it) or its resource does not exist.
 * A rejected edit also leaves the document byte-identical, hence CLEAN, which is why
 * the comment layer cannot tell "rejected" from "already saved" without this boolean.
 */
async function applyEdit(edit: WorkspaceEdit): Promise<boolean> {
  if (applyEditResult !== undefined) return applyEditResult
  const entries = edit.__edits()
  if (entries.length === 0) return true

  const batches = new Map<MockTextDocument, EditEntry[]>()
  for (const entry of entries) {
    const doc = resolveDocument(entry.uri)
    if (!doc) return false
    if (entry.version !== undefined && entry.version !== doc.version) return false
    const batch = batches.get(doc)
    if (batch) batch.push(entry)
    else batches.set(doc, [entry])
  }

  for (const [doc, batch] of batches) {
    // Offsets are taken against the pre-edit text, so apply back-to-front — exactly
    // how a real workspace edit keeps its own offsets valid.
    const spans = batch
      .map((e) => ({ start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), text: e.newText }))
      .sort((a, b) => b.start - a.start)
    let text = doc.getText()
    for (const s of spans) text = text.slice(0, s.start) + s.text + text.slice(s.end)
    doc.__commit(
      text,
      spans.map((s) => ({
        range: new Range(doc.positionAt(s.start), doc.positionAt(s.end)),
        rangeOffset: s.start,
        rangeLength: s.end - s.start,
        text: s.text,
      })),
    )
  }
  return true
}

const configChangeEmitter = new EventEmitter<{ affectsConfiguration(section: string): boolean }>()
const docChangeEmitter = new EventEmitter<unknown>()
const visibleRangesEmitter = new EventEmitter<unknown>()
const renameEmitter = new EventEmitter<{ files: ReadonlyArray<{ oldUri: UriLike; newUri: UriLike }> }>()

/**
 * Test seam: fire `workspace.onDidChangeConfiguration`. `affectsConfiguration` really
 * answers — ActivationController and SettingsManager filter on it, so a listener that
 * fired for everything would hide a wrong filter. Pass the changed section (a whole
 * section like `kiro-md-translator`, or a single key like
 * `kiro-md-translator.glossary`); omit it to mean "everything changed".
 */
export function __fireConfigChange(section?: string): void {
  configChangeEmitter.fire({
    affectsConfiguration: (query: string) =>
      section === undefined || query === section || section.startsWith(`${query}.`) || query.startsWith(`${section}.`),
  })
}

/** Test seam: fire `workspace.onDidChangeTextDocument`. Editing a MockTextDocument
 *  (via `__setText` or `applyEdit`) already fires it — this is for hand-built events. */
export function __fireDocChange(event: { document: unknown; contentChanges?: unknown[] }): void {
  docChangeEmitter.fire({ contentChanges: [], ...event })
}

/** Test seam: fire `window.onDidChangeTextEditorVisibleRanges` (drives scroll sync). */
export function __fireVisibleRanges(event: { textEditor: unknown; visibleRanges: unknown[] }): void {
  visibleRangesEmitter.fire(event)
}

/** Test seam: fire `workspace.onDidRenameFiles` (drives draft-comment following). */
export function __fireRenameFiles(renamed: ReadonlyArray<{ oldUri: UriLike; newUri: UriLike }>): void {
  renameEmitter.fire({ files: renamed })
}

/** `**` spans path segments, `*` and `?` stay inside one — enough for the
 *  include/exclude globs `findFiles` is actually called with. */
function globToRegExp(glob: string): RegExp {
  // Two sentinels stand in for the globstars while the single-segment wildcards are
  // rewritten, so a `**` is never re-read as two `*`s.
  const anySegments = String.fromCharCode(1)
  const anyChars = String.fromCharCode(2)
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, anySegments)
    .replace(/\*\*/g, anyChars)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(anySegments)
    .join('(?:.*/)?')
    .split(anyChars)
    .join('.*')
  return new RegExp(`^${body}$`)
}

/** Rebuild a uri object from a filesystem key, so `findFiles` hands back something
 *  whose `path` is a path — `Uri.parse` keeps the whole string, by design. */
function uriFromKey(key: string): UriLike {
  const path = key.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
  return { scheme: key.slice(0, key.indexOf(':')), fsPath: path, path, toString: () => key }
}

export const workspace = {
  getConfiguration: (section: string) => ({
    get<T>(key: string, defaultValue?: T): T | undefined {
      const k = `${section}.${key}`
      return (configStore.has(k) ? (configStore.get(k) as T) : defaultValue)
    },
    update(key: string, value: unknown): Promise<void> {
      configStore.set(`${section}.${key}`, value)
      return Promise.resolve()
    },
    has(key: string): boolean {
      return configStore.has(`${section}.${key}`)
    },
    inspect<T>(key: string): {
      key: string
      defaultValue?: T
      globalValue?: T
      workspaceValue?: T
      workspaceFolderValue?: T
    } {
      const k = `${section}.${key}`
      return {
        key: k,
        defaultValue: undefined,
        globalValue: configStore.has(k) ? (configStore.get(k) as T) : undefined,
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
      }
    },
  }),
  onDidChangeConfiguration: configChangeEmitter.event,
  onDidChangeTextDocument: docChangeEmitter.event,
  onDidRenameFiles: renameEmitter.event,
  workspaceFolders: [] as unknown[] | undefined,
  /** Live view of the registered documents; production searches it before touching disk. */
  textDocuments: documents as unknown[],
  applyEdit,
  openTextDocument: async (target: UriLike | string | { content?: string; language?: string }): Promise<MockTextDocument> => {
    if (typeof target === 'object' && target !== null && !('path' in target)) {
      const untitled = target as { content?: string; language?: string }
      return __addTextDocument(
        new MockTextDocument(
          Uri.parse(`untitled:Untitled-${documents.length + 1}`),
          untitled.content ?? '',
          untitled.language ?? 'markdown',
          true,
        ),
      )
    }
    const uri = typeof target === 'string' ? Uri.file(target) : target
    const doc = resolveDocument(uri)
    if (!doc) throw FileSystemError.FileNotFound(uri)
    return doc
  },
  /** Glob search over the in-memory filesystem, scoped to the workspace folders
   *  when any are set (as the real one is). */
  findFiles: async (include: string, exclude?: string | null): Promise<UriLike[]> => {
    const roots = ((workspace.workspaceFolders ?? []) as Array<{ uri: UriLike }>).map((f) => `${fsKey(f.uri)}/`)
    const includeRe = globToRegExp(include)
    const excludeRe = exclude ? globToRegExp(exclude) : undefined
    const found: UriLike[] = []
    for (const key of [...files.keys()].sort()) {
      const root = roots.length === 0 ? '' : roots.find((r) => key.startsWith(r))
      if (root === undefined) continue
      const relative = root ? key.slice(root.length) : key.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, '')
      if (!includeRe.test(relative) || excludeRe?.test(relative)) continue
      found.push(uriFromKey(key))
    }
    return found
  },
  fs: {
    /** Rejects with `code: 'FileNotFound'` for a missing entry, like the real one —
     *  the sidecar/draft backends read that rejection as "no comments yet". */
    readFile: async (uri: UriLike): Promise<Uint8Array> => {
      const entry = files.get(fsKey(uri))
      if (!entry) throw FileSystemError.FileNotFound(uri)
      return Uint8Array.from(entry.data)
    },
    writeFile: async (uri: UriLike, content: Uint8Array): Promise<void> => {
      fsWrite(uri, content)
    },
    delete: async (uri: UriLike, _options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> => {
      const key = fsKey(uri)
      if (files.delete(key)) return
      if (!directories.has(key)) throw FileSystemError.FileNotFound(uri)
      // `recursive` is accepted and ignored: a directory delete always takes its
      // subtree, rather than inventing an error code the real API does not define.
      const prefix = childPrefix(key)
      directories.delete(key)
      for (const child of [...files.keys()]) if (child.startsWith(prefix)) files.delete(child)
      for (const child of [...directories]) if (child.startsWith(prefix)) directories.delete(child)
    },
    createDirectory: async (uri: UriLike): Promise<void> => {
      const key = fsKey(uri)
      directories.add(key)
      registerAncestors(key)
    },
    stat: async (uri: UriLike): Promise<{ type: number; ctime: number; mtime: number; size: number }> => {
      const key = fsKey(uri)
      const entry = files.get(key)
      if (entry) return { type: FileType.File, ctime: entry.ctime, mtime: entry.mtime, size: entry.data.length }
      if (directories.has(key)) return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 }
      throw FileSystemError.FileNotFound(uri)
    },
    readDirectory: async (uri: UriLike): Promise<Array<[string, number]>> => {
      const key = fsKey(uri)
      const prefix = childPrefix(key)
      if (!directories.has(key) && ![...files.keys()].some((f) => f.startsWith(prefix))) {
        throw FileSystemError.FileNotFound(uri)
      }
      const name = (child: string): string => child.slice(child.lastIndexOf('/') + 1)
      const children: Array<[string, number]> = []
      for (const f of files.keys()) if (parentKey(f) === key) children.push([name(f), FileType.File])
      for (const d of directories) if (parentKey(d) === key) children.push([name(d), FileType.Directory])
      return children.sort((a, b) => a[0].localeCompare(b[0]))
    },
  },
}

/** Test seam: open/close a workspace. Accepts folder objects or bare paths; pass
 *  `undefined` for "no folder open", which is a different branch from an empty list. */
export function __setWorkspaceFolders(
  folders: Array<{ uri: UriLike; name?: string } | UriLike | string> | undefined,
): void {
  if (folders === undefined) {
    workspace.workspaceFolders = undefined
    return
  }
  workspace.workspaceFolders = folders.map((folder, index) => {
    const uri =
      typeof folder === 'string' ? Uri.file(folder) : 'uri' in folder ? folder.uri : (folder as UriLike)
    const name = typeof folder === 'object' && 'name' in folder && folder.name ? folder.name : uri.path.split('/').pop() || 'root'
    return { uri, name, index }
  })
}

/** Backing value for env.appName; tests can seed via __setAppName. */
let appName = 'Test Host'

/** Test seam: script vscode.env.appName (e.g. 'Visual Studio Code' vs 'Kiro'). */
export function __setAppName(name: string): void {
  appName = name
}

export const env = {
  get appName(): string {
    return appName
  },
}

/** Webview double: records what the host posted and can deliver a webview→host
 *  message to the handler the host registered. */
export class MockWebview {
  options: unknown = {}
  html = ''
  cspSource = 'vscode-webview://mock'
  /** Every message the host posted, oldest first. */
  readonly posted: unknown[] = []
  private readonly messageEmitter = new EventEmitter<unknown>()

  asWebviewUri = (uri: UriLike): UriLike => ({
    scheme: 'vscode-webview',
    fsPath: uri.fsPath,
    path: uri.path,
    toString: () => `vscode-webview://mock${uri.path}`,
  })
  postMessage = async (message: unknown): Promise<boolean> => {
    this.posted.push(message)
    return true
  }
  onDidReceiveMessage = this.messageEmitter.event

  /** Test seam: deliver a webview→host message to the registered handler. */
  __receive(message: unknown): void {
    this.messageEmitter.fire(message)
  }
  /** Test seam: forget the recorded posts (keeps the handler registered). */
  __clearPosted(): void {
    this.posted.length = 0
  }
}

export class MockWebviewPanel {
  readonly webview = new MockWebview()
  active = true
  visible = true
  options: unknown = {}
  private readonly disposeEmitter = new EventEmitter<void>()
  private readonly viewStateEmitter = new EventEmitter<{ webviewPanel: MockWebviewPanel }>()

  constructor(
    readonly viewType = 'kiro-md-translator.preview',
    public title = 'Preview',
    public viewColumn: number = ViewColumn.One,
  ) {}

  onDidDispose = this.disposeEmitter.event
  onDidChangeViewState = this.viewStateEmitter.event
  reveal(column?: number): void {
    if (column !== undefined) this.viewColumn = column
    this.__setActive(true)
  }
  dispose(): void {
    this.disposeEmitter.fire()
  }
  /** Test seam: focus/blur the panel — fires onDidChangeViewState like the host does. */
  __setActive(active: boolean): void {
    this.active = active
    this.visible = active
    this.viewStateEmitter.fire({ webviewPanel: this })
  }
}

interface CustomEditorRegistration {
  viewType: string
  provider: unknown
  options: unknown
}
const customEditors: CustomEditorRegistration[] = []
const progressReports: unknown[] = []
let progressSource: CancellationTokenSource | undefined

export const window = {
  showSaveDialog: async (_opts?: unknown): Promise<unknown> => undefined,
  showInformationMessage: async (_msg: string, ..._items: unknown[]): Promise<unknown> =>
    undefined,
  showWarningMessage: async (_msg: string, ..._items: unknown[]): Promise<unknown> => undefined,
  showErrorMessage: async (_msg: string, ..._items: unknown[]): Promise<unknown> => undefined,
  showInputBox: async (_opts?: unknown): Promise<string | undefined> => undefined,
  showTextDocument: async (doc: unknown, _opts?: unknown): Promise<unknown> => ({ document: doc }),
  onDidChangeTextEditorVisibleRanges: visibleRangesEmitter.event,
  activeTextEditor: undefined as unknown,
  createWebviewPanel: (viewType: string, title: string, showOptions?: unknown, options?: unknown): MockWebviewPanel => {
    const panel = new MockWebviewPanel(viewType, title, typeof showOptions === 'number' ? showOptions : ViewColumn.One)
    panel.options = options ?? {}
    return panel
  },
  registerCustomEditorProvider: (viewType: string, provider: unknown, options?: unknown): Disposable => {
    const registration: CustomEditorRegistration = { viewType, provider, options }
    customEditors.push(registration)
    return new Disposable(() => {
      const i = customEditors.indexOf(registration)
      if (i >= 0) customEditors.splice(i, 1)
    })
  },
  /** Runs the task immediately with a live progress recorder and a cancellable token. */
  withProgress: async <T>(
    _options: unknown,
    task: (
      progress: { report(value: unknown): void },
      token: CancellationTokenSource['token'],
    ) => Promise<T> | T,
  ): Promise<T> => {
    progressSource = new CancellationTokenSource()
    return task({ report: (value) => void progressReports.push(value) }, progressSource.token)
  },
}

/** Test seam: script `window.activeTextEditor` (drives the editor-selection branches). */
export function __setActiveTextEditor(editor: unknown): void {
  window.activeTextEditor = editor
}

/** Test seam: what `registerCustomEditorProvider` has been handed, oldest first. */
export function __registeredCustomEditors(): readonly CustomEditorRegistration[] {
  return customEditors
}

/** Test seam: everything reported to the in-flight `withProgress` task. */
export function __progressReports(): readonly unknown[] {
  return progressReports
}

/** Test seam: cancel the token the current `withProgress` task is holding. */
export function __cancelProgress(): void {
  progressSource?.cancel()
}

/** Assemble the `ExtensionContext` shape `activate()` needs. Each piece is a real
 *  in-memory object, so globalState survives a simulated restart if the same
 *  Memento is passed to the next context. */
export function __createExtensionContext(overrides?: {
  globalState?: MemMemento
  secrets?: MemSecretStorage
  globalStorageUri?: UriLike
  extensionUri?: UriLike
}): {
  subscriptions: Array<{ dispose(): void }>
  globalState: MemMemento
  workspaceState: MemMemento
  secrets: MemSecretStorage
  globalStorageUri: UriLike
  extensionUri: UriLike
} {
  return {
    subscriptions: [],
    globalState: overrides?.globalState ?? new MemMemento(),
    workspaceState: new MemMemento(),
    secrets: overrides?.secrets ?? new MemSecretStorage(),
    globalStorageUri: overrides?.globalStorageUri ?? Uri.file('/global/storage'),
    extensionUri: overrides?.extensionUri ?? Uri.file('/ext'),
  }
}

/** Test seam: reset the host state an integration test mutates — files, documents,
 *  workspace folders, window state. Config, secrets and lm models are left alone on
 *  purpose; they have their own seams and are usually seeded per suite. */
export function __resetHost(): void {
  __resetFs()
  __resetDocuments()
  workspace.workspaceFolders = []
  applyEditResult = undefined
  window.activeTextEditor = undefined
  customEditors.length = 0
  progressReports.length = 0
  progressSource = undefined
}

export const commands = {
  executeCommand: async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined,
  registerCommand: (_command: string, _cb: (...a: unknown[]) => unknown): Disposable =>
    new Disposable(() => {}),
}

export const l10n = {
  /** Mirrors vscode.l10n.t placeholder substitution so wrappers can delegate. */
  t(message: string, ...args: Array<string | number | boolean>): string {
    return message.replace(/\{(\d+)\}/g, (_m, i) =>
      String(args[Number(i)] ?? `{${i}}`),
    )
  },
}

/** Mirrors vscode.LanguageModelChatMessageRole (values unused by the mock, kept for parity). */
export const LanguageModelChatMessageRole = { User: 1, Assistant: 2, System: 0 } as const

/** Minimal stand-in for vscode.LanguageModelChatMessage's `.User`/`.Assistant` factories. */
export class LanguageModelChatMessage {
  constructor(public role: string, public content: string, public name?: string) {}
  static User(content: string, name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage('user', content, name)
  }
  static Assistant(content: string, name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage('assistant', content, name)
  }
}

/** Scripted model backing vscode.lm.selectChatModels; set via __setLmModels. */
export interface MockLmModel {
  vendor: string
  family: string
  id: string
  name: string
  sendRequest: (
    messages: LanguageModelChatMessage[],
    options: unknown,
    token: { isCancellationRequested: boolean; onCancellationRequested: (l: () => void) => Disposable },
  ) => Promise<{ text: AsyncIterable<string> }>
}

let lmModels: MockLmModel[] = []

/** Test seam: script the models vscode.lm.selectChatModels(...) returns. */
export function __setLmModels(models: MockLmModel[]): void {
  lmModels = models
}

export const lm = {
  selectChatModels: async (selector?: { vendor?: string; family?: string }): Promise<MockLmModel[]> =>
    lmModels.filter(
      (m) =>
        (selector?.vendor === undefined || m.vendor === selector.vendor) &&
        (selector?.family === undefined || m.family === selector.family),
    ),
}

export default {
  Disposable,
  EventEmitter,
  CancellationTokenSource,
  ViewColumn,
  ConfigurationTarget,
  ProgressLocation,
  FileType,
  EndOfLine,
  Position,
  Range,
  Uri,
  FileSystemError,
  WorkspaceEdit,
  workspace,
  env,
  window,
  commands,
  l10n,
  lm,
  LanguageModelChatMessage,
  LanguageModelChatMessageRole,
}
