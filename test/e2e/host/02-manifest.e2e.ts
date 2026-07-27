/**
 * E2 / E4 / E5 / E6 / E7 — everything the manifest promises the host, checked
 * against what the host actually did with it.
 *
 * This is the drift class that ships silently in a .vsix: a declared command that
 * was never registered is a palette entry that errors; a configuration property
 * whose schema VS Code rejected reads back as `undefined` and every
 * `SettingsManager` fallback quietly takes over with the wrong value; a `%key%`
 * with no bundle entry titles a Settings section `%config.section.provider%`; a
 * menu icon whose file was ignored by .vscodeignore is a blank toolbar button; a
 * missing webview bundle is a blank white panel that throws nothing at all.
 *
 * None of it is reachable from vitest: the mock's `commands.registerCommand` is a
 * no-op and its `inspect()` hardcodes `defaultValue: undefined`.
 */
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import {
  COMMAND_PREFIX,
  CONFIG_SECTION,
  type Manifest,
  type ManifestProperty,
  activatedExtension,
  nlsPlaceholders,
  readText,
  resolveNls,
} from './helpers/host'

interface DeclaredProperty {
  fullKey: string
  shortKey: string
  schema: ManifestProperty
  sectionTitle: string
}

function declaredProperties(m: Manifest): DeclaredProperty[] {
  const out: DeclaredProperty[] = []
  for (const section of m.contributes.configuration) {
    for (const [fullKey, schema] of Object.entries(section.properties)) {
      out.push({
        fullKey,
        // Dotted sub-keys (`aiAssistant.provider`) survive the strip, which is
        // exactly how SettingsManager reads them.
        shortKey: fullKey.slice(`${CONFIG_SECTION}.`.length),
        schema,
        sectionTitle: section.title,
      })
    }
  }
  return out
}

describe('E2: manifest <-> runtime command parity', () => {
  let ext: vscode.Extension<unknown>
  let m: Manifest

  before(async function () {
    this.timeout(60_000)
    ext = await activatedExtension()
    m = ext.packageJSON as Manifest
  })

  it('registers exactly the commands it declares, in both directions', async () => {
    const declared = m.contributes.commands.map((c) => c.command)
    const registered = (await vscode.commands.getCommands(true)).filter((c) =>
      c.startsWith(COMMAND_PREFIX),
    )

    assert.deepEqual(
      declared.filter((c) => !registered.includes(c)).sort(),
      [],
      'declared in package.json but never registered — the palette entry fails with "command not found"',
    )
    assert.deepEqual(
      registered.filter((c) => !declared.includes(c)).sort(),
      [],
      'registered at runtime but not declared — dead weight the user can never reach',
    )
  })

  it('gives every declared command a non-empty title', () => {
    // A title-less command is invisible in the command palette.
    assert.deepEqual(
      m.contributes.commands.filter((c) => !c.title?.trim()).map((c) => c.command),
      [],
      'command(s) with no palette title',
    )
  })

  it('namespaces every command id under the extension prefix', () => {
    // Command ids are a global namespace shared with every other extension; an id
    // outside this prefix is a collision waiting to happen.
    assert.deepEqual(
      m.contributes.commands.map((c) => c.command).filter((c) => !c.startsWith(COMMAND_PREFIX)),
      [],
    )
  })
})

describe('E4: every declared setting is really registered by VS Code', () => {
  let m: Manifest
  let declared: DeclaredProperty[]

  before(async function () {
    this.timeout(60_000)
    m = (await activatedExtension()).packageJSON as Manifest
    declared = declaredProperties(m)
  })

  it('registers each property with the default the manifest declares', () => {
    // VS Code silently DROPS a property whose schema it rejects (a default that
    // violates its own enum, a malformed `items`, a key declared twice across
    // sections). The setting then reads as undefined, SettingsManager's fallback
    // takes over, and the extension keeps "working" with values the user never
    // chose. A dropped property shows up here as `defaultValue: undefined`.
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION)
    const mismatches: string[] = []
    for (const p of declared) {
      const inspected = cfg.inspect(p.shortKey)
      if (!inspected) {
        mismatches.push(`${p.fullKey}: not registered at all`)
        continue
      }
      try {
        assert.deepEqual(inspected.defaultValue, p.schema.default)
      } catch {
        mismatches.push(
          `${p.fullKey}: host default ${JSON.stringify(inspected.defaultValue)} ` +
            `!= manifest default ${JSON.stringify(p.schema.default)}`,
        )
      }
    }
    assert.deepEqual(mismatches, [])
  })

  it('declares every property inside the settings section SettingsManager reads', () => {
    // SettingsManager only ever calls getConfiguration('kiro-md-translator'); a
    // property contributed under any other prefix is unreachable from the code.
    assert.deepEqual(
      declared.map((p) => p.fullKey).filter((k) => !k.startsWith(`${CONFIG_SECTION}.`)),
      [],
    )
  })

  it('is a coherent schema: unique keys, unique section order, enum parity', () => {
    const keys = declared.map((p) => p.fullKey)
    assert.deepEqual(
      keys.filter((k, i) => keys.indexOf(k) !== i),
      [],
      'the same setting key is declared in more than one section — VS Code keeps one and drops the rest',
    )

    const orders = m.contributes.configuration.map((s) => s.order)
    assert.deepEqual(
      orders.filter((o, i) => o !== undefined && orders.indexOf(o) !== i),
      [],
      'two settings sections claim the same `order` — their page position is then arbitrary',
    )

    const enumProblems: string[] = []
    for (const p of declared) {
      const values = p.schema.enum
      if (!values) continue
      if (p.schema.enumDescriptions && p.schema.enumDescriptions.length !== values.length) {
        enumProblems.push(`${p.fullKey}: enumDescriptions/enum length mismatch`)
      }
      if (p.schema.enumItemLabels && p.schema.enumItemLabels.length !== values.length) {
        enumProblems.push(`${p.fullKey}: enumItemLabels/enum length mismatch`)
      }
      if (!values.includes(p.schema.default as string)) {
        // This one is fatal: VS Code rejects the whole property.
        enumProblems.push(`${p.fullKey}: default ${JSON.stringify(p.schema.default)} is not in its own enum`)
      }
    }
    assert.deepEqual(enumProblems, [])
  })

  it('ships defaults that make the extension silent until configured', () => {
    // Load-bearing, and not only for this suite. The product promise is that
    // nothing leaves the machine until the user asks for it: translation is off
    // while Target Language is empty, it never runs unprompted while the mode is
    // on-demand, and the AI Assistant sends nothing while disabled. It is also what
    // guarantees this whole layer makes no outbound call — so if a shipped default
    // ever changes, this fails loudly instead of silently becoming a network test.
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION)
    assert.equal(cfg.inspect('targetLanguage')?.defaultValue, '')
    assert.equal(cfg.get('targetLanguage'), '')
    assert.equal(cfg.get('translationMode'), 'on-demand')
    assert.equal(cfg.get('aiAssistant.enabled'), false)
  })
})

describe('E5: NLS placeholders resolve', () => {
  let ext: vscode.Extension<unknown>
  let bundle: Record<string, string>
  let rawManifest: unknown

  before(async function () {
    this.timeout(60_000)
    ext = await activatedExtension()
    bundle = JSON.parse(await readText(vscode.Uri.joinPath(ext.extensionUri, 'package.nls.json')))
    rawManifest = JSON.parse(await readText(vscode.Uri.joinPath(ext.extensionUri, 'package.json')))
  })

  it('has a package.nls.json entry for every %placeholder% in the manifest', () => {
    const missing = [...nlsPlaceholders(rawManifest)].filter(
      (key) => typeof bundle[key] !== 'string' || bundle[key].trim() === '',
    )
    assert.deepEqual(
      missing.sort(),
      [],
      'placeholder(s) with no package.nls.json entry — these reach the user as literal %key% text',
    )
  })

  it('hands every settings-section title to the host as a real, resolved string', () => {
    // Whether `Extension.packageJSON` returns the raw manifest or the NLS-RESOLVED
    // one is a host implementation detail — observed on VS Code 1.130: it returns
    // the RESOLVED manifest, i.e. `contributes.configuration[0].title` is already
    // "Provider", not "%config.section.provider%". Comparing the live manifest
    // against the raw file therefore checks the host's own substitution, and stays
    // a real assertion on a host that does not substitute (both sides resolve
    // through the same bundle, and a missing key fails on either path).
    const raw = (rawManifest as Manifest).contributes.configuration
    const live = (ext.packageJSON as Manifest).contributes.configuration
    assert.equal(live.length, raw.length, 'the host dropped or added a settings section')

    const problems: string[] = []
    live.forEach((section, i) => {
      const expected = resolveNls(raw[i].title, bundle)
      const actual = resolveNls(section.title, bundle)
      if (!expected?.trim()) {
        problems.push(`${raw[i].title}: no usable package.nls.json entry`)
      } else if (actual !== expected) {
        problems.push(`${raw[i].title}: the host shows ${JSON.stringify(section.title)}`)
      } else if (/^%.*%$/.test(actual)) {
        problems.push(`${raw[i].title}: still a literal placeholder on the Settings page`)
      }
    })
    assert.deepEqual(problems, [])
  })
})

describe('E6: menu contributions point at things that exist', () => {
  let ext: vscode.Extension<unknown>
  let m: Manifest

  before(async function () {
    this.timeout(60_000)
    ext = await activatedExtension()
    m = ext.packageJSON as Manifest
  })

  it('references only declared commands', () => {
    const declared = new Set(m.contributes.commands.map((c) => c.command))
    const dangling = Object.entries(m.contributes.menus).flatMap(([menu, items]) =>
      items.filter((i) => !declared.has(i.command)).map((i) => `${menu}: ${i.command}`),
    )
    assert.deepEqual(dangling, [], 'menu item(s) bound to a command that is not contributed')
  })

  it('gates the editor-title icons on the current custom-editor viewType', () => {
    // req 3.21 promises the two toggles appear in the native editor title bar only
    // for an active preview, and hide while a required setting is missing. Both
    // clauses embed the viewType as a STRING LITERAL, so a viewType rename makes the
    // icons silently never appear, with nothing thrown anywhere.
    const expected = m.contributes.customEditors[0].viewType
    const items = m.contributes.menus['editor/title'] ?? []
    assert.ok(items.length > 0, 'req 3.21 requires editor/title contributions')
    const broken = items
      .filter(
        (i) =>
          !i.when?.includes(`activeCustomEditorId == '${expected}'`) ||
          !i.when.includes('!kiroMd.settingsMissing'),
      )
      .map((i) => `${i.command}: when=${i.when}`)
    assert.deepEqual(
      broken,
      [],
      `editor/title clause(s) that no longer name viewType '${expected}' and the settingsMissing gate`,
    )
  })

  it('ships every icon file the manifest references', async () => {
    // A .vscodeignore edit that drops `media/` gives blank toolbar buttons in the
    // packaged extension and no error at all.
    const targets: string[] = []
    for (const c of m.contributes.commands) {
      if (!c.icon) continue
      if (typeof c.icon === 'string') targets.push(c.icon)
      else targets.push(c.icon.light, c.icon.dark)
    }
    if (m.icon) targets.push(m.icon)
    assert.ok(targets.length > 0, 'req 3.21 requires light/dark SVG icons for the two toggles')

    for (const rel of targets) {
      const uri = vscode.Uri.joinPath(ext.extensionUri, ...rel.split('/'))
      const stat = await vscode.workspace.fs.stat(uri) // rejects when missing
      assert.ok(stat.size > 0, `${rel} is empty`)
    }
  })
})

// KNOWN LIMITATION, stated rather than papered over: the suite runs from an
// `--extensionDevelopmentPath`, so `extensionUri` is the repo root. These stats
// prove the BUILD ran and put the files where the host looks for them; they cannot
// prove the files SHIP, because .vscodeignore is what decides that and no VS Code
// launch can observe it from a dev path. The complement lives outside this layer:
// `npx @vscode/vsce ls` must list out/extension.js, out/webview/previewPanel.js,
// media/*.svg, media/icon.png and package.nls.json.
describe('E7: the runtime bundles exist where the host actually looks', () => {
  let ext: vscode.Extension<unknown>

  before(async function () {
    this.timeout(60_000)
    ext = await activatedExtension()
  })

  it('has a non-empty bundle at the path `main` declares', async () => {
    const main = (ext.packageJSON as Manifest).main
    const uri = vscode.Uri.joinPath(ext.extensionUri, ...main.replace(/^\.\//, '').split('/'))
    assert.ok((await vscode.workspace.fs.stat(uri)).size > 0, `${main} is empty`)
  })

  it('has the webview bundle at the exact path ActivationController builds', async () => {
    // resolveCustomTextEditor hardcodes extensionUri + out/webview/previewPanel.js.
    // If that file is absent — build skipped, path typo, .vscodeignore regression —
    // the preview is a blank white panel and absolutely nothing throws.
    const uri = vscode.Uri.joinPath(ext.extensionUri, 'out', 'webview', 'previewPanel.js')
    const stat = await vscode.workspace.fs.stat(uri)
    assert.ok(stat.size > 0, 'the webview bundle is empty')
    // The documented budget for the webview client (CLAUDE.md, Build specifics).
    assert.ok(
      stat.size < 50 * 1024,
      `the webview bundle is ${stat.size} bytes, over the documented 50 KB budget`,
    )
  })

  it('ships package.nls.json next to the manifest', async () => {
    const uri = vscode.Uri.joinPath(ext.extensionUri, 'package.nls.json')
    assert.ok((await vscode.workspace.fs.stat(uri)).size > 0)
  })
})
