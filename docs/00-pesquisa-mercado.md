# 00 — Pesquisa de Mercado: Agentes de Código e Protocolos de Interop (ago/2026)

> Levantamento feito em 2026-08-26 para embasar o desenho do Agents-Hub.

## 1. Camadas de protocolo (o consenso do mercado)

| Protocolo | Conecta | Transporte | Estado |
|---|---|---|---|
| **MCP** (Model Context Protocol) | agente → ferramentas/dados | stdio (local), HTTP+SSE (remoto) | de-facto; 10k+ servers públicos; suportado por Claude Code, Codex, Cursor, Copilot, Gemini/Antigravity, OpenCode, Kimi Code |
| **ACP** (Agent Client Protocol, Zed, ago/2025) | editor → agente | stdin/stdout (JSON-RPC) | 25+ agentes; Zed, JetBrains, Neovim, Emacs |
| **A2A** (Agent2Agent, Google → Linux Foundation) | agente ↔ agente (peers) | JSON-RPC 2.0 / gRPC / HTTP+JSON, SSE + webhooks | v1.0 estável (2026), 150+ orgs, TSC com AWS/Cisco/Google/IBM/MSFT/Salesforce/SAP/ServiceNow |

**Implicação para o Hub:** MCP para dar ferramentas aos agentes, A2A para agente-chama-agente entre vendors, ACP opcional para plugar o Hub dentro de editores.

### A2A — detalhes que importam para o desenho
- **Agent Card** publicado em `/.well-known/agent-card.json`: skills, MIME types, bindings de transporte, security schemes. v1.0 suporta **Signed Agent Cards**.
- **Ciclo de vida de Task (8 estados):** `submitted → working → input_required | auth_required → completed | failed | canceled | rejected`.
- **Métodos de controle:** `tasks/get` (polling), `tasks/cancel`, `tasks/resubscribe` (re-attach ao SSE após queda).
- **Streaming:** SSE começa com snapshot de `Task`, seguido de `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`, fecha em estado terminal.

## 2. Matriz de agentes (superfícies programáveis)

| Agente | Binário | Headless / one-shot | Saída estruturada | Sessão / resume | MCP | Observações |
|---|---|---|---|---|---|---|
| **Claude Code** | `claude` | `claude -p "<prompt>"` | `--output-format stream-json` | `--resume <id>`, `--continue` | cliente + servidor | Agent SDK, 30 hook events, subagents com modelo por agente, 1M ctx |
| **OpenAI Codex** | `codex` | `codex exec "<prompt>"` | `codex exec --json` (JSONL: `thread.started`, `turn.*`, `item.*`) | `codex exec resume --last` / por UUID/nome | cliente + **`codex mcp` (server JSON-RPC em stdio)** | config global `~/.codex/config.toml`; continuidade CLI/cloud/app |
| **Cursor** | `cursor-agent` | `-p` / `--print` | `--output-format json|stream-json|text` | `agent ls` + resume | cliente | melhor UX in-editor |
| **GitHub Copilot** | `copilot` | `copilot -p "<prompt>"` | JSON via flags programáticas | sessões próprias | cliente | `--allow-tool=[...]`, `--allow-url=[...]`, `--allow-all-tools` (perigoso) |
| **OpenCode** | `opencode` | `opencode run` | **`opencode serve` → REST + OpenAPI 3.1 + SSE** | `GET/POST /session`, `PATCH /session/{id}`, `/session/status` | cliente | model-agnostic, self-hosted, SDK gerado do OpenAPI. **Melhor cidadão para orquestração.** |
| **Google Antigravity 2.0** | `antigravity` (Go) | headless nativo | SDK próprio | histórico persistente | cliente | 5 superfícies: desktop, CLI Go, SDK, Managed Agents (Gemini API), Enterprise Platform. Gemini CLI foi descontinuado → Antigravity CLI (jun/2026) |
| **Kimi Code CLI** (Moonshot) | `kimi` | `kimi -p` | one-shot headless | sessões | cliente + **ACP** | migrando Python → Bun+TS; "agent swarm" |
| **MiMo Code** (Xiaomi) | `mimo` | CLI agent gratuito | — | memória persistente entre sessões | cliente | 82% SWE-bench |

### Outros relevantes para adapters futuros
Aider, Cline, Roo Code, Goose (Block, Apache 2.0), Qwen Code, Amp, Windsurf, Kiro, Devin, Ollama (runtime local).

## 3. Conclusões de arquitetura derivadas da pesquisa

1. **Nenhum agente é orquestrador universal.** Todos são: (a) processos CLI com modo headless + saída JSON, e/ou (b) servidores MCP/HTTP. O Hub precisa de um **adapter por agente** normalizando isso.
2. **Denominador comum viável:** `spawn(processo headless) → stream de eventos JSONL → normalização para um Event Envelope único do Hub`.
3. **Bidirecionalidade (orquestrar E ser orquestrado):** o Hub expõe (i) um **MCP server** com tools `agent.call/agent.status/agent.cancel` para que qualquer agente chame outro pelo Hub, e (ii) um **A2A server** para peers externos. Assim, "qualquer um pode ser o principal" — o principal é apenas quem detém a sessão-raiz.
4. **Segurança é o eixo crítico:** `--allow-all-tools` e equivalentes dão ao agente todo o poder do usuário. Segregação obrigatória: workspace por sessão, credenciais por agente, política de ferramentas declarativa, aprovação humana em ações irreversíveis.
5. **Anti-loop obrigatório:** grafo de chamadas com profundidade máxima, detecção de ciclos, orçamento (tokens/tempo/custo) propagado do pai para o filho.
