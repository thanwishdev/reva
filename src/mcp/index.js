// MCP surface + shared tool contract. See contract.js (tools), server.js (MCP stdio), cli.js (CLI face), providers.js (merge point).
export { TOOLS, PUBLIC_TOOLS, allTools, publicTools, runTool, displayAwake } from './contract.js';
export { createServer, serveStdio, INSTRUCTIONS, SERVER_INFO } from './server.js';
export { contractCommand, inputFromFlags, ALIASES } from './cli.js';
export { ok, fail, enforce, fitPage, code, seriesRef, toMcp, toText, CONTRACT_VERSION } from './envelope.js';
export { registerProvider, registerTools } from './providers.js';
