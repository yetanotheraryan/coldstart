import { defineConfig } from "tsup";

export default defineConfig({
    format: ['cjs', 'esm'],
    entry: {
        index: './src/index.ts',
        register: './register.ts',
        cli: './src/cli.ts',
        'esm-loader': './src/esm-loader.ts',
    },
    dts: true,
    shims: true,
    skipNodeModulesBundle: true,
    clean: true,
});
