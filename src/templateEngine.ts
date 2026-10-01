import * as fs from 'fs';
import * as path from 'path';

/**
 * Représente un modèle résolu : le HTML du modèle, le dossier qui le contient
 * (pour résoudre le CSS et les assets relatifs) et le contenu CSS associé.
 */
export interface ResolvedTemplate {
  name: string;
  dir: string;
  html: string;
  css: string;
}

/**
 * Recherche un modèle par nom en suivant l'ordre de priorité :
 *   1. <workspace>/<templatesFolder>/<name>/template.html   (modèle du projet)
 *   2. <extensionPath>/templates/<name>/template.html        (modèle fourni avec l'extension)
 *   3. <extensionPath>/templates/default/template.html       (repli ultime)
 */
export function resolveTemplate(
  templateName: string,
  workspaceTemplatesDir: string | undefined,
  extensionTemplatesDir: string
): ResolvedTemplate {
  const candidates: string[] = [];

  if (workspaceTemplatesDir) {
    candidates.push(path.join(workspaceTemplatesDir, templateName));
  }
  candidates.push(path.join(extensionTemplatesDir, templateName));
  candidates.push(path.join(extensionTemplatesDir, 'default'));

  for (const dir of candidates) {
    const htmlPath = path.join(dir, 'template.html');
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      const cssPath = path.join(dir, 'style.css');
      const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf-8') : '';
      return { name: templateName, dir, html, css };
    }
  }

  throw new Error(
    `Aucun modèle trouvé pour "${templateName}" et aucun modèle par défaut n'est disponible ` +
      `(recherché dans : ${candidates.join(', ')}).`
  );
}

export type EscapeMode = 'html' | 'css' | 'none';

/**
 * Moteur de rendu de type "mustache simplifié".
 *
 * Balises supportées :
 *   {{cle}}                -> valeur, échappée selon `escapeMode` (sauf {{{cle}}})
 *   {{{cle}}}               -> valeur brute NON échappée (pour insérer du HTML, ex: {{{content}}})
 *   {{#si cle}} ... {{/si}} -> bloc conditionnel affiché seulement si "cle" est une valeur "truthy"
 *   {{#chacun cle}} ... {{/chacun}} -> répétition sur un tableau, avec {{.}} pour l'élément courant
 *
 * `escapeMode` contrôle comment {{cle}} échappe la valeur :
 *   - 'html' (défaut) : échappement HTML (&amp; &lt; ...), pour un modèle .html
 *   - 'css'            : échappement pour une valeur CSS entre guillemets
 *                        (utile pour insérer un champ du front matter dans
 *                        un `content: "{{auteur}}";` d'une règle @page)
 *   - 'none'           : aucun échappement
 */
export function renderTemplate(
  template: string,
  data: Record<string, unknown>,
  escapeMode: EscapeMode = 'html'
): string {
  let output = template;
  const escape = escapeMode === 'css' ? escapeCss : escapeMode === 'none' ? (s: string) => s : escapeHtml;

  // 1) Blocs #chacun ... /chacun (boucles sur tableaux)
  output = output.replace(
    /\{\{#chacun\s+([\w.]+)\}\}([\s\S]*?)\{\{\/chacun\}\}/g,
    (_match, key: string, inner: string) => {
      const value = getValue(data, key);
      if (!Array.isArray(value)) {
        return '';
      }
      return value.map((item) => inner.replace(/\{\{\.\}\}/g, escape(String(item)))).join('');
    }
  );

  // 2) Blocs #si ... /si (affichage conditionnel)
  output = output.replace(
    /\{\{#si\s+([\w.]+)\}\}([\s\S]*?)\{\{\/si\}\}/g,
    (_match, key: string, inner: string) => {
      const value = getValue(data, key);
      return isTruthy(value) ? inner : '';
    }
  );

  // 3) Triple accolade : insertion brute, jamais échappée
  output = output.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_match, key: string) => {
    const value = getValue(data, key);
    return value === undefined || value === null ? '' : String(value);
  });

  // 4) Double accolade : insertion échappée selon escapeMode
  output = output.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = getValue(data, key);
    return value === undefined || value === null ? '' : escape(String(value));
  });

  return output;
}

function getValue(data: Record<string, unknown>, dottedKey: string): unknown {
  return dottedKey
    .split('.')
    .reduce<unknown>(
      (acc, part) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined,
      data
    );
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return Boolean(value);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Échappement pour une valeur destinée à être insérée dans une chaîne CSS
 * entre guillemets (ex: `content: "{{auteur}}";`). Contrairement à l'échappement
 * HTML, il ne faut PAS convertir & < > en entités : ces caractères n'ont
 * aucune signification spéciale en CSS et seraient affichés tels quels
 * (littéralement "&amp;") dans le PDF si on les échappait comme du HTML.
 * Seuls le guillemet double et l'antislash doivent être neutralisés, et les
 * retours à la ligne supprimés (une valeur de front matter est censée tenir
 * sur une ligne).
 */
function escapeCss(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}
