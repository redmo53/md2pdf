/**
 * markdown-it-texmath ne fournit pas de déclarations TypeScript.
 * Déclaration minimale pour satisfaire le compilateur : le plugin est un
 * plugin markdown-it standard, utilisé ici uniquement via `md.use(texmath, options)`.
 */
declare module 'markdown-it-texmath' {
  import type MarkdownIt from 'markdown-it';

  interface TexmathOptions {
    engine: unknown;
    delimiters?: string | string[];
    katexOptions?: Record<string, unknown>;
  }

  function texmath(md: MarkdownIt, options?: TexmathOptions): void;

  export = texmath;
}
