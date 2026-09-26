// A validação das variáveis `AGENTS_HUB_*` mora em `@agents-hub/core` para que
// CLI, MCP server e daemon leiam pelo MESMO esquema — o MCP server não depende
// do daemon, e antes disto lia `process.env` cru (`AGENTS_HUB_MCP_GRACE_MS=abc`
// virava `NaN` e a carência sumia em silêncio). Reexportado aqui para quem já
// importava do daemon.
export { readHubEnv, type HubEnv } from '@agents-hub/core';
