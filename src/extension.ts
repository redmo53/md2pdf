import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { convertMarkdownToPdf } from './converter';

let lastGeneratedHtmlPath: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const convertCommand = vscode.commands.registerCommand(
    'md2pdf.convertToPdf',
    async (uriFromMenu?: vscode.Uri) => {
      await handleConvertCommand(context, uriFromMenu);
    }
  );

  const openHtmlCommand = vscode.commands.registerCommand(
    'md2pdf.openGeneratedHtml',
    async () => {
      if (!lastGeneratedHtmlPath || !fs.existsSync(lastGeneratedHtmlPath)) {
        vscode.window.showWarningMessage(
          "Aucun HTML intermédiaire n'a été conservé. Active l'option " +
            "'md2pdf.keepIntermediateHtml' puis relance une conversion."
        );
        return;
      }
      await vscode.env.openExternal(vscode.Uri.file(lastGeneratedHtmlPath));
    }
  );

  context.subscriptions.push(convertCommand, openHtmlCommand);
}

export function deactivate(): void {
  // Rien à nettoyer explicitement : les dossiers temporaires sont supprimés
  // par le convertisseur lui-même après chaque conversion.
}

async function handleConvertCommand(
  context: vscode.ExtensionContext,
  uriFromMenu?: vscode.Uri
): Promise<void> {
  const mdFilePath = await resolveTargetMarkdownFile(uriFromMenu);
  if (!mdFilePath) {
    return;
  }

  // On s'assure que le fichier est enregistré sur le disque avant conversion,
  // car la génération lit le fichier directement depuis le système de fichiers.
  const dirtyDoc = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.fsPath === mdFilePath && doc.isDirty
  );
  if (dirtyDoc) {
    const choice = await vscode.window.showWarningMessage(
      'Le fichier contient des modifications non enregistrées. Enregistrer avant de convertir ?',
      'Enregistrer et convertir',
      'Annuler'
    );
    if (choice !== 'Enregistrer et convertir') {
      return;
    }
    await dirtyDoc.save();
  }

  const config = vscode.workspace.getConfiguration('md2pdf');
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(mdFilePath));
  const templatesFolderSetting = config.get<string>('templatesFolder', '.md2pdf/templates');
  const workspaceTemplatesDir = workspaceFolder
    ? path.join(workspaceFolder.uri.fsPath, templatesFolderSetting)
    : undefined;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MD2PDF',
      cancellable: false
    },
    async (progressReporter) => {
      try {
        const result = await convertMarkdownToPdf({
          mdFilePath,
          extensionTemplatesDir: path.join(context.extensionPath, 'templates'),
          workspaceTemplatesDir,
          defaultTemplateName: config.get<string>('defaultTemplate', 'default'),
          outputFolder: config.get<string>('outputFolder', ''),
          keepIntermediateHtml: config.get<boolean>('keepIntermediateHtml', false),
          mermaidTheme: config.get<string>('mermaidTheme', 'default'),
          chromiumExecutablePath: normalizeEmptyString(
            config.get<string>('chromiumExecutablePath', '')
          ),
          onProgress: (message) => progressReporter.report({ message })
        });

        lastGeneratedHtmlPath = result.htmlPath;

        if (result.unparsedImages.length > 0) {
          await warnAboutUnparsedImages(result.unparsedImages);
        }

        const openAfterExport = config.get<boolean>('openAfterExport', true);
        const action = openAfterExport
          ? await autoOpenPdf(result.pdfPath)
          : await vscode.window.showInformationMessage(
              `PDF généré avec le modèle "${result.templateUsed}" : ${path.basename(result.pdfPath)}`,
              'Ouvrir le PDF',
              'Afficher dans le dossier'
            );

        if (action === 'Afficher dans le dossier') {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.pdfPath));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`MD2PDF : échec de la conversion — ${message}`);
      }
    }
  );
}

function normalizeEmptyString(value: string): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

async function warnAboutUnparsedImages(unparsedImages: string[]): Promise<void> {
  const count = unparsedImages.length;
  const label = count === 1 ? '1 image' : `${count} images`;

  const choice = await vscode.window.showWarningMessage(
    `MD2PDF : ${label} n'a pas été reconnue car son chemin contient un espace non échappé ` +
      `(la syntaxe Markdown standard l'interdit en dehors de < >). Encadrez le chemin par ` +
      `< > (ex: ![alt](<mon chemin avec espaces/image.png>)) ou utilisez un chemin sans espace.`,
    'Voir le détail'
  );

  if (choice === 'Voir le détail') {
    const details = unparsedImages.map((ref, index) => `${index + 1}. ${ref}`).join('\n\n');
    const doc = await vscode.workspace.openTextDocument({
      content: `Références d'image non reconnues par MD2PDF :\n\n${details}`,
      language: 'plaintext'
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}

async function autoOpenPdf(pdfPath: string): Promise<string | undefined> {
  await vscode.env.openExternal(vscode.Uri.file(pdfPath));
  return undefined;
}

/**
 * Détermine le fichier .md cible : celui passé par le menu contextuel,
 * sinon l'éditeur actif s'il s'agit bien d'un document Markdown.
 */
async function resolveTargetMarkdownFile(uriFromMenu?: vscode.Uri): Promise<string | undefined> {
  if (uriFromMenu?.fsPath) {
    return uriFromMenu.fsPath;
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.languageId === 'markdown') {
    return activeEditor.document.uri.fsPath;
  }

  vscode.window.showErrorMessage(
    'MD2PDF : ouvre un fichier Markdown (.md) ou lance la commande depuis son menu contextuel.'
  );
  return undefined;
}
