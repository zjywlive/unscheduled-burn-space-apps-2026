// Tools-only MCP 2025-11-25 over newline-delimited stdio; Node built-ins only.
// Protocol references and intentionally omitted features: README.md and B-report.md.
import { createInterface } from 'node:readline';
import { createCoreTools } from '../demo/src/tools-core.js';
import { loadCoreContext, DEFAULT_DATA_DIR } from '../tools/core-context.mjs';
import { buildInstructions, OPEN_SPEC, openInNavigator } from './navigator.mjs';

const VERSION = '2025-11-25';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = (v) => typeof v === 'string' || Number.isSafeInteger(v);
const rpcError = (code, message) => Object.assign(new Error(message), { code });
const toolResult = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
  isError: Object.hasOwn(value, 'error'),
});

// Injection is only for isolated transport tests; the CLI always uses the repo's data.
export async function serve({ input = process.stdin, output = process.stdout, loadContext = loadCoreContext } = {}) {
  let state = 'new', core, ctx;
  let windowStart = 0, callsInWindow = 0;
  const write = (message) => new Promise((resolve, reject) => {
    output.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
  });
  // The MCP schema permits an absent id when a malformed request's id is unreadable.
  const fail = (id, code, message) => write({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), error: { code, message } });
  async function getCore() {
    if (!core) {
      try {
        const loaded = await loadContext();
        core = createCoreTools(loaded);
        ctx = loaded;
      } catch (error) {
        const message = `Cannot load lunar data from ${DEFAULT_DATA_DIR}: ${error.message}. Ensure the repository's demo/data files are present and readable.`;
        console.error(message);
        throw rpcError(-32603, message);
      }
    }
    return core;
  }

  async function dispatch(method, params) {
    if (!object(params) || (params._meta !== undefined && !object(params._meta))) {
      throw rpcError(-32602, 'params and params._meta must be objects when supplied.');
    }
    if (method === 'ping') return {};
    if (method === 'initialize') {
      if (state !== 'new') throw rpcError(-32600, 'This connection is already initialized.');
      if (typeof params.protocolVersion !== 'string' || !params.protocolVersion || !object(params.capabilities)
          || !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        throw rpcError(-32602, 'initialize requires protocolVersion, capabilities, and clientInfo with name and version.');
      }
      // Only one supported revision: counteroffer it when the requested one differs.
      state = 'initializing';
      return {
        protocolVersion: VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'lunar-site-navigator', version: '1.0.0' },
        // Only sites.json is read here (the site id table); everything else stays lazy.
        instructions: buildInstructions(),
      };
    }
    if (method !== 'tools/list' && method !== 'tools/call') throw rpcError(-32601, `Method not found: ${method}`);
    if (state !== 'ready') throw rpcError(-32000, 'Send initialize and notifications/initialized before using tools.');
    if (method === 'tools/list') {
      // One complete page; no cursor is ever issued.
      if (params.cursor !== undefined) throw rpcError(-32602, 'Invalid cursor: tools/list returns one complete page.');
      const tools = await getCore();
      return {
        tools: tools.specs().map(({ name, description, input_schema }) => ({
          name, description, inputSchema: input_schema,
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
        })).concat(structuredClone(OPEN_SPEC)),
      };
    }
    if (typeof params.name !== 'string' || !params.name || (params.arguments !== undefined && !object(params.arguments))) {
      throw rpcError(-32602, 'tools/call requires a name string and an optional arguments object.');
    }
    if (params.task !== undefined) throw rpcError(-32602, 'Task-augmented execution is not supported.');
    let tools;
    try {
      tools = await getCore();
    } catch (error) {
      // Failure to load data for a call is actionable tool-execution feedback.
      return toolResult({ error: error.message });
    }
    const local = params.name === OPEN_SPEC.name;
    if (!local && !tools.list.includes(params.name)) throw rpcError(-32602, `Unknown tool: ${params.name}`);
    // Bound invocation rate as well as concurrency (the transport runs serially).
    const now = Date.now();
    if (now - windowStart >= 1000) { windowStart = now; callsInWindow = 0; }
    if (++callsInWindow > 60) throw rpcError(-32000, 'Tool call rate limit: 60 calls per second. Retry later.');
    if (local) {
      try { return toolResult(openInNavigator(ctx, params.arguments ?? {})); }
      catch (error) { return toolResult({ error: `${OPEN_SPEC.name} failed: ${error.message}` }); }
    }
    return toolResult(await tools.run(params.name, params.arguments ?? {}));
  }

  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of lines) {
      let message;
      try { message = JSON.parse(line); }
      catch { await fail(undefined, -32700, 'Parse error'); continue; }
      const id = object(message) && validId(message.id) ? message.id : undefined;
      if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
          || Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')
          || (Object.hasOwn(message, 'id') && id === undefined)) {
        await fail(id, -32600, 'Invalid Request');
        continue;
      }
      if (!Object.hasOwn(message, 'id')) {
        // Never reply to notifications, even unknown ones. They cannot invoke tools.
        if (message.method === 'notifications/initialized' && state === 'initializing'
            && (message.params === undefined || object(message.params))) state = 'ready';
        continue;
      }
      try {
        const result = await dispatch(message.method, message.params === undefined ? {} : message.params);
        await write({ jsonrpc: '2.0', id, result });
      } catch (error) {
        if (!Number.isInteger(error.code)) console.error(error.message);
        await fail(id, Number.isInteger(error.code) ? error.code : -32603, error.message);
      }
    }
  } finally {
    lines.close();
  }
  // EOF drains all accepted requests and writes; natural exit does not truncate stdout.
}

if (import.meta.main) {
  serve().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
