// Hooks de settings.json: comandos que corren antes/despues de herramientas, al enviar un mensaje y al terminar.
//   "hooks": { "pre_tool": [{ "match": "edit|write", "command": "..." }], "post_tool": [...], "prompt": [...], "stop": [...] }
// Reciben un json por stdin. En pre_tool, salir con codigo 2 bloquea la herramienta (stderr es el motivo).
import { spawn } from 'node:child_process';
import { detectShell } from '../tools/shell.mjs';

function runHook(command, payload, cwd) {
  const shell = detectShell();
  return new Promise((resolve) => {
    const child = spawn(shell.file, shell.args(command), { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', (error) => resolve({ code: -1, stdout: '', stderr: error.message }));
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function runHooks(settings, event, payload, cwd) {
  const entries = (settings?.hooks?.[event] ?? []).filter((entry) => !entry.match || !payload.tool || new RegExp(`^(${entry.match})$`).test(payload.tool));
  const results = [];
  for (const entry of entries) results.push(await runHook(entry.command, { event, cwd, ...payload }, cwd));
  return {
    blocked: results.find((result) => result.code === 2)?.stderr || null,
    output: results.map((result) => result.stdout).filter(Boolean).join('\n'),
  };
}
