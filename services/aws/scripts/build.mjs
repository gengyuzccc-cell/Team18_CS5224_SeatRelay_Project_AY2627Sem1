// Bundles each Lambda handler into dist/<fn>/index.mjs (plan §2.4: own esbuild script instead of
// `sam build` so that pnpm workspace packages resolve and no temp-dir npm install happens).
import { build } from 'esbuild';
import { rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const functions = ['api', 'worker', 'expiryForwarder', 'sweep', 'notifier'];

rmSync(resolve(pkg, 'dist'), { recursive: true, force: true });

await Promise.all(
  functions.map((fn) =>
    build({
      entryPoints: [resolve(pkg, `src/handlers/${fn}.ts`)],
      outfile: resolve(pkg, `dist/${fn}/index.mjs`),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      external: ['@aws-sdk/*'], // provided by the Lambda nodejs22.x runtime
      sourcemap: true,
      minify: false,
      treeShaking: true,
      legalComments: 'none',
      mainFields: ['module', 'main'],
      conditions: ['module', 'import', 'node'],
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logLevel: 'warning',
    }),
  ),
);

for (const fn of functions) {
  const size = statSync(resolve(pkg, `dist/${fn}/index.mjs`)).size;
  console.log(`built dist/${fn}/index.mjs (${(size / 1024).toFixed(0)} KiB)`);
}
