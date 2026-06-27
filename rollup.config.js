/**
 * Rollup 构建配置 —— 统一三模块打包
 *
 * 输出：
 *  - plugin/index.js  : IIFE 格式，SillyTavern 浏览器端加载
 *  - dist/             : ESM 格式，供外部引用
 */

import typescript from '@rollup/plugin-typescript';

const production = !process.env.ROLLUP_WATCH;

export default [
  // ── SillyTavern 插件输出 ──────────────────
  {
    input: 'src/bootstrap.ts',
    output: {
      file: 'plugin/index.js',
      format: 'iife',
      name: 'TavernDirector',
      sourcemap: !production,
    },
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
        declarationMap: false,
      }),
    ],
  },

  // ── ESM 库输出 ────────────────────────────
  {
    input: 'src/index.ts',
    output: {
      dir: 'dist',
      format: 'esm',
      sourcemap: true,
      preserveModules: true,
      preserveModulesRoot: 'src',
    },
    plugins: [
      typescript({ tsconfig: './tsconfig.json' }),
    ],
  },
];
