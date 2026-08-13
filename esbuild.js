const esbuild = require('esbuild');

async function main() {
  await esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode', 'cpu-features', 'ssh2'],
    sourcemap: true,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});