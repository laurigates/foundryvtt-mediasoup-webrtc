import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

/**
 * Rollup configuration for test builds
 * Creates a lightweight version that excludes mediasoup-client for browser stability
 */
export default {
    input: 'src/mediasoup-vtt-test.js',
    output: {
        file: 'dist/mediasoup-vtt-test.js',
        format: 'es',
        sourcemap: true,
    },
    plugins: [
        resolve({
            browser: true,
            preferBuiltins: false,
        }),
        // Only minify in production test builds
        ...(process.env.NODE_ENV === 'production' ? [terser()] : []),
    ],
    external: ['mediasoup-client'], // Keep mediasoup-client external for test builds
    onwarn: (warning, warn) => {
        // Suppress circular dependency warnings
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        warn(warning);
    },
};
