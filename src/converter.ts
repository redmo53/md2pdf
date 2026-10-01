import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import matter = require('gray-matter');
import puppeteer = require('puppeteer');

import { renderMarkdownToHtml } from './markdownRenderer';
import { renderTemplate, resolveTemplate } from './templateEngine';

export interface ConversionOptions {
  mdFilePath: string;
  extensionTemplatesDir: string;
  workspaceTemplatesDir: string | undefined;
  defaultTemplateName: string;
  outputFolder: string; // '' => même dossier que le fichier source
  keepIntermediateHtml: boolean;
  mermaidTheme: string;
  /** Chemin vers un exécutable Chrome/Chromium existant (optionnel). */
  chromiumExecutablePath?: string;
  /** Callback de progression, pour affichage dans la barre de statut VS Code. */
  onProgress?: (message: string) => void;
}

export interface ConversionResult {
  pdfPath: string;
  htmlPath: string | undefined;
  templateUsed: string;
  /** Images du Markdown source non reconnues comme telles (chemin avec
   *  espace non échappé, généralement) : à signaler à l'utilisateur. */
  unparsedImages: string[];
}

/**
 * Chaîne de conversion complète :
 *  1. Lecture du fichier .md et extraction du front matter
 *  2. Résolution du modèle (front matter > défaut de config > "default")
 *  3. Rendu Markdown -> HTML (avec transformation des blocs mermaid)
 *  4. Injection dans le modèle HTML via le moteur de tags
 *  5. Impression en PDF via Puppeteer, avec pagination Paged.js
 *     (marges, en-têtes, pieds de page pilotés par le CSS @page du modèle)
 */
export async function convertMarkdownToPdf(options: ConversionOptions): Promise<ConversionResult> {
  const {
    mdFilePath,
    extensionTemplatesDir,
    workspaceTemplatesDir,
    defaultTemplateName,
    outputFolder,
    keepIntermediateHtml,
    mermaidTheme,
    chromiumExecutablePath,
    onProgress
  } = options;

  const progress = onProgress ?? (() => {});

  // 1) Front matter -------------------------------------------------------
  progress('Lecture du fichier Markdown…');
  const rawContent = fs.readFileSync(mdFilePath, 'utf-8');
  const parsed = matter(rawContent);
  const frontMatter = parsed.data as Record<string, unknown>;
  const markdownBody = parsed.content;

  // 2) Résolution du modèle -------------------------------------------------
  const requestedTemplate =
    (typeof frontMatter.template === 'string' && frontMatter.template.trim()) ||
    defaultTemplateName;

  progress(`Résolution du modèle "${requestedTemplate}"…`);
  const template = resolveTemplate(requestedTemplate, workspaceTemplatesDir, extensionTemplatesDir);

  // 3) Markdown -> HTML (+ détection mermaid) ------------------------------
  progress('Conversion du Markdown en HTML…');
  const { html: contentHtml, mermaidBlockCount, mathUsed, unparsedImages } = renderMarkdownToHtml(markdownBody);

  // 4) Assemblage du document via le moteur de modèle ----------------------
  progress('Assemblage du document HTML…');
  const baseFileName = path.basename(mdFilePath, path.extname(mdFilePath));
  const templateData: Record<string, unknown> = {
    ...frontMatter,
    content: contentHtml,
    sourceFileName: baseFileName,
    generatedDate: new Date().toLocaleDateString('fr-FR'),
    generatedDateTime: new Date().toLocaleString('fr-FR')
  };

  const bodyHtml = renderTemplate(template.html, templateData);
  // Le CSS du modèle passe lui aussi par le moteur de balises : cela permet
  // d'insérer des champs du front matter directement dans les règles de
  // pagination (ex: `content: "{{auteur}}";` dans un `@bottom-left`), sans
  // recourir au mécanisme `string-set` (réservé aux en-têtes "courants" qui
  // dépendent du contenu de la page, comme le titre de la section en cours).
  const renderedCss = renderTemplate(template.css, templateData, 'css');
  const finalHtml = assembleFullHtmlDocument({
    bodyHtml,
    templateCss: renderedCss,
    mermaidTheme,
    includeMermaid: mermaidBlockCount > 0,
    includeMath: mathUsed,
    // Dossier du fichier .md source : sert de référence pour résoudre les
    // chemins relatifs (images, etc.) via une balise <base href>, puisque
    // le HTML intermédiaire est physiquement écrit ailleurs (dossier temp).
    sourceBaseDir: path.dirname(mdFilePath)
  });

  // Écriture du HTML intermédiaire dans un dossier temporaire. Les chemins
  // relatifs (images...) restent corrects grâce à la balise <base href>
  // injectée dans <head>, qui pointe vers le dossier du fichier .md source.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-'));
  const htmlTempPath = path.join(workDir, `${baseFileName}.${shortHash(mdFilePath)}.html`);
  fs.writeFileSync(htmlTempPath, finalHtml, 'utf-8');

  // 5) Détermination du chemin de sortie du PDF ----------------------------
  const sourceDir = path.dirname(mdFilePath);
  const targetDir = outputFolder
    ? path.isAbsolute(outputFolder)
      ? outputFolder
      : path.join(sourceDir, outputFolder)
    : sourceDir;
  fs.mkdirSync(targetDir, { recursive: true });
  const pdfPath = path.join(targetDir, `${baseFileName}.pdf`);

  // 6) Impression PDF via Puppeteer + Paged.js -----------------------------
  progress('Lancement du moteur de rendu (Chromium)…');
  await printHtmlToPdf(htmlTempPath, pdfPath, chromiumExecutablePath, progress);

  // 7) Conservation ou nettoyage du HTML intermédiaire ---------------------
  let keptHtmlPath: string | undefined;
  if (keepIntermediateHtml) {
    keptHtmlPath = path.join(targetDir, `${baseFileName}.preview.html`);
    fs.copyFileSync(htmlTempPath, keptHtmlPath);
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Le nettoyage du dossier temporaire n'est pas critique.
  }

  return { pdfPath, htmlPath: keptHtmlPath, templateUsed: template.name, unparsedImages };
}

function shortHash(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex').slice(0, 8);
}

/**
 * Construit le document HTML complet : squelette <html>, CSS du modèle,
 * contenu rendu, et scripts nécessaires (mermaid.js si besoin, paged.js
 * systématiquement pour la pagination / en-têtes / pieds de page / marges).
 */
function assembleFullHtmlDocument(params: {
  bodyHtml: string;
  templateCss: string;
  mermaidTheme: string;
  includeMermaid: boolean;
  includeMath: boolean;
  sourceBaseDir: string;
}): string {
  const { bodyHtml, templateCss, mermaidTheme, includeMermaid, includeMath, sourceBaseDir } = params;

  const mermaidJsPath = includeMermaid
    ? resolvePackageAsset('mermaid', 'dist/mermaid.min.js')
    : undefined;
  const pagedJsPath = resolvePackageAsset('pagedjs', 'dist/paged.polyfill.js');

  const mermaidScriptTag = mermaidJsPath
    ? `<script src="${toFileUrl(mermaidJsPath)}"></script>
<script>
  window.__md2pdfMermaidReady = false;
  mermaid.initialize({ startOnLoad: false, theme: ${JSON.stringify(mermaidTheme)}, securityLevel: 'loose' });
  mermaid.run({ querySelector: '.mermaid' }).then(() => { window.__md2pdfMermaidReady = true; });
</script>`
    : `<script>window.__md2pdfMermaidReady = true;</script>`;

  // La feuille de style KaTeX est chargée via <link> (et non recopiée dans
  // le <style> du modèle) : ses règles @font-face utilisent des chemins
  // relatifs vers le dossier "fonts/" voisin de katex.min.css. En passant
  // par un <link href="file:///.../katex.min.css">, le navigateur résout
  // ces chemins relatifs par rapport à l'emplacement réel du fichier CSS,
  // et retrouve donc les polices sans copie ni réécriture de chemin.
  const katexCssTag = includeMath
    ? `<link rel="stylesheet" href="${toFileUrl(resolvePackageAsset('katex', 'dist/katex.min.css'))}" />`
    : '';

  // IMPORTANT : paged.polyfill.js lit `window.PagedConfig` de manière
  // SYNCHRONE dès son exécution (au chargement du <script>). La balise qui
  // définit window.PagedConfig doit donc impérativement être placée AVANT
  // la balise <script> qui charge le polyfill lui-même, sinon Paged.js
  // retombe sur sa configuration par défaut (sans notre callback "after")
  // et window.__md2pdfPagedReady ne passe jamais à true.
  const pagedJsScriptTag = `<script>
  window.__md2pdfPagedReady = false;
  window.PagedConfig = {
    auto: true,
    after: function () { window.__md2pdfPagedReady = true; }
  };
</script>
<script src="${toFileUrl(pagedJsPath)}"></script>`;

  // <base href="..."> permet de résoudre les chemins relatifs (images,
  // etc.) référencés dans le Markdown par rapport au dossier du fichier
  // .md d'origine, alors que le HTML généré est physiquement écrit dans un
  // dossier temporaire. Le slash final est indispensable : sans lui, le
  // navigateur traite le dossier comme un fichier et résout les chemins
  // relatifs par rapport à son dossier PARENT.
  const baseHref = `${toFileUrl(sourceBaseDir)}/`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<base href="${escapeHtmlAttribute(baseHref)}" />
<title>Document</title>
${katexCssTag}
<style>
${templateCss}
</style>
</head>
<body>
${bodyHtml}
${mermaidScriptTag}
${pagedJsScriptTag}
</body>
</html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Résout un fichier situé à l'intérieur d'un package npm (ex: "pagedjs" +
 * "dist/paged.polyfill.js"), sans passer par require.resolve() sur le
 * sous-chemin lui-même.
 *
 * Certains packages (pagedjs, mermaid selon les versions) déclarent un champ
 * "exports" dans leur package.json qui **interdit explicitement** l'accès à
 * des sous-chemins non listés (ex: "./dist/paged.polyfill.js"), même si le
 * fichier existe bel et bien sur le disque. `require.resolve('pagedjs/dist/...')`
 * lève alors une erreur `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * On contourne cette restriction en résolvant uniquement la racine du
 * package (via son point d'entrée principal, toujours exposé par "exports"),
 * puis en construisant nous-mêmes le chemin vers le fichier voulu.
 */
function resolvePackageAsset(packageName: string, relativeAssetPath: string): string {
  const packageRoot = resolvePackageRoot(packageName);
  const assetPath = path.join(packageRoot, relativeAssetPath);

  if (!fs.existsSync(assetPath)) {
    throw new Error(
      `Fichier introuvable dans le package "${packageName}" : ${relativeAssetPath} ` +
        `(chemin recherché : ${assetPath}). Vérifie que le package est bien installé ` +
        `(npm install) et que la version correspond à celle attendue.`
    );
  }

  return assetPath;
}

function resolvePackageRoot(packageName: string): string {
  // require.resolve(packageName) renvoie le fichier "main"/"exports['.']"
  // du package. On remonte les dossiers jusqu'à trouver le package.json
  // du package concerné (et non un package.json parent quelconque).
  const entryFile = require.resolve(packageName);
  let dir = path.dirname(entryFile);

  // Sécurité anti-boucle infinie : on ne remonte jamais plus de 10 niveaux.
  for (let i = 0; i < 10; i += 1) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { name?: string };
      if (pkg.name === packageName) {
        return dir;
      }
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      break;
    }
    dir = parentDir;
  }

  throw new Error(`Impossible de localiser la racine du package "${packageName}".`);
}

function toFileUrl(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  const withSlashes = resolved.split(path.sep).join('/');
  const raw = withSlashes.startsWith('/') ? `file://${withSlashes}` : `file:///${withSlashes}`;
  // encodeURI laisse "/" et ":" intacts mais encode les espaces et autres
  // caractères spéciaux souvent présents dans les chemins (ex: "Mes Documents",
  // accents), qui feraient autrement échouer le chargement du fichier.
  return encodeURI(raw);
}

async function printHtmlToPdf(
  htmlPath: string,
  pdfPath: string,
  chromiumExecutablePath: string | undefined,
  progress: (message: string) => void
): Promise<void> {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromiumExecutablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files']
  });

  try {
    const page = await browser.newPage();
    const fileUrl = toFileUrl(htmlPath);
    await page.goto(fileUrl, { waitUntil: 'load' });

    progress('Rendu des diagrammes Mermaid…');
    await page.waitForFunction('window.__md2pdfMermaidReady === true', { timeout: 30000 });

    progress('Pagination du document (Paged.js)…');
    await page.waitForFunction('window.__md2pdfPagedReady === true', { timeout: 60000 });

    // Petite marge de sécurité pour laisser le layout se stabiliser
    // (polices, images, mise en page asynchrone de Paged.js).
    await new Promise((resolve) => setTimeout(resolve, 200));

    progress('Génération du PDF…');
    // Une fois Paged.js exécuté, le document est déjà découpé en boîtes de
    // page avec leurs marges/en-têtes/pieds de page matérialisés dans le DOM
    // (classes .pagedjs_page, .pagedjs_margin-top, etc.). On imprime donc
    // sans marges supplémentaires côté Chromium, en respectant la taille de
    // page définie par le CSS (@page dans le modèle).
    await page.pdf({
      path: pdfPath,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 }
    });
  } finally {
    await browser.close();
  }
}
