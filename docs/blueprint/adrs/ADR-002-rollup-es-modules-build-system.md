---
id: ADR-002
title: Rollup and ES Modules Build System
status: accepted
created: 2026-03-05
---

# ADR-002: Rollup and ES Modules Build System

## Context

The FoundryVTT client module is authored in JavaScript and depends on the
`mediasoup-client` npm package. FoundryVTT modules are loaded by the browser
as static files from the FoundryVTT data directory; there is no server-side
bundling step at runtime.

Two questions needed an answer:

1. **Module format**: FoundryVTT v10+ supports native ES modules (`type: module`
   in `module.json`). Older CommonJS or IIFE bundles are possible but bypass
   native browser module caching and tree-shaking.
2. **Bundler choice**: The build tool must be able to resolve npm dependencies
   (i.e., `mediasoup-client` and its transitive deps), emit a single-file ES
   module, handle asset copying (styles, lang, templates), and generate
   `module.json` from a template.

Alternatives considered:

| Tool       | Notes                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Rollup** | Designed for ES module libraries; excellent tree-shaking; plugin ecosystem covers CommonJS interop, node resolution, and minification. |
| Webpack    | Mature; more configuration overhead; historically targets CommonJS/browser bundles rather than ES modules natively.                    |
| Vite       | Rollup-based under the hood; adds a dev server that is unnecessary for a FoundryVTT module workflow.                                   |
| esbuild    | Extremely fast; less mature plugin ecosystem for the template-processing and asset-copy requirements.                                  |

## Decision

Use **Rollup** with the **ES module output format** (`format: 'es'`) as the
build system.

The `rollup.config.js` configuration:

- **Entry**: `src/mediasoup-vtt.js`
- **Output**: `dist/mediasoup-vtt.js` as a single ES module
- **Plugins**:
    - `@rollup/plugin-node-resolve` - resolves npm packages from `node_modules`
    - `@rollup/plugin-commonjs` - converts CommonJS dependencies to ES module
      syntax (required for parts of `mediasoup-client` dependency tree)
    - `@rollup/plugin-terser` - minifies and mangles the production bundle
      while preserving class and function names (important for FoundryVTT hook
      reflection)
    - `copy-assets` (custom inline plugin) - copies `styles/`, `lang/`, and
      `templates/` directories into `dist/`
    - `template-plugin` (custom inline plugin) - processes
      `module.json.template` into `dist/module.json` at bundle time
- **Source maps**: emitted in development mode; omitted in production
- `mediasoup-client` is **bundled** (not treated as external) so that the
  single `dist/mediasoup-vtt.js` file is self-contained and installable
  without a separate CDN step

npm scripts layer on top:

```
npm run dev       # rollup --watch (incremental rebuilds)
npm run build     # NODE_ENV=production rollup -c
npm run lint      # eslint src/**/*.js
npm run lint:fix  # eslint src/**/*.js --fix
npm run package   # build + zip dist/ for distribution
npm test          # playwright test (integration suite)
```

## Consequences

### Positive

- Single output file simplifies installation: copy `dist/` to the FoundryVTT
  modules directory or zip and distribute via the manifest URL.
- ES module output aligns with FoundryVTT v10+ native module loading and
  enables browser-level tree-shaking for unused code.
- Rollup's tree-shaking removes unused exports from `mediasoup-client`,
  keeping the bundle lean.
- The `terser` plugin with `keep_classnames`/`keep_fnames` ensures FoundryVTT
  hook introspection (which relies on function names) continues to work in
  production builds.
- Source maps in development mode make browser debugging straightforward.
- Custom inline plugins keep the build self-contained without extra tooling.

### Negative

- `@rollup/plugin-commonjs` is required because parts of the
  `mediasoup-client` dependency tree use CommonJS; this adds a conversion
  step and can occasionally produce subtle interop issues.
- Bundling `mediasoup-client` increases the output file size compared to
  loading it externally; however, this avoids a runtime CDN dependency.
- The custom template-plugin couples `module.json` generation to the Rollup
  build step -- contributors must run `npm run build` (or
  `npm run process-template`) rather than editing `module.json` directly.
- ESLint 8.x is pinned; upgrading to ESLint 9 (flat config) will require
  configuration migration.
