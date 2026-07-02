import * as vscode from 'vscode'
import { type IExportService, type LanguageCode, TranslatorError } from './types'
import { t } from './l10n'

/** Strip a trailing `.md` (case-insensitive) to get the filename stem. */
export function stripMdExtension(fileName: string): string {
  return fileName.replace(/\.md$/i, '')
}

/** Build the suggested export filename `{stem}.{langCode}.md` (req 6.2 / Property 12). */
export function suggestedExportName(originalFileName: string, targetLang: LanguageCode): string {
  return `${stripMdExtension(originalFileName)}.${targetLang}.md`
}

export class ExportService implements IExportService {
  async exportTranslation(
    translatedMarkdown: string,
    originalUri: vscode.Uri,
    targetLang: LanguageCode,
  ): Promise<void> {
    const baseName = originalUri.path.split('/').pop() ?? 'document.md'
    const suggested = suggestedExportName(baseName, targetLang)
    const defaultUri = vscode.Uri.joinPath(originalUri, '..', suggested)

    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ['md'] },
    })
    if (!target) {
      // User cancelled — close silently, no notification (req 6.6).
      return
    }

    try {
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(translatedMarkdown))
    } catch (err) {
      const message = (err as Error).message
      void vscode.window.showErrorMessage(message)
      throw new TranslatorError('EXPORT_WRITE_FAILED', message)
    }

    void vscode.window.showInformationMessage(t('File saved: {0}', target.fsPath))
  }
}
