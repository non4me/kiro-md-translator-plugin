/**
 * Hand-written stub of the `vscode` extension API for Node/vitest.
 * Only the surface the plugin actually uses is implemented. Methods are plain
 * functions so tests can `sinon.stub` them; a few helpers (EventEmitter,
 * CancellationTokenSource, MemSecretStorage, config store) are real so tests
 * get useful behaviour out of the box.
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

export class Position {
  constructor(public line: number, public character: number) {}
}
export class Range {
  constructor(public start: Position, public end: Position) {}
}

export const Uri = {
  file: (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` }),
  parse: (s: string) => ({ scheme: 'file', fsPath: s, path: s, toString: () => s }),
  joinPath: (base: any, ...parts: string[]) => ({
    scheme: base.scheme ?? 'file',
    fsPath: [base.fsPath, ...parts].join('/'),
    path: [base.path, ...parts].join('/'),
    toString: () => [base.toString(), ...parts].join('/'),
  }),
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

/** Backing store for getConfiguration; tests can seed via __setConfig. */
const configStore = new Map<string, unknown>()
export function __setConfig(section: string, key: string, value: unknown): void {
  configStore.set(`${section}.${key}`, value)
}
export function __clearConfig(): void {
  configStore.clear()
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
  }),
  onDidChangeConfiguration: (_listener: (e: unknown) => void): Disposable =>
    new Disposable(() => {}),
  onDidChangeTextDocument: (_listener: (e: unknown) => void): Disposable =>
    new Disposable(() => {}),
  workspaceFolders: [] as unknown[],
  fs: {
    writeFile: async (_uri: unknown, _content: Uint8Array): Promise<void> => {},
  },
}

export const window = {
  showSaveDialog: async (_opts?: unknown): Promise<unknown> => undefined,
  showInformationMessage: async (_msg: string, ..._items: string[]): Promise<unknown> =>
    undefined,
  showWarningMessage: async (_msg: string, ..._items: string[]): Promise<unknown> => undefined,
  showErrorMessage: async (_msg: string, ..._items: string[]): Promise<unknown> => undefined,
  onDidChangeTextEditorVisibleRanges: (_listener: (e: unknown) => void): Disposable =>
    new Disposable(() => {}),
  activeTextEditor: undefined as unknown,
  createWebviewPanel: (_a: string, _b: string, _c: unknown, _d?: unknown): unknown => ({}),
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

export default {
  Disposable,
  EventEmitter,
  CancellationTokenSource,
  ViewColumn,
  Position,
  Range,
  Uri,
  workspace,
  window,
  commands,
  l10n,
}
