import MarkdownIt = require('markdown-it');
import katex = require('katex');
import texmath = require('markdown-it-texmath');

/**
 * Compte le nombre de blocs mermaid détectés (pour savoir si on doit
 * injecter le script mermaid.js) et indique si des formules LaTeX ont été
 * rencontrées (pour savoir si on doit injecter la feuille de style KaTeX).
 */
export interface MarkdownRenderResult {
  html: string;
  mermaidBlockCount: number;
  mathUsed: boolean;
  /** Références ![alt](chemin) présentes dans le Markdown mais non reconnues
   *  comme des images valides (typiquement : chemin contenant un espace non
   *  échappé). Utile pour avertir l'utilisateur plutôt que de le laisser
   *  découvrir silencieusement une image manquante dans le PDF. */
  unparsedImages: string[];
}

/**
 * Convertit le contenu Markdown (sans le front matter) en HTML.
 *
 * - Les blocs de code ```mermaid sont transformés en <div class="mermaid">...</div>
 *   afin d'être rendus par mermaid.js côté navigateur (dans la page Puppeteer).
 * - Les formules LaTeX entre `$...$` (en ligne) ou `$$...$$` (bloc) sont
 *   converties directement en HTML/MathML ici, côté serveur, via KaTeX
 *   (contrairement à Mermaid, KaTeX n'a pas besoin d'un navigateur pour
 *   produire son rendu final : le HTML généré est déjà la formule "dessinée").
 */
export function renderMarkdownToHtml(markdownContent: string): MarkdownRenderResult {
  let mermaidBlockCount = 0;

  const md: MarkdownIt = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    breaks: false
  });

  md.use(texmath, {
    engine: katex,
    delimiters: 'dollars', // $...$ en ligne, $$...$$ en bloc
    katexOptions: {
      // N'interrompt pas toute la conversion si une formule est mal
      // formée : KaTeX affiche la formule fautive en rouge à la place.
      throwOnError: false,
      strict: false
    }
  });

  const defaultFenceRenderer =
    md.renderer.rules.fence ||
    function (tokens, idx, options, _env, self) {
      return self.renderToken(tokens, idx, options);
    };

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const info = token.info.trim().toLowerCase();

    if (info === 'mermaid') {
      mermaidBlockCount += 1;
      // Le contenu brut du diagramme est réinjecté tel quel : mermaid.js
      // se charge de le parser côté client. On échappe uniquement les
      // caractères qui casseraient le HTML englobant.
      const escaped = md.utils.escapeHtml(token.content);
      return `<div class="mermaid">\n${escaped}</div>\n`;
    }

    return defaultFenceRenderer(tokens, idx, options, env, self);
  };

  // Les chemins RELATIFS (ex: ./images/logo.png) sont déjà résolus par la
  // balise <base href> injectée dans le document final (voir converter.ts).
  // En revanche, un chemin ABSOLU écrit "à la Windows" (D:\Dossier\image.png)
  // ou en UNC (\\serveur\partage\image.png) n'est pas une URL valide pour un
  // navigateur tel quel : il faut le convertir en URL file:// (antislashs
  // remplacés par des slashs, espaces/accents encodés).
  //
  // IMPORTANT : cette conversion doit intervenir dans `md.normalizeLink`,
  // PAS dans un `renderer.rules.image` personnalisé. markdown-it appelle
  // déjà `state.md.normalizeLink(href)` au moment du PARSING (avant le
  // rendu), qui encode par défaut le antislash en "%5C" (un antislash
  // encodé n'est PAS un séparateur de chemin) : à l'étape du rendu, la
  // valeur est donc déjà corrompue et il est trop tard pour la corriger.
  // markdown-it interdit par défaut le schéma "file:" dans validateLink()
  // (avec "javascript:" et "vbscript:", pour des raisons de sécurité
  // générales, pertinentes pour du contenu web non fiable). Ici, ce sont
  // justement des URL file:// que l'on génère nous-mêmes pour les images
  // locales référencées en chemin absolu : il faut donc les autoriser
  // explicitement, sans quoi normalizeLink() ci-dessus produit une URL
  // correcte... que validateLink() rejette juste après, faisant échouer
  // silencieusement tout le parsing de l'image.
  const defaultValidateLink = md.validateLink.bind(md);
  md.validateLink = (url: string): boolean => {
    if (/^file:/i.test(url.trim())) {
      return true;
    }
    return defaultValidateLink(url);
  };

  const defaultNormalizeLink = md.normalizeLink.bind(md);
  md.normalizeLink = (url: string): string => {
    const localFileUrl = tryConvertLocalAbsolutePathToFileUrl(url);
    return localFileUrl ?? defaultNormalizeLink(url);
  };

  const html = md.render(markdownContent);
  const mathUsed = html.includes('class="katex"');
  const unparsedImages = findUnparsedImageReferences(markdownContent, html, md);

  return { html, mermaidBlockCount, mathUsed, unparsedImages };
}

/**
 * Détecte les références d'image `![alt](destination)` du Markdown source
 * qui n'ont PAS été converties en balise <img> par markdown-it — typiquement
 * parce que leur destination contient un espace non échappé, ce que la
 * syntaxe Markdown (CommonMark) interdit en dehors de `< >` ou d'un titre
 * entre guillemets. Sans cette détection, l'image manquante passe
 * silencieusement inaperçue : l'utilisateur ne voit qu'un PDF sans image,
 * sans comprendre pourquoi.
 */
function findUnparsedImageReferences(markdownContent: string, html: string, md: MarkdownIt): string[] {
  const imageSyntaxPattern = /!\[[^\]]*\]\([^)]*\)/g;
  const candidates = markdownContent.match(imageSyntaxPattern) || [];
  const unparsed: string[] = [];

  for (const raw of candidates) {
    // Si markdown-it a bien reconnu l'image, ce texte brut n'apparaît plus
    // tel quel dans le HTML généré (il a été remplacé par une balise <img>).
    // S'il y est toujours (sous sa forme échappée en HTML), c'est qu'il n'a
    // pas été interprété comme une image valide.
    const stillPresentAsText = html.includes(md.utils.escapeHtml(raw));
    if (stillPresentAsText) {
      unparsed.push(raw);
    }
  }

  return unparsed;
}

/**
 * Si `url` ressemble à un chemin de fichier local ABSOLU (Windows, UNC, ou
 * Unix/macOS), le convertit en une URL `file://` valide et directement
 * utilisable dans un attribut `src`. Retourne `undefined` pour tout le
 * reste (chemin relatif, URL http(s)/data/mailto déjà valide...), afin de
 * laisser markdown-it appliquer son traitement standard sur ces cas-là.
 */
function tryConvertLocalAbsolutePathToFileUrl(url: string): string | undefined {
  const trimmed = url.trim();

  // Chemin UNC : \\serveur\partage\image.png -> file://serveur/partage/image.png
  //
  // ATTENTION : dans la syntaxe Markdown, un antislash suivi d'un autre
  // antislash est une séquence d'échappement standard ("\\" -> "\"). Un
  // chemin UNC tapé "\\serveur\partage\..." arrive donc ICI déjà réduit à
  // "\serveur\partage\..." (un seul antislash en tête) par l'étape de
  // parsing qui précède normalizeLink — d'où la détection sur un seul
  // antislash, et non deux.
  if (/^\\/.test(trimmed) && !/^[a-zA-Z]:/.test(trimmed)) {
    const withSlashes = trimmed.replace(/\\/g, '/');
    return encodeURI(`file:/${withSlashes}`);
  }

  // Chemin Windows absolu : D:\Dossier\image.png ou D:/Dossier/image.png
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    const withSlashes = trimmed.replace(/\\/g, '/');
    return encodeURI(`file:///${withSlashes}`);
  }

  // Chemin absolu Unix/macOS : /Dossier/image.png -> file:///Dossier/image.png
  // (mais pas "//" en tête, qui serait une URL protocol-relative http(s))
  if (/^\//.test(trimmed) && !/^\/\//.test(trimmed)) {
    return encodeURI(`file://${trimmed}`);
  }

  return undefined;
}
