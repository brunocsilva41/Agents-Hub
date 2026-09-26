#!/usr/bin/env node
/**
 * Monta o pacote distribuível `agents-hub-<versão>.tgz`.
 *
 * Uso:  npm run build && npm run pack:dist [-- --out <pasta>]
 * Instalação:  npm i -g ./dist-pack/agents-hub-<versão>.tgz   (depois: hub doctor)
 *
 * Por que um pacote montado, e não `npm pack` do monorepo: os pacotes do
 * workspace (`@agents-hub/*`) são `private` e se enxergam por symlink em
 * `node_modules`. Um tarball precisa carregar tudo junto. O layout gerado é:
 *
 *   agents-hub/
 *     package.json            bin: hub, agents-hub-mcp; license: UNLICENSED
 *     bin/hub.js              -> node_modules/@agents-hub/cli/dist/bin.js
 *     bin/agents-hub-mcp.js   -> node_modules/@agents-hub/mcp/dist/main.js
 *     manifests/              os manifestos dos agentes
 *     web/                    o painel (build do Vite)
 *     node_modules/@agents-hub/<pacote>/{package.json,dist}   (bundleDependencies)
 *     node_modules/<terceiros>                                 zod, yaml, SDK do MCP e dependências
 *
 * Tudo vai DENTRO do tarball: `npm i -g` dele não precisa de registry. O
 * daemon acha `manifests/` e `web/` pela raiz da instalação
 * (`installRoot()` em `packages/daemon/src/config.ts`), e hook/MCP gravados
 * nas configs dos agentes apontam para dentro da instalação global — não para
 * o clone.
 *
 * Exportada como função para `scripts/test-install.mjs` reusar.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RAIZ_DO_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pacotes que vão no tarball (a Web UI vai como estáticos em `web/`). */
const PACOTES = ['core', 'store', 'adapters', 'client', 'daemon', 'mcp', 'cli'];

function lerJson(arquivo) {
  return JSON.parse(readFileSync(arquivo, 'utf8'));
}

/**
 * Como chamar o npm sem shell. `npm` no Windows é `npm.cmd`, que o Node 24 só
 * executa com `shell: true` — e com shell, caminho com espaço ("Bruno Silva")
 * precisa de quoting manual. Rodar o `npm-cli.js` com o próprio Node evita as
 * duas coisas.
 */
export function comandoNpm() {
  const candidatos = [
    process.env['npm_execpath'],
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidatos) {
    if (c && c.endsWith('.js') && existsSync(c)) return { cmd: process.execPath, prefixo: [c] };
  }
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefixo: [], shell: process.platform === 'win32' };
}

export function npm(args, opcoes = {}) {
  const { cmd, prefixo, shell } = comandoNpm();
  const r = spawnSync(cmd, [...prefixo, ...args], {
    encoding: 'utf8',
    shell: shell ?? false,
    ...opcoes,
  });
  if (r.error) throw r.error;
  return r;
}

/** Copia `dist/` sem testes, mapas e tipos — nada disso roda na máquina do usuário. */
function copiarDist(origem, destino) {
  cpSync(origem, destino, {
    recursive: true,
    filter: (arquivo) => {
      if (statSync(arquivo).isDirectory()) return true;
      const nome = path.basename(arquivo);
      if (/\.test\.(js|d\.ts)$/.test(nome)) return false;
      if (nome.endsWith('.map') || nome.endsWith('.d.ts') || nome.endsWith('.tsbuildinfo')) return false;
      return true;
    },
  });
}

function exigirBuild() {
  const faltando = [];
  for (const p of PACOTES) {
    if (!existsSync(path.join(RAIZ_DO_REPO, 'packages', p, 'dist', 'index.js'))) faltando.push(`packages/${p}/dist`);
  }
  if (!existsSync(path.join(RAIZ_DO_REPO, 'packages', 'web', 'dist', 'index.html'))) faltando.push('packages/web/dist');
  if (faltando.length > 0) {
    throw new Error(`build ausente (${faltando.join(', ')}). Rode antes: npm run build`);
  }
}

/**
 * Monta o diretório do pacote em `<saida>/agents-hub` e roda `npm pack` nele.
 * Devolve o caminho do `.tgz`.
 */
export function empacotar({ saida = path.join(RAIZ_DO_REPO, 'dist-pack') } = {}) {
  exigirBuild();
  const raiz = lerJson(path.join(RAIZ_DO_REPO, 'package.json'));
  const versao = raiz.version;
  const staging = path.join(saida, 'agents-hub');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // Primeiro as dependências de terceiros, instaladas de verdade no staging:
  // o tarball as leva DENTRO (bundleDependencies), e a instalação não depende
  // de registry nem de rede. Não é só conveniência — com só os pacotes internos
  // no bundle, o `npm pack` marca as dependências deles (zod, yaml, SDK do MCP)
  // como "do bundle" sem incluí-las, e o `npm i -g` cria pastas VAZIAS no
  // lugar delas (visto: ERR_MODULE_NOT_FOUND de zod no primeiro `hub help`).
  const pkgs = PACOTES.map((p) => ({ p, pkg: lerJson(path.join(RAIZ_DO_REPO, 'packages', p, 'package.json')) }));
  const externas = {};
  for (const { pkg } of pkgs) {
    for (const [dep, faixa] of Object.entries(pkg.dependencies ?? {})) {
      if (dep.startsWith('@agents-hub/')) continue;
      externas[dep] = raiz.dependencies?.[dep] ?? faixa;
    }
  }
  writeFileSync(
    path.join(staging, 'package.json'),
    `${JSON.stringify({ name: 'agents-hub-staging', private: true, dependencies: externas }, null, 2)}
`,
  );
  const inst = npm(
    ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'],
    { cwd: staging },
  );
  if (inst.status !== 0) throw new Error(`npm install das dependências falhou (${inst.status}):
${inst.stderr}`);

  // Depois os pacotes do workspace — DEPOIS do install, que apagaria o que não
  // está no package.json provisório.
  const internas = {};
  for (const { p, pkg } of pkgs) {
    const origem = path.join(RAIZ_DO_REPO, 'packages', p);
    const destino = path.join(staging, 'node_modules', ...pkg.name.split('/'));
    mkdirSync(destino, { recursive: true });
    copiarDist(path.join(origem, 'dist'), path.join(destino, 'dist'));
    internas[pkg.name] = versao;
    // Sem `bin` (os bins públicos são os do pacote raiz), sem devDependencies
    // (o `@agents-hub/daemon` do MCP é só de teste). Versão alinhada à do pacote.
    const { bin: _bin, devDependencies: _dev, scripts: _scripts, ...resto } = pkg;
    const deps = Object.fromEntries(
      Object.entries(pkg.dependencies ?? {}).map(([d, f]) => [d, d.startsWith('@agents-hub/') ? versao : f]),
    );
    writeFileSync(
      path.join(destino, 'package.json'),
      `${JSON.stringify({ ...resto, version: versao, dependencies: deps }, null, 2)}
`,
    );
  }

  cpSync(path.join(RAIZ_DO_REPO, 'manifests'), path.join(staging, 'manifests'), { recursive: true });
  cpSync(path.join(RAIZ_DO_REPO, 'packages', 'web', 'dist'), path.join(staging, 'web'), { recursive: true });
  cpSync(path.join(RAIZ_DO_REPO, 'README.md'), path.join(staging, 'README.md'));

  mkdirSync(path.join(staging, 'bin'), { recursive: true });
  writeFileSync(
    path.join(staging, 'bin', 'hub.js'),
    "#!/usr/bin/env node\nimport '../node_modules/@agents-hub/cli/dist/bin.js';\n",
  );
  writeFileSync(
    path.join(staging, 'bin', 'agents-hub-mcp.js'),
    "#!/usr/bin/env node\nimport '../node_modules/@agents-hub/mcp/dist/main.js';\n",
  );

  const manifesto = {
    name: 'agents-hub',
    version: versao,
    description: raiz.description,
    // TODO(licença): decisão do dono do projeto. Até lá, sem licença de uso
    // concedida — e `private` impede um `npm publish` acidental.
    license: 'UNLICENSED',
    private: true,
    type: 'module',
    engines: raiz.engines,
    bin: { hub: 'bin/hub.js', 'agents-hub-mcp': 'bin/agents-hub-mcp.js' },
    files: ['bin', 'manifests', 'web', 'README.md'],
    dependencies: { ...internas, ...externas },
    bundleDependencies: [...Object.keys(internas), ...Object.keys(externas)],
  };
  writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(manifesto, null, 2)}\n`);

  const r = npm(['pack', '--json', '--pack-destination', saida], { cwd: staging });
  if (r.status !== 0) {
    throw new Error(`npm pack falhou (${r.status}):\n${r.stderr}`);
  }
  const [info] = JSON.parse(r.stdout);
  const tgz = path.join(saida, info.filename);
  if (!existsSync(tgz)) throw new Error(`npm pack não gerou ${tgz}`);
  const noTarball = new Set(info.files.map((f) => f.path));
  for (const obrigatorio of [
    'bin/hub.js',
    'manifests/claude.yaml',
    'web/index.html',
    'node_modules/@agents-hub/cli/dist/bin.js',
    'node_modules/@agents-hub/daemon/dist/config.js',
    'node_modules/@agents-hub/mcp/dist/main.js',
  ]) {
    if (!noTarball.has(obrigatorio)) throw new Error(`tarball sem ${obrigatorio}`);
  }
  return { tgz, versao, arquivos: info.files.length, bytes: info.size };
}

// Executado direto (não importado): monta e diz onde ficou.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--out');
  const saida = i > 0 ? path.resolve(process.argv[i + 1] ?? '') : undefined;
  try {
    const r = empacotar(saida ? { saida } : {});
    console.log(`${r.tgz}  (${r.arquivos} arquivos, ${(r.bytes / 1024).toFixed(0)} KiB)`);
    console.log(`instale com: npm i -g "${r.tgz}"`);
  } catch (err) {
    console.error(`pack-dist: ${err.message}`);
    process.exitCode = 1;
  }
}

