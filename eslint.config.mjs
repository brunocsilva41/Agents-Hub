// Lint do repositório inteiro (item 7.2 do GOAL, R12-04).
//
// O motivo de existir é um bug concreto: promessa solta. Em 2026-09-18 o gate
// pré-execução respondia ao hook com uma Promise serializada como `{}` —
// falhando ABERTO — e nenhum compilador reclamou. As regras que pegam isso
// (`no-floating-promises`, `no-misused-promises`, `await-thenable`) só
// funcionam com informação de tipo, por isso o lint roda sobre os programas
// TypeScript de cada pacote e depende do build (`dist/*.d.ts` dos pacotes
// referenciados): `npm run verify` roda build, depois lint, depois testes.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-test/**',
      'dist-pack/**',
      'coverage/**',
      '.claude/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        // Ordem importa: o primeiro projeto que inclui o arquivo vence. Em
        // `packages/web`, `tsconfig.json` (Vite) exclui os testes, que caem
        // no `tsconfig.test.json`; e2e e a config do Playwright ficam no
        // `tsconfig.tools.json`.
        project: [
          './packages/*/tsconfig.json',
          './packages/web/tsconfig.test.json',
          './packages/web/tsconfig.tools.json',
          './tsconfig.scripts.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // `describe`/`it`/`test`/ganchos de `node:test` devolvem Promise,
          // mas quem a espera é o próprio runner — é o uso documentado. O
          // `t.test(...)` de subteste NÃO entra aqui: esse precisa de `await`,
          // e a regra continua cobrando.
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['describe', 'it', 'test', 'suite', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],
      // Desligada de propósito: a correção que ela pede (tirar o `async` de
      // quem não tem `await`) troca rejeição por exceção síncrona — quem faz
      // `f().catch(...)` passa a ver o erro escapar. É a classe de bug que este
      // lint existe para evitar. E os dublês de teste implementam interfaces
      // assíncronas com `async` sem `await`, que é o jeito idiomático.
      '@typescript-eslint/require-await': 'off',
      // Convenção já usada no código: `_` na frente marca descarte deliberado
      // (parâmetro exigido pela assinatura, campo tirado por desestruturação).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Comentário não executa. Os de `scripts/run-tests.mjs` usam espaço de
      // largura zero para escrever `packages/*​/dist` sem fechar o `/** */`.
      'no-irregular-whitespace': ['error', { skipComments: true }],
    },
  },
  {
    // Scripts `.mjs` são JavaScript sem anotação: todo `JSON.parse`, todo
    // `catch (e)` é `any`, e a família `no-unsafe-*` só mediria a falta de
    // anotação, não bug. As regras de promessa continuam valendo — o tipo de
    // retorno de `fetch`, `spawn` etc. o TypeScript infere mesmo em JS.
    files: ['**/*.mjs'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
