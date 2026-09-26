import path from 'node:path';
import { z } from 'zod';
import { HubError } from '@agents-hub/core';
import { backupDatabase, backupFileName } from '@agents-hub/store';
import type { AuditTrail } from './audit.js';
import type { HubConfig } from './config.js';
import { readJsonBody } from './http-body.js';
import { operatorOf } from './operator-auth.js';
import type { RouteRegistrar } from './operator-routes.js';

/**
 * Rotas de manutenção do item 5.6 do GOAL (backup do banco), fora de
 * `server.ts` para a mudança lá ficar numa linha.
 *
 * | Rota                       | Token | Efeito                                         |
 * |----------------------------|-------|------------------------------------------------|
 * | POST /maintenance/backup   | sim   | `VACUUM INTO` do banco para `out` (ou para     |
 * |                            |       | `<home>/backups/hub-<data>.db`)                |
 *
 * Exige token de operador: grava um arquivo num caminho escolhido por quem
 * chama, e o arquivo carrega a trilha de auditoria e o ambiente dos projetos.
 * Restaurar NÃO tem rota: só com o daemon parado (ver `hub restore`).
 */

const BackupBodySchema = z
  .object({
    /** Caminho ABSOLUTO do arquivo a gerar. A CLI resolve o relativo antes. */
    out: z.string().min(1).max(4096).optional(),
  })
  .strict();

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function registerMaintenanceRoutes(
  route: RouteRegistrar,
  deps: { config: HubConfig; audit: AuditTrail },
): void {
  const { config, audit } = deps;

  route(
    'POST',
    '/maintenance/backup',
    async (req, res) => {
      const parsed = BackupBodySchema.safeParse(await readJsonBody(req));
      if (!parsed.success) {
        throw new HubError('INVALID_BRIEF', 'corpo inválido — esperado {"out"?: "<caminho absoluto>"}', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const out = parsed.data.out ?? path.join(config.home, 'backups', backupFileName());
      if (!path.isAbsolute(out)) {
        // Relativo a quê? O cwd do daemon não é o de quem pediu.
        throw new HubError('INVALID_PATH', `"out" precisa ser caminho absoluto: ${out}`, { out });
      }
      const backup = backupDatabase(config.dbFile, out);
      audit.record({
        actor: operatorOf(req)?.by ?? 'desconhecido',
        kind: 'maintenance.backup',
        action: 'POST /maintenance/backup',
        decision: 'created',
        detail: { path: backup.path, bytes: backup.bytes, schemaVersion: backup.schemaVersion },
      });
      sendJson(res, 200, { backup });
    },
    { operator: true },
  );
}
