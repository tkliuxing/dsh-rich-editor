import { resolve } from 'node:path'
import ts from 'typescript'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * The dsh client packages publish two faces: node halves that export almost
 * nothing, and browser loader bundles (window.__ModuleLoader__.load) that are
 * not importable under Node. Inside the harness repo, tests reach the client
 * APIs through the root tsconfig's `paths` map (vite-tsconfig-paths over
 * tsconfig.base.json); this repo mirrors that by resolving every
 * `@deepseek-ai/*` specifier through the same map of a local harness
 * checkout, so the aliases track the harness rather than a hand-kept list.
 *
 * DSH_CHECKOUT overrides the checkout location (CI pins its own clone).
 */
const harness = process.env.DSH_CHECKOUT ?? resolve(import.meta.dirname, '../deepseek-harness')

/** Resolve `@deepseek-ai/*` through the harness checkout's tsconfig `paths`. */
function harnessPaths(): Plugin {
  const configPath = resolve(harness, 'tsconfig.base.json')
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile)
  if (error !== undefined) throw new Error(`vitest: cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, harness, undefined, configPath)
  const options: ts.CompilerOptions = { ...parsed.options, moduleResolution: ts.ModuleResolutionKind.Bundler }
  // Any file inside the checkout works as the containing file: `paths` is
  // anchored on pathsBasePath, and the node_modules fallback climbs from here.
  const containing = resolve(harness, 'package.json')
  const cache = new Map<string, string | null>()
  return {
    name: 'dsh-harness-paths',
    enforce: 'pre',
    resolveId(source) {
      if (!source.startsWith('@deepseek-ai/')) return null
      const hit = cache.get(source)
      if (hit !== undefined) return hit
      const { resolvedModule } = ts.resolveModuleName(source, containing, options, ts.sys)
      const file = resolvedModule?.resolvedFileName
      // Only TypeScript sources: a `.d.ts` hit means a built node_modules
      // package, which vite resolves on its own.
      const result = file !== undefined && !file.endsWith('.d.ts') && /\.[cm]?tsx?$/.test(file) ? file : null
      cache.set(source, result)
      return result
    },
  }
}

export default defineConfig({
  plugins: [harnessPaths()],
  resolve: {
    // The harness sources resolved above import react (directly and through
    // the CommonJS use-sync-external-store shim) from the checkout's
    // node_modules; one React instance must serve them and the specs.
    dedupe: ['react', 'react-dom', 'use-sync-external-store'],
  },
  test: {
    // Component specs carry their own `// @vitest-environment jsdom` pragma;
    // pure-logic specs run in the default node environment.
    include: ['tests/**/*.spec.{ts,tsx}'],
    // The published dsh client packages are ESM in node_modules; without
    // inlining, Node resolves their bare imports itself and the plugin above
    // never applies. Inlined, vite rewrites every specifier (and neutralizes
    // asset imports like katex's stylesheet).
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
