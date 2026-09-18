import { execFileSync } from 'node:child_process';
import type { SessionMode } from '@agents-hub/core';

/**
 * Configuração do gate pré-execução do Codex.
 *
 * Tudo aqui saiu de sondagem contra o binário real (0.149.1), não de dedução.
 * O que foi medido, e que decide o desenho deste módulo:
 *
 * ## 1. Hook não confiável FALHA ABERTO
 *
 * Esta é a descoberta que importa. Quando o hook não está confiável, o Codex
 * **não avisa e não bloqueia**: ele simplesmente ignora o hook e executa a
 * ferramenta. Medido três vezes, com três configurações diferentes — em todas,
 * o comando de shell rodou e o hook nunca foi chamado.
 *
 * A consequência é séria para o Hub: configurar o gate e não conseguir
 * torná-lo confiável não resulta num gate fraco, resulta em **gate nenhum**,
 * silenciosamente. Um modo `supervised` que promete prevenção estaria mentindo.
 *
 * Por isso este módulo devolve `garantido: boolean` em vez de só devolver args.
 * Quem chama precisa decidir o que fazer quando a garantia não existe — e a
 * decisão certa em `supervised` é recusar, não seguir sem gate.
 *
 * ## 2. Só a flag de linha de comando liga o hook, hoje
 *
 * Três caminhos foram testados para ligar o hook sem `--dangerously-bypass-hook-trust`:
 *
 * | Caminho | Resultado |
 * |---|---|
 * | `-c bypass_hook_trust=true` | aceito como config, hook NÃO dispara |
 * | `-c hooks.windows_managed_dir="<dir>"` | aceito, hook NÃO dispara |
 * | `--dangerously-bypass-hook-trust` | **funciona** |
 *
 * A confiança "de verdade" vive em `HookStateToml { enabled, trusted_hash }`,
 * gravada pelo TUI numa revisão interativa. O `trusted_hash` é do script, e o
 * algoritmo não está documentado — forjá-lo seria adivinhação, e adivinhar o
 * mecanismo de confiança de outra ferramenta é exatamente o tipo de coisa que
 * quebra em silêncio na próxima versão dela.
 *
 * ## 3. O que a flag realmente dispensa
 *
 * O nome assusta, e vale ser preciso: ela dispensa a **revisão humana do script
 * do hook**, não permissões do agente. O hook do Hub só consegue NEGAR — foi
 * medido que `permissionDecision: "allow"` é rejeitado pelo Codex. Ou seja,
 * este hook não tem como dar ao Codex nenhum poder que ele já não tenha; só
 * tirar.
 *
 * O risco real da flag é outro: se alguém conseguir escrever no caminho do
 * script, o Codex passa a executar o que estiver lá sem revisão. Por isso o
 * script precisa viver dentro da casa do Hub, e não num diretório de projeto
 * onde o próprio agente escreve.
 *
 * ## 4. `codex.cmd` do npm perde aspas aninhadas no `%*`
 *
 * Medido contra o binário real (0.155.0) nesta máquina: a primeira tentativa
 * de ligar o gate falhava sempre com `unexpected argument` — um fragmento
 * truncado de `C:\Program Files\nodejs\node.exe`, partido no meio de um
 * espaço. Isolado com um script que só ecoa `process.argv`: o valor do
 * `-c hooks=...` (que embute dois caminhos entre aspas, porque `Program
 * Files` e o perfil do usuário têm espaço) sobrevive intacto quando o Hub
 * spawna `node.exe` direto, mas se perde quando o alvo é `codex.cmd`.
 *
 * A causa: `codex.cmd`, como todo shim que o npm instala no Windows, é um
 * `.bat` que repassa os argumentos com `%*`. Isso força uma SEGUNDA passada
 * do tokenizer do `cmd.exe` sobre a mesma linha (a primeira é a do
 * `cmd /d /s /c` que o Node já usa para `shell: true`) — e essa segunda
 * passada não tem a leniência do `/S`: todo `"` literal alterna
 * dentro/fora de aspas, sem entender `\"` como escape. Um valor com aspas
 * aninhadas (mesmo corretamente escapado para o parser do PROCESSO final)
 * se parte num espaço que o `cmd.exe` acha que está "fora de aspas".
 *
 * A correção não é escapar mais — é não precisar de aspas: os caminhos que
 * entram no `command` do hook viram o nome curto 8.3 (`C:\PROGRA~1\...`),
 * que não tem espaço, então o valor inteiro passa pelo `%*` sem nenhum `"`
 * embutido. Sem 8.3 habilitado no volume (raro fora de servidor endurecido),
 * `caminhoCurto` devolve o caminho original sem erro — mesmo risco de hoje,
 * não pior.
 */

/** Onde o hook do Hub responde. */
export interface AlvoDoGate {
  /** Comando que o Codex executa a cada chamada de ferramenta. */
  comando: string;
  /** Segundos até o Codex desistir do hook. */
  timeoutSec: number;
}

export interface ConfigDoGate {
  /** Argumentos a acrescentar na invocação do `codex`. */
  args: string[];
  /**
   * `true` só quando o gate está comprovadamente ativo.
   *
   * Nunca presuma. Um gate configurado e não confiável é indistinguível de um
   * gate ausente, do lado de fora.
   */
  garantido: boolean;
  /** O que dizer ao operador quando a garantia não existe. */
  aviso?: string;
}

/** Teto de tempo do hook. Acima disso o Codex desiste — e desistir é falhar aberto. */
export const TIMEOUT_PADRAO_SEC = 20;

const cacheDeCaminhoCurto = new Map<string, string>();

/**
 * Nome curto 8.3 de um caminho do Windows, quando existir — ver achado #4
 * acima para o porquê. Memoizado porque os dois caminhos que importam aqui
 * (binário do Node, entrypoint do hook) são fixos pela vida do processo do
 * daemon, e a resolução spawna um `cmd.exe` auxiliar.
 */
function caminhoCurto(caminho: string): string {
  if (process.platform !== 'win32' || !caminho.includes(' ')) return caminho;

  const cache = cacheDeCaminhoCurto.get(caminho);
  if (cache !== undefined) return cache;

  let resolvido = caminho;
  try {
    const saida = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${caminho}") do @echo %~sI`], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    }).trim();
    if (saida.length > 0 && !saida.includes(' ')) resolvido = saida;
  } catch {
    // 8.3 desabilitado no volume, ou `cmd.exe` indisponível: fica no caminho
    // original — mesmo risco de aspas aninhadas de antes desta correção,
    // não um novo.
  }

  cacheDeCaminhoCurto.set(caminho, resolvido);
  return resolvido;
}

/**
 * Um segmento do comando do hook — entre aspas só quando precisa (o nome
 * curto não tem espaço, então na imensa maioria das vezes não precisa).
 * Aspas sobrando é que quebra o `%*` do `codex.cmd`; sem elas quando não faz
 * falta é a correção, não só estética.
 */
export function segmentoDeComando(caminho: string): string {
  const curto = caminhoCurto(caminho);
  return curto.includes(' ') ? `"${curto}"` : curto;
}

/**
 * Monta a configuração do gate para uma invocação do Codex.
 *
 * `permitirBypassDeConfianca` é decisão de quem chama, e deve refletir uma
 * escolha explícita do usuário — não um padrão herdado. Sem ele, hoje, não há
 * gate; com ele, o Codex executa o script do Hub sem revisão humana.
 */
export function montarConfigDoGate(
  alvo: AlvoDoGate,
  permitirBypassDeConfianca: boolean,
): ConfigDoGate {
  const comando = alvo.comando.trim();
  if (comando.length === 0) {
    return {
      args: [],
      garantido: false,
      aviso: 'comando do hook vazio: o gate não seria configurado e o Codex rodaria sem prevenção',
    };
  }

  // TOML inline. O `-c` do Codex NÃO aceita JSON aqui: passar um objeto JSON
  // devolve `invalid type: string ... expected struct HooksToml`.
  const hooks =
    `hooks={PreToolUse=[{matcher="*",hooks=[` +
    `{type="command",command=${tomlString(comando)},timeoutSec=${alvo.timeoutSec}}` +
    `]}]}`;

  const args = ['-c', hooks];

  if (!permitirBypassDeConfianca) {
    return {
      args,
      garantido: false,
      aviso:
        'o hook do gate foi configurado, mas o Codex só executa hook confiável — e hook não confiável ' +
        'é IGNORADO EM SILÊNCIO, com a ferramenta rodando normalmente. Sem a confiança concedida, ' +
        'esta sessão não tem prevenção. Conceda a confiança no TUI do Codex uma vez, ou autorize o ' +
        'bypass para esta invocação.',
    };
  }

  args.push('--dangerously-bypass-hook-trust');
  return { args, garantido: true };
}

/**
 * O modo da sessão tolera rodar sem gate?
 *
 * `supervised` promete que nada acontece sem passar pela política. Deixar essa
 * promessa de pé sem gate seria pior do que não prometer: o usuário afrouxa a
 * própria vigilância porque confia no modo.
 */
export function modoExigeGate(mode: SessionMode): boolean {
  return mode === 'supervised';
}

/** Escapa uma string para TOML. Aspas duplas e barra invertida são o que importa. */
function tomlString(valor: string): string {
  return `"${valor.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
