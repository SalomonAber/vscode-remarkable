const esbuild = require("esbuild");
const fs = require("fs/promises");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	const media = await esbuild.context({
		entryPoints: ['media/preview.ts'], bundle: true, format: 'iife', platform: 'browser',
		minify: production, sourcemap: false, outfile: 'media/preview.js', logLevel: 'silent',
	});
	const copyWorker = () => fs.mkdir('media/pdfjs', { recursive: true }).then(() => fs.copyFile('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'media/pdfjs/pdf.worker.mjs'));
	if (watch) {
		await ctx.watch();
		await media.watch();
		await copyWorker();
	} else {
		await ctx.rebuild();
		await media.rebuild();
		await copyWorker();
		await ctx.dispose();
		await media.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
