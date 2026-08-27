#!/usr/bin/env python3
"""
Teste de fumaça do MCP server do Agents-Hub.

Fala JSON-RPC de verdade com o servidor, exatamente como um agente hospedeiro
faria: mantém stdin aberto durante toda a sessão e só fecha no fim. É assim que
Claude Code, Codex e Cursor conversam com ele.

Uso:
    python scripts/mcp-smoke.py                      # só leitura, sem custo
    python scripts/mcp-smoke.py --delegate codex     # delega de verdade (gasta tokens)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "packages" / "mcp" / "dist" / "main.js"

# O console do Windows abre em cp1252 e engasga em acento e seta — o que faria
# o teste "falhar" por causa da impressão, não do que está sendo testado.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


class McpSession:
    """Cliente MCP mínimo sobre stdio."""

    def __init__(self, agent_id: str = "cursor", hub_url: str = "http://127.0.0.1:4747"):
        env = dict(os.environ)
        env["AGENTS_HUB_MCP_AGENT"] = agent_id
        env["AGENTS_HUB_URL"] = hub_url

        self.proc = subprocess.Popen(
            ["node", str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
            cwd=str(ROOT),
        )
        self._next_id = 0
        self._responses: dict[int, dict] = {}
        self._lock = threading.Condition()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

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
        except Exception:
            self.proc.kill()

    def stderr(self) -> str:
        assert self.proc.stderr is not None
        return self.proc.stderr.read()


def section(title: str) -> None:
    print(f"\n{'=' * 62}\n{title}\n{'=' * 62}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--delegate",
        metavar="AGENTE",
        help="delega de verdade para este agente (gasta tokens)",
    )
    parser.add_argument("--agent", default="cursor", help="quem finge ser o chamador")
    args = parser.parse_args()

    if not SERVER.exists():
        print(f"servidor não compilado: {SERVER}\nrode: npx tsc -b", file=sys.stderr)
        return 1

    session = McpSession(agent_id=args.agent)
    failures: list[str] = []

    try:
        section("1. handshake")
        result = session.request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "mcp-smoke", "version": "1.0"},
            },
        )["result"]
        session.notify("notifications/initialized")
        print(f"  servidor: {result['serverInfo']['name']} v{result['serverInfo']['version']}")
        print(f"  protocolo: {result['protocolVersion']}")

        section("2. tools disponíveis")
        tools = session.request("tools/list")["result"]["tools"]
        for tool in tools:
            print(f"  {tool['name']:22} {tool.get('title', '')}")
        expected = {"hub_agent_list", "hub_agent_call", "hub_agent_status", "hub_agent_wait"}
        missing = expected - {t["name"] for t in tools}
        if missing:
            failures.append(f"tools faltando: {missing}")

        section("3. hub_agent_list")
        print(session.call_tool("hub_agent_list"))

        section("4. hub_budget (força adoção do chamador externo)")
        print(session.call_tool("hub_budget"))

        section("5. hub_graph (o chamador externo deve aparecer como raiz)")
        print(session.call_tool("hub_graph"))

        if args.delegate:
            section(f"6. hub_agent_call → {args.delegate}")
            call = session.call_tool(
                "hub_agent_call",
                {
                    "agent": args.delegate,
                    "objective": (
                        "Responda apenas com a palavra MCP_OK. "
                        "Nao use ferramentas e nao altere nenhum arquivo."
                    ),
                    "budget_usd": 0.30,
                },
            )
            print(call)

            task_id = next(
                (l.split("task_id:")[1].strip() for l in call.splitlines() if "task_id:" in l),
                None,
            )
            if not task_id:
                failures.append("hub_agent_call não devolveu task_id")
            else:
                section("7. hub_agent_wait")
                print(session.call_tool(
                    "hub_agent_wait", {"task_id": task_id, "timeout_seconds": 180}, timeout=200
                ))

                section("8. hub_graph após a delegação")
                graph = session.call_tool("hub_graph")
                print(graph)
                if args.delegate not in graph:
                    failures.append("o agente delegado não apareceu no grafo")

    except Exception as err:  # noqa: BLE001 — o teste reporta qualquer falha
        failures.append(f"{type(err).__name__}: {err}")
    finally:
        session.close()
        err_output = session.stderr().strip()
        if err_output:
            print(f"\n[stderr do servidor]\n{err_output}")

    section("resultado")
    if failures:
        for failure in failures:
            print(f"  FALHOU: {failure}")
        return 1

    print("  tudo verde")
    return 0


if __name__ == "__main__":
    sys.exit(main())
