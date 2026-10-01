# Changelog

## Non publié

- Support des chemins d'image ABSOLUS (Windows `D:\...`, UNC `\\serveur\...`,
  Unix `/...`) : convertis automatiquement en URL `file://` valides
  (auparavant, seuls les chemins relatifs fonctionnaient).
- Avertissement automatique après conversion si une image référencée dans
  le Markdown n'a pas pu être reconnue par la syntaxe (typiquement : chemin
  absolu contenant un espace, non encadré par `< >`), avec le détail des
  références concernées.
- Correction : markdown-it bloque par défaut le schéma `file:` dans les
  liens/images (`validateLink`) ; il est maintenant explicitement autorisé
  pour permettre l'intégration d'images locales en chemin absolu.

- Formules mathématiques LaTeX (`$...$` en ligne, `$$...$$` en bloc), rendues
  côté serveur par KaTeX via `markdown-it-texmath`. La feuille de style
  KaTeX n'est chargée que si le document contient effectivement des formules.
- Insertion de champs du front matter directement dans le CSS des modèles
  (ex: `content: "{{auteur}}";` dans une règle `@page`).
- Correction : les chemins relatifs (images) référencés dans le Markdown se
  résolvent maintenant correctement via une balise `<base href>`.
- Correction : ordre des scripts Paged.js (window.PagedConfig doit être
  défini avant le chargement de paged.polyfill.js).
- Correction : contournement du champ `exports` restrictif de `pagedjs`
  lors de la résolution du chemin de `paged.polyfill.js`.
- Ajout de `print-color-adjust: exact` dans les modèles fournis, pour un
  rendu fidèle des couleurs de fond et des bordures de tableau à l'impression.

## 0.1.0

- Première version.
- Commande, raccourci clavier et bouton de barre d'outils pour convertir un
  fichier Markdown en PDF.
- Lecture du front matter et résolution de modèle (`template` du front
  matter > modèle par défaut de configuration > modèle `default`).
- Moteur de modèle HTML (`{{champ}}`, `{{{content}}}`, `{{#si}}`, `{{#chacun}}`).
- Rendu des diagrammes Mermaid.js dans le PDF final.
- Pagination CSS via Paged.js : marges, en-têtes et pieds de page pilotés en
  CSS (`@page`, `@top-center`, `string-set`, pages nommées).
- Deux modèles fournis : `default` et `rapport` (page de garde).
- Paramètre `chromiumExecutablePath` pour utiliser un Chrome existant.
