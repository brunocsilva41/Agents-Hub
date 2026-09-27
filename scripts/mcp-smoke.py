#!/usr/bin/env python3
"""
Teste de fumaça do MCP server do Agents-Hub.

Fala JSON-RPC de verdade com o servidor, exatamente como um agente hospedeiro
faria: mantém stdin aberto durante toda a sessão e só fecha no fim. É assim que
Claude Code, Codex e Cursor conversam com ele.

Dois modos:

- PADRÃO (sem --url nem AGENTS_HUB_URL): sobe um daemon ISOLADO (home
  temporária, porta própria, agentes FALSOS em Node — custo zero), lista as
  tools com `tools/list`, exige o conjunto esperado e exercita CADA uma delas.
  Nunca toca em ~/.agents-hub nem na porta 4747.
- EXTERNO (--url ou AGENTS_HUB_URL): fala com um daemon que já está no ar.
  Só leitura (tools/list, hub_agent_list, hub_budget, hub_graph,
  hub_session_list — as duas do meio adotam o chamador como raiz); o resto
  exige agentes falsos e fica de fora. Apontar para 4747 (o daemon do
  usuário) gera aviso explícito.

Uso:
    python scripts/mcp-smoke.py                                  # isolado, todas as tools
    python scripts/mcp-smoke.py --url http://127.0.0.1:48205     # externo, só leitura
    python scripts/mcp-smoke.py --url ... --delegate codex       # delega de verdade (gasta tokens)

Pré-requisito: `npm run build` (usa packages/mcp/dist e packages/daemon/dist).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "packages" / "mcp" / "dist" / "main.js"
DAEMON = ROOT / "packages" / "daemon" / "dist" / "main.js"

# As 16 tools do MCP. Tool nova sem entrada aqui (e sem exercício abaixo) faz o
# smoke falhar — é o ponto: nenhuma tool fica sem ser chamada de verdade.
EXPECTED_TOOLS = {
    "hub_agent_list",
    "hub_agent_call",
    "hub_agent_status",
    "hub_agent_wait",
    "hub_agent_events",
    "hub_session_diff",
    "hub_agent_cancel",
    "hub_session_interrupt",
    "hub_session_pause",
    "hub_session_send",
    "hub_session_handoff",
    "hub_session_list",
    "hub_graph",
    "hub_context_fetch",
    "hub_budget",
    "hub_workflow_run",
}

# O console do Windows abre em cp1252 e engasga em acento e seta — o que faria
# o teste "falhar" por causa da impressão, não do que está sendo testado.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


# Agente falso no dialeto JSONL do Claude (mapper `claude`): revela id nativo,
# dorme FAKE_SLEEP_MS (turno longo para interromper/pausar/cancelar) a menos
# que o prompt traga @NOSLEEP, e termina com RESULTADO_<agente>. Não chama
# modelo nenhum.
FAKE_AGENT = r"""
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\n'); process.exit(0); }
const agente = process.env.FAKE_AGENT;
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const sid = 'nat-' + agente + '-' + process.pid;
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', tools: [] });
  const sleep = prompt.includes('@NOSLEEP') ? 0 : Number(process.env.FAKE_SLEEP_MS || 0);
  if (sleep) await new Promise((r) => setTimeout(r, sleep));
  out({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'RESULTADO_' + agente }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'RESULTADO_' + agente, session_id: sid, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
});
"""


def fake_manifest(agent_id: str, script: Path, sleep_ms: int) -> str:
    s = str(script).replace("\\", "\\\\")
    return "\n".join(
        [
            f"id: {agent_id}",
            f"name: Agente falso {agent_id}",
            "bin: node",
            "detect:",
            f'  args: ["{s}", "--version"]',
            "invoke:",
            f'  oneShot: ["{s}"]',
            "  stdinPrompt: true",
            "  env:",
            f'    FAKE_AGENT: "{agent_id}"',
            f'    FAKE_SLEEP_MS: "{sleep_ms}"',
            "session:",
            "  strategy: replay",
            "stream:",
            "  format: jsonl",
            "  mapper: claude",
            "capabilities: [smoke]",
            "defaults:",
            "  isolation: none",
            "  timeoutSeconds: 90",
            "  supervision: autonomous",
            "",
        ]
    )


def http(base: str, method: str, route: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {}
    if body is not None:
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(base + route, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as res:
            raw = res.read().decode("utf-8")
            return res.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class IsolatedDaemon:
    """Daemon do Hub numa home temporária, com agentes falsos. Nunca a 4747."""

    def __init__(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="hub-mcp-smoke-"))
        self.home = self.tmp / "home"
        self.project = self.tmp / "projeto"
        manifests = self.home / "manifests"
        manifests.mkdir(parents=True)
        self.project.mkdir()
        script = self.tmp / "agente.cjs"
        script.write_text(FAKE_AGENT, encoding="utf-8")
        # chamador: identidade do agente externo (adotado, nunca roda);
        # eco: conclui na hora; lento: turno de 30 s (interromper/pausar/cancelar).
        for agent_id, sleep_ms in (("chamador", 0), ("eco", 0), ("lento", 30_000)):
            (manifests / f"{agent_id}.yaml").write_text(fake_manifest(agent_id, script, sleep_ms), encoding="utf-8")
        (self.home / "config.json").write_text(
            json.dumps({"policy": {"retries": {"max": 0, "backoffMs": 10}, "watch": {"pauseOn": [], "flagOn": []}}}),
            encoding="utf-8",
        )
        self.proc: subprocess.Popen | None = None
        self.base = ""
        self.log: list[str] = []

    @property
    def token(self) -> str | None:
        try:
            return (self.home / "operator-token").read_text(encoding="utf-8").strip()
        except OSError:
            return None

    def _is_ours(self) -> bool:
        # Só o daemon que subimos aceita o token da NOSSA home temporária.
        token = self.token
        if not token:
            return False
        try:
            status, _ = http(self.base, "POST", "/approvals/apv_smokeinexistente", {"decision": "approved"}, token)
            return status not in (401, 403)
        except OSError:
            return False

    def start(self) -> None:
        # A porta é reservada e solta antes do spawn (o daemon não aceita 0 por
        # env): se outro processo a pegar, o daemon morre e tentamos outra.
        for _ in range(5):
            port = free_port()
            self.base = f"http://127.0.0.1:{port}"
            env = dict(os.environ)
            env.update(
                AGENTS_HUB_HOME=str(self.home),
                AGENTS_HUB_PORT=str(port),
                AGENTS_HUB_NO_AUTOSTART="1",
            )
            self.proc = subprocess.Popen(
                ["node", "--experimental-sqlite", str(DAEMON)],
                cwd=str(ROOT),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            threading.Thread(target=self._drain, daemon=True).start()
            deadline = time.time() + 20
            while time.time() < deadline and self.proc.poll() is None:
                try:
                    status, body = http(self.base, "GET", "/health")
                    if status == 200 and body.get("ok") is True:
                        if self._is_ours():
                            return
                        break
                except OSError:
                    pass
                time.sleep(0.15)
            self._kill()
        raise RuntimeError("não foi possível subir o daemon isolado:\n" + "".join(self.log))

    def _drain(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        for line in self.proc.stdout:
            self.log.append(line)

    def _kill(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                http(self.base, "POST", "/shutdown", {}, self.token)
                self.proc.wait(timeout=10)
            except Exception:  # noqa: BLE001 — cai para o kill
                self._kill()
        # No Windows o SQLite pode segurar o arquivo por instantes após o exit.
        for _ in range(20):
            try:
                shutil.rmtree(self.tmp)
                break
            except FileNotFoundError:
                break
            except OSError:
                time.sleep(0.25)

    def session(self, session_id: str) -> dict:
        _, body = http(self.base, "GET", f"/sessions/{session_id}")
        return body

    def wait_turn_running(self, session_id: str, timeout: float = 20.0) -> None:
        """O agente está no meio do turno (já revelou o id nativo)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            body = self.session(session_id)
            if body.get("live") is True and body.get("session", {}).get("nativeSessionId"):
                return
            time.sleep(0.1)
        raise TimeoutError(f"turno de {session_id} não começou em {timeout}s")


class McpSession:
    """Cliente MCP mínimo sobre stdio."""

    def __init__(self, agent_id: str, hub_url: str, cwd: Path):
        env = dict(os.environ)
        env["AGENTS_HUB_MCP_AGENT"] = agent_id
        env["AGENTS_HUB_URL"] = hub_url
        # Sem carência na saída: o smoke fecha stdin e espera o processo.
        env["AGENTS_HUB_MCP_GRACE_MS"] = "0"

        self.proc = subprocess.Popen(
            ["node", str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
            # O cwd é o projeto do chamador (a adoção registra este diretório).
            cwd=str(cwd),
        )
        self._next_id = 0
        self._responses: dict[int, dict] = {}
        self._lock = threading.Condition()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self.called: set[str] = set()

    def _read_loop(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                # stdout do MCP é canal de protocolo: lixo aqui é bug do servidor.
                print(f"  [stdout não-JSON] {line[:120]}", file=sys.stderr)
                continue
            if "id" in message:
                with self._lock:
                    self._responses[message["id"]] = message
                    self._lock.notify_all()

    def request(self, method: str, params: dict | None = None, timeout: float = 120.0) -> dict:
        self._next_id += 1
        request_id = self._next_id
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})

        deadline = time.time() + timeout
        with self._lock:
            while request_id not in self._responses:
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise TimeoutError(f"sem resposta para {method} em {timeout}s")
                self._lock.wait(remaining)
            return self._responses.pop(request_id)

    def notify(self, method: str, params: dict | None = None) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def _send(self, message: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def call_tool(self, name: str, arguments: dict | None = None, timeout: float = 120.0) -> str:
        self.called.add(name)
        response = self.request(
            "tools/call", {"name": name, "arguments": arguments or {}}, timeout=timeout
        )
        if "error" in response:
            raise RuntimeError(f"{name}: {response['error']}")
        result = response["result"]
        text = "\n".join(
            block["text"] for block in result.get("content", []) if block.get("type") == "text"
        )
        if result.get("isError"):
            raise RuntimeError(f"{name} retornou erro:\n{text}")
        return text

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            self.proc.kill()

    def stderr(self) -> str:
        assert self.proc.stderr is not None
        return self.proc.stderr.read()


class Checks:
    def __init__(self) -> None:
        self.total = 0
        self.failures: list[str] = []

    def check(self, ok: bool, description: str, detail: str = "") -> bool:
        self.total += 1
        if not ok:
            self.failures.append(description)
        suffix = f"  ({detail})" if detail else ""
        print(f"{'PASS' if ok else 'FAIL'}  {description}{suffix}")
        return ok

    def run(self, description: str, fn) -> str | None:
        """Chama a tool; exceção vira FAIL com a mensagem, sem derrubar o resto."""
        try:
            return fn()
        except Exception as err:  # noqa: BLE001 — o smoke reporta qualquer falha
            self.check(False, description, f"{type(err).__name__}: {str(err)[:400]}")
            return None


def field(text: str | None, key: str) -> str | None:
    for line in (text or "").splitlines():
        if line.strip().startswith(f"{key}:"):
            return line.split(":", 1)[1].strip()
    return None


def section(title: str) -> None:
    print(f"\n{'=' * 62}\n{title}\n{'=' * 62}")


def handshake(session: McpSession, checks: Checks) -> set[str]:
    section("handshake e tools/list")
    result = session.request(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "mcp-smoke", "version": "2.0"},
        },
    )["result"]
    session.notify("notifications/initialized")
    checks.check(
        bool(result.get("serverInfo", {}).get("name")),
        "initialize responde",
        f"{result['serverInfo']['name']} v{result['serverInfo']['version']}, protocolo {result['protocolVersion']}",
    )
    tools = session.request("tools/list")["result"]["tools"]
    names = {t["name"] for t in tools}
    for tool in tools:
        print(f"  {tool['name']:24} {tool.get('title', '')}")
    missing = EXPECTED_TOOLS - names
    extra = names - EXPECTED_TOOLS
    checks.check(
        not missing and not extra,
        f"tools/list devolve as {len(EXPECTED_TOOLS)} tools esperadas",
        f"faltando {sorted(missing)}; novas sem smoke {sorted(extra)}" if (missing or extra) else f"{len(names)} tools",
    )
    return names


def run_isolated(checks: Checks) -> None:
    for artefato in (SERVER, DAEMON):
        if not artefato.exists():
            checks.check(False, "build presente", f"{artefato} ausente — rode `npm run build`")
            return

    daemon = IsolatedDaemon()
    session: McpSession | None = None
    try:
        daemon.start()
        checks.check(True, f"daemon isolado no ar em {daemon.base}", f"home {daemon.home}")
        session = McpSession("chamador", daemon.base, daemon.project)
        names = handshake(session, checks)
        s = session

        section("leitura")
        out = checks.run("hub_agent_list", lambda: s.call_tool("hub_agent_list"))
        if out is not None:
            checks.check(all(a in out for a in ("eco", "lento")), "hub_agent_list mostra os agentes falsos")
        out = checks.run("hub_budget", lambda: s.call_tool("hub_budget"))
        if out is not None:
            checks.check("restante" in out, "hub_budget adota o chamador e mostra o saldo")

        section("delegação e acompanhamento")
        call = checks.run(
            "hub_agent_call",
            lambda: s.call_tool(
                "hub_agent_call",
                {"agent": "eco", "objective": "Responder RESULTADO de eco sem tocar em arquivo", "isolation": "none"},
            ),
        )
        task_id, session_id = field(call, "task_id"), field(call, "session_id")
        checks.check(bool(task_id and session_id), "hub_agent_call devolve task_id e session_id", f"{task_id} / {session_id}")
        if task_id and session_id:
            out = checks.run("hub_agent_wait", lambda: s.call_tool("hub_agent_wait", {"task_id": task_id, "timeout_seconds": 60}, timeout=90))
            checks.check("RESULTADO_eco" in (out or ""), "hub_agent_wait espera e traz o resultado do agente")
            out = checks.run("hub_agent_status", lambda: s.call_tool("hub_agent_status", {"task_id": task_id}))
            checks.check("completed" in (out or ""), "hub_agent_status mostra a tarefa concluída")
            out = checks.run("hub_agent_events", lambda: s.call_tool("hub_agent_events", {"session_id": session_id}))
            checks.check("último seq" in (out or ""), "hub_agent_events lista os eventos da sessão")
            out = checks.run("hub_session_diff", lambda: s.call_tool("hub_session_diff", {"session_id": session_id}))
            checks.check("não alterou" in (out or ""), "hub_session_diff diz que nada mudou")
            out = checks.run("hub_context_fetch", lambda: s.call_tool("hub_context_fetch", {"ref": f"session:{session_id}"}))
            checks.check(out is not None and len(out) > 0, "hub_context_fetch resolve a referência da sessão")
        out = checks.run("hub_graph", lambda: s.call_tool("hub_graph"))
        checks.check("eco" in (out or ""), "hub_graph mostra o delegado sob o chamador")
        out = checks.run("hub_session_list", lambda: s.call_tool("hub_session_list"))
        checks.check(bool(session_id) and session_id in (out or ""), "hub_session_list inclui a sessão delegada")

        section("controle de sessão (turno longo do agente lento)")

        def lento(objetivo: str) -> tuple[str, str] | None:
            text = checks.run(
                f"hub_agent_call lento ({objetivo})",
                lambda: s.call_tool("hub_agent_call", {"agent": "lento", "objective": objetivo, "isolation": "none"}),
            )
            t, sid = field(text, "task_id"), field(text, "session_id")
            if not (t and sid):
                checks.check(False, f"delegar ao lento ({objetivo})", text or "")
                return None
            daemon.wait_turn_running(sid)
            return t, sid

        alvo = lento("turno longo que será interrompido e retomado")
        if alvo:
            t, sid = alvo
            out = checks.run("hub_session_interrupt", lambda: s.call_tool("hub_session_interrupt", {"session_id": sid}))
            checks.check(out is not None and daemon.session(sid).get("session", {}).get("state") == "idle", "hub_session_interrupt para o turno sem encerrar")
            out = checks.run("hub_session_send", lambda: s.call_tool("hub_session_send", {"session_id": sid, "text": "continue @NOSLEEP"}))
            fim = checks.run("hub_agent_wait (retomada)", lambda: s.call_tool("hub_agent_wait", {"task_id": t, "timeout_seconds": 60}, timeout=90))
            checks.check(out is not None and "RESULTADO_lento" in (fim or ""), "hub_session_send retoma a sessão até concluir")

        alvo = lento("turno longo que será pausado e transferido")
        if alvo:
            t, sid = alvo
            out = checks.run("hub_session_pause", lambda: s.call_tool("hub_session_pause", {"session_id": sid}))
            checks.check(out is not None and daemon.session(sid).get("session", {}).get("state") == "paused", "hub_session_pause deixa a sessão paused")
            out = checks.run(
                "hub_session_handoff",
                lambda: s.call_tool("hub_session_handoff", {"session_id": sid, "target_agent": "eco", "reason": "smoke"}),
            )
            fim = checks.run("hub_agent_wait (handoff)", lambda: s.call_tool("hub_agent_wait", {"task_id": t, "timeout_seconds": 60}, timeout=90))
            checks.check(
                out is not None and daemon.session(sid).get("session", {}).get("agentId") == "eco" and "RESULTADO_eco" in (fim or ""),
                "hub_session_handoff passa a sessão ao eco, que conclui",
                f"handoff: {(out or '').splitlines()[:1]}; espera: {(fim or '').splitlines()[:3]}",
            )

        alvo = lento("turno longo que será cancelado pelo chamador")
        if alvo:
            t, sid = alvo
            out = checks.run("hub_agent_cancel", lambda: s.call_tool("hub_agent_cancel", {"session_id": sid, "reason": "smoke"}))
            deadline = time.time() + 15
            estado = None
            while time.time() < deadline:
                estado = daemon.session(sid).get("session", {}).get("state")
                if estado == "killed":
                    break
                time.sleep(0.1)
            checks.check(out is not None and estado == "killed", "hub_agent_cancel encerra a sessão", f"estado {estado}")

        section("workflow")
        yaml = "\n".join(
            [
                "name: smoke-dois-passos",
                "steps:",
                "  - id: primeiro",
                "    agent: eco",
                '    objective: "Fazer o primeiro passo do smoke de ponta a ponta"',
                "    isolation: none",
                "  - id: segundo",
                "    agent: eco",
                '    objective: "Fazer o segundo passo depois do primeiro concluir"',
                "    isolation: none",
                "    dependsOn: [primeiro]",
                "",
            ]
        )
        out = checks.run(
            "hub_workflow_run",
            lambda: s.call_tool("hub_workflow_run", {"yaml": yaml, "project": str(daemon.project)}, timeout=120),
        )
        checks.check("2/2 passos concluídos" in (out or ""), "hub_workflow_run executa os 2 passos na ordem")

        nao_chamadas = names - s.called
        checks.check(not nao_chamadas, "toda tool listada foi exercitada", f"sem exercício: {sorted(nao_chamadas)}" if nao_chamadas else "")
    except Exception as err:  # noqa: BLE001
        checks.check(False, "erro inesperado", f"{type(err).__name__}: {err}")
    finally:
        if session is not None:
            session.close()
            err_output = session.stderr().strip()
            if checks.failures and err_output:
                print(f"\n[stderr do servidor MCP]\n{err_output}")
        if checks.failures and daemon.log:
            print("\n[saída do daemon]\n" + "".join(daemon.log[-80:]))
        daemon.stop()
        checks.check(not daemon.tmp.exists(), "daemon derrubado e diretório temporário removido")


def run_external(url: str, agent: str, delegate: str | None, checks: Checks) -> None:
    port = urlparse(url).port
    if port == 4747:
        print(
            "AVISO: 4747 é a porta padrão do daemon do USUÁRIO. Este modo só lê e adota "
            "o chamador como raiz lá; para exercitar todas as tools rode sem --url "
            "(daemon isolado, agentes falsos).",
            file=sys.stderr,
        )
    if not SERVER.exists():
        checks.check(False, "build presente", f"{SERVER} ausente — rode `npm run build`")
        return
    session = McpSession(agent, url, Path.cwd())
    try:
        handshake(session, checks)
        section("leitura (modo externo)")
        for name in ("hub_agent_list", "hub_budget", "hub_graph", "hub_session_list"):
            out = checks.run(name, lambda n=name: session.call_tool(n))
            if out is not None:
                checks.check(True, name, out.splitlines()[0] if out else "")
        if delegate:
            section(f"hub_agent_call → {delegate} (GASTA TOKENS)")
            call = checks.run(
                "hub_agent_call",
                lambda: session.call_tool(
                    "hub_agent_call",
                    {
                        "agent": delegate,
                        "objective": "Responda apenas com a palavra MCP_OK. Nao use ferramentas e nao altere nenhum arquivo.",
                        "budget_usd": 0.30,
                    },
                ),
            )
            task_id = field(call, "task_id")
            if checks.check(bool(task_id), "hub_agent_call devolveu task_id"):
                out = checks.run(
                    "hub_agent_wait",
                    lambda: session.call_tool("hub_agent_wait", {"task_id": task_id, "timeout_seconds": 180}, timeout=200),
                )
                print(out or "")
                graph = checks.run("hub_graph", lambda: session.call_tool("hub_graph"))
                checks.check(delegate in (graph or ""), "o agente delegado aparece no grafo")
        print("\n(modo externo: as tools de escrita só são exercitadas no modo isolado, sem --url)")
    finally:
        session.close()
        err_output = session.stderr().strip()
        if err_output:
            print(f"\n[stderr do servidor MCP]\n{err_output}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--url",
        help="daemon já no ar (ex.: http://127.0.0.1:48205); padrão: AGENTS_HUB_URL, ou um daemon isolado próprio",
    )
    parser.add_argument("--agent", default="cursor", help="modo externo: quem finge ser o chamador")
    parser.add_argument(
        "--delegate",
        metavar="AGENTE",
        help="modo externo: delega de verdade para este agente (gasta tokens)",
    )
    args = parser.parse_args()

    url = args.url or os.environ.get("AGENTS_HUB_URL")
    if args.delegate and not url:
        parser.error("--delegate exige --url (ou AGENTS_HUB_URL): o daemon isolado só tem agentes falsos")

    checks = Checks()
    if url:
        print(f"modo externo: {url}")
        run_external(url, args.agent, args.delegate, checks)
    else:
        print("modo isolado: daemon próprio em home temporária, agentes falsos (custo zero)")
        run_isolated(checks)

    section("resultado")
    passed = checks.total - len(checks.failures)
    for failure in checks.failures:
        print(f"  FALHOU: {failure}")
    print(f"{'OK' if not checks.failures else 'FALHOU'}: {passed}/{checks.total} checagens PASS")
    return 0 if not checks.failures else 1


if __name__ == "__main__":
    sys.exit(main())
