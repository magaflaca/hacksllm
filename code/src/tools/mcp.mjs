// Cliente MCP por stdio: arranca los servidores de settings.mcpServers y expone sus herramientas.
import { spawn } from 'node:child_process';

class McpServer {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.tools = [];
    this.error = null;
  }

  async start() {
    const { command, args = [], env = {} } = this.spec;
    this.child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32', windowsHide: true });
    this.child.on('error', (error) => (this.error = error.message));
    this.child.on('exit', () => {
      for (const { reject } of this.pending.values()) reject(new Error(`${this.name} se cerro`));
      this.pending.clear();
    });
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let at;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).trim();
        this.buffer = this.buffer.slice(at + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const waiter = this.pending.get(message.id);
          if (waiter) {
            this.pending.delete(message.id);
            message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
          }
        } catch {
          /* no es json-rpc */
        }
      }
    });
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bichi-code', version: '1' } }, 20000);
    this.notify('notifications/initialized');
    const { tools = [] } = await this.request('tools/list', {}, 20000);
    this.tools = tools;
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  request(method, params, timeout = 300000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${method} no respondio`));
      }, timeout);
      this.pending.set(id, { resolve: (value) => (clearTimeout(timer), resolve(value)), reject: (error) => (clearTimeout(timer), reject(error)) });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  stop() {
    this.child?.kill();
  }
}

export const servers = [];

export async function startMcp(specs) {
  const started = await Promise.all(
    Object.entries(specs ?? {}).map(async ([name, spec]) => {
      const server = new McpServer(name, spec);
      try {
        await server.start();
      } catch (error) {
        server.error = error.message;
      }
      servers.push(server);
      return server;
    }),
  );
  return started.flatMap((server) =>
    server.error
      ? []
      : server.tools.map((tool) => ({
          name: `mcp__${server.name}__${tool.name}`.replace(/[^\w-]/g, '_').slice(0, 64),
          kind: 'mcp',
          description: tool.description ?? `${tool.name} (${server.name})`,
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
          label: (input) => ({ title: `${server.name}`, arg: tool.name }),
          async run(input) {
            const result = await server.request('tools/call', { name: tool.name, arguments: input });
            const text = (result.content ?? []).map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n');
            if (result.isError) throw new Error(text || 'error del servidor mcp');
            return { content: text || '(sin contenido)' };
          },
        })),
  );
}

export const stopMcp = () => servers.forEach((server) => server.stop());
