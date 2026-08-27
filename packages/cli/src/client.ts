/**
 * O cliente HTTP mora em `@agents-hub/client` porque CLI, MCP server e Web UI
 * consomem exatamente a mesma API. Este arquivo existe só para não quebrar os
 * imports internos da CLI.
 */
export * from '@agents-hub/client';
