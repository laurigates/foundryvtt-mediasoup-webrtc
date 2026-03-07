import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

const require = createRequire(import.meta.url);
const isProduction = process.env.NODE_ENV === 'production';

// Copy assets plugin
function copyAssetsPlugin() {
    function copyRecursive(src, dest) {
        try {
            const stat = statSync(src);
            if (stat.isDirectory()) {
                mkdirSync(dest, { recursive: true });
                const items = readdirSync(src);
                for (const item of items) {
                    copyRecursive(join(src, item), join(dest, item));
                }
            } else {
                mkdirSync(dirname(dest), { recursive: true });
                copyFileSync(src, dest);
            }
        } catch (error) {
            console.error(`Error copying ${src} to ${dest}:`, error);
        }
    }

    return {
        name: 'copy-assets',
        buildStart() {
            // Copy static assets to dist/
            const assetDirs = ['styles', 'lang', 'templates'];
            for (const dir of assetDirs) {
                copyRecursive(dir, join('dist', dir));
            }

            // Copy README.md
            try {
                copyFileSync('README.md', 'dist/README.md');
            } catch (error) {
                console.error('Error copying README.md:', error);
            }
        },
    };
}

// Template processing plugin
function templatePlugin() {
    return {
        name: 'template-plugin',
        async generateBundle() {
            try {
                const { processTemplateToString } = require('./scripts/process-template.cjs');
                const moduleJsonContent = processTemplateToString();

                // Emit the processed module.json
                this.emitFile({
                    type: 'asset',
                    fileName: 'module.json',
                    source: moduleJsonContent,
                });
            } catch (error) {
                console.error('Error processing template:', error);
            }
        },
    };
}

export default {
    input: 'src/mediasoup-vtt.js',
    output: {
        file: 'dist/mediasoup-vtt.js',
        format: 'es',
        sourcemap: !isProduction,
    },
    plugins: [
        copyAssetsPlugin(),
        nodeResolve(),
        commonjs(),
        templatePlugin(),
        isProduction &&
            terser({
                keep_classnames: true,
                keep_fnames: true,
            }),
    ].filter(Boolean),
    // Bundle mediasoup-client instead of treating it as external
    // external: ['mediasoup-client']
};
