// bichi code como app de pantalla completa: historial con scroll arriba, entrada abajo entre lineas, sugerencias
// encima de la entrada, raton (rueda, seleccion que copia, clic en links), imagenes, rebobinar y objetivos.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { addProjectAllow, flushState, saveConfig, saveState, VERSION } from './config.mjs';
import { Agent } from './core/agent.mjs';
import { clipboardImage, describe, imagePath, storeImage } from './core/images.mjs';
import { MODE_INFO, MODES } from './core/permissions.mjs';
import { loadCommands } from './core/project.mjs';
import { newSessionId, saveSession } from './core/sessions.mjs';
import { listSkills } from './core/skills.mjs';
import { displayName } from './providers.mjs';
import { COMMANDS, runCommand } from './commands.mjs';
import { listFiles } from './tools/files.mjs';
import { killAll, shell as shellTool } from './tools/shell.mjs';
import { beetle } from './ui/art.mjs';
import { deniedBlock, notice, reasoningBlock, todoLines, toolBlock, toolTitle, userBlock } from './ui/blocks.mjs';
import { renderDiff } from './ui/diff.mjs';
import { Editor } from './ui/editor.mjs';
import { FullScreen, parseMouse } from './ui/fullscreen.mjs';
import { createDecoder } from './ui/keys.mjs';
import { renderMarkdown } from './ui/markdown.mjs';
import { bold, c, dim, fg, pad, shimmer, strip, truncate, width, wrap } from './ui/term.mjs';
import { linksIn, paintSelection, selectedText, Transcript } from './ui/transcript.mjs';
import { box, Field, HistorySearch, Menu } from './ui/widgets.mjs';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const VERBS = ['Bichiando', 'Rebuscando', 'Tramando', 'Cavilando', 'Zumbando', 'Escarbando', 'Hilando', 'Revoloteando', 'Maquinando', 'Rumiando', 'Tejiendo', 'Cocinando', 'Afinando', 'Husmeando', 'Garabateando'];
const EFFORT = { low: ['◔', 'bajo'], medium: ['◑', 'medio'], high: ['●', 'alto'] };
const MAX_INPUT_ROWS = 10;
const GOAL_ROUNDS = 12;

export class App {
  constructor({ config, state, router, cwd, settings, extraTools, session }) {
    Object.assign(this, { config, state, router, cwd, settings, extraTools });
    this.term = new FullScreen();
    this.term.onResize = () => this.render();
    this.transcript = new Transcript();
    this.editor = new Editor(state.history);
    this.mode = MODES.includes(config.mode) ? config.mode : 'normal';
    this.overlay = null;
    this.suggestions = null;
    this.running = null;
    this.toolItems = new Map();
    this.assistant = null;
    this.thinking = null;
    this.showTodos = true;
    this.follow = true;
    this.top = 0;
    this.viewH = 10;
    this.allLines = [];
    this.selection = null;
    this.pressed = null;
    this.hint = null;
    this.lastEsc = 0;
    this.lastCtrlC = 0;
    this.pendingContext = [];
    this.images = new Map();
    this.imageCount = 0;
    this.tick = 0;
    this.files = [];
    this.session = session ?? { id: newSessionId(), cwd, created: Date.now(), messages: [] };
    this.agent = this.makeAgent();
    this.agent.messages = this.session.messages;
    this.agent.todos = this.session.todos ?? [];
  }

  makeAgent() {
    return new Agent({
      config: this.config,
      state: this.state,
      router: this.router,
      cwd: this.cwd,
      settings: this.settings,
      extraTools: this.extraTools,
      mode: () => this.mode,
      ui: this.agentUi(),
    });
  }

  // ---------- arranque y salida ----------

  start() {
    const input = process.stdin;
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');
    this.term.enter();
    this.setTitle();
    const decoder = createDecoder((key) => this.onKey(key).catch((error) => this.note(error.message, c.err)));
    input.on('data', (data) => decoder.feed(data));
    process.on('SIGINT', () => this.onKey({ name: 'c', ctrl: true }));
    this.refreshFiles();
    this.ticker = setInterval(() => {
      this.tick++;
      if (this.running) {
        for (const item of this.toolItems.values()) item.update();
        this.thinking?.update();
        if (this.tick % 10 === 0) this.setTitle();
        this.schedule();
      }
    }, 90);
    this.header();
    this.render();
  }

  setTitle() {
    const folder = path.basename(this.cwd) || this.cwd;
    this.term.title(this.running ? `${SPIN[this.tick % SPIN.length]} bichi · ${folder}` : `bichi · ${folder}`);
  }

  header() {
    this.transcript.add(
      (w) => {
        const pic = beetle('idle');
        const entry = this.router.current ?? this.router.candidates().awake[0] ?? this.router.candidates().list[0];
        const provider = entry?.provider?.label ?? 'sin modelo';
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '\u0000';
        const info = [
          '',
          `${bold('Bichi Code')} ${c.soft(`v${VERSION}`)}`,
          `${c.sky(this.modelLabel())} ${c.soft(`· ${provider}`)}`,
          c.soft(this.cwd.replace(home, '~')),
          '',
          dim('/help comandos · @ archivos · alt+v imagen · shift+tab modos'),
        ];
        if (w < 50) return info.filter(Boolean);
        const lines = [];
        for (let i = 0; i < Math.max(pic.length, info.length); i++) lines.push(`  ${pad(pic[i] ?? '', 16)}  ${info[i] ?? ''}`);
        return lines;
      },
      { gap: 0 },
    );
  }

  async exit(code = 0) {
    clearInterval(this.ticker);
    this.saveSession();
    flushState(this.state);
    killAll();
    this.term.leave();
    const total = this.agent.usage.prompt + this.agent.usage.completion;
    const lines = [`${c.brand('●')} ${c.ice('hasta luego')}${total ? c.soft(`  · ${formatTokens(total)} tokens en esta sesion`) : ''}`];
    if (this.session.messages.length) lines.push(c.soft(`  para seguir: bichi -r ${this.session.id}`));
    process.stdout.write(`${lines.join('\n')}\n`);
    process.stdin.setRawMode?.(false);
    process.exit(code);
  }

  saveSession() {
    this.session.messages = this.agent.messages;
    this.session.todos = this.agent.todos;
    this.session.model = this.config.model;
    saveSession(this.session);
  }

  async refreshFiles() {
    try {
      this.files = await listFiles(this.cwd);
    } catch {
      this.files = [];
    }
  }

  // ---------- historial ----------

  add(render, options) {
    const item = this.transcript.add(render, options);
    this.schedule();
    return item;
  }

  // Texto suelto en el historial (lo usan los comandos).
  print(text) {
    const value = String(text ?? '');
    this.add(() => value.replace(/^\n+|\n+$/g, '').split('\n'), { gap: value.startsWith('\n') || value.startsWith('\r') ? 1 : 0 });
  }

  space() {}

  note(text, color = c.soft) {
    this.add(() => [notice(text, color)], { gap: 0 });
  }

  clearConversation() {
    this.saveSession();
    this.session = { id: newSessionId(), cwd: this.cwd, created: Date.now(), messages: [] };
    this.agent.messages = this.session.messages;
    this.agent.todos = [];
    this.agent.turns = [];
    this.agent.goal = null;
    this.agent.usage = { prompt: 0, completion: 0, lastPrompt: 0 };
    this.transcript.clear();
    this.header();
    this.follow = true;
    this.render();
  }

  // Rehace el historial desde los mensajes (al retomar, importar o rebobinar).
  replay() {
    this.transcript.clear();
    this.header();
    const results = new Map(this.agent.messages.filter((message) => message.role === 'tool').map((message) => [message.tool_call_id, message.content]));
    const tools = this.agent.tools();
    for (const message of this.agent.messages) {
      if (message.role === 'user' && typeof message.content === 'string') {
        const text = stripAttachments(message.content);
        if (/^\((Esta conversacion se resumio|Se recorto|Conversacion importada)/.test(text)) this.add(() => [notice('conversacion anterior resumida', c.plum)]);
        else this.add((w) => userBlock(text.replace(/^\((mensaje del usuario|sigue con el objetivo|nota)[^)]*\)\n?/, ''), w).map(highlightTags));
      } else if (message.role === 'assistant') {
        if (message.content && message.content !== 'Entendido, sigo desde aqui.') {
          const text = message.content;
          this.add((w) => assistantLines(text, w));
        }
        for (const call of message.tool_calls ?? []) {
          const result = String(results.get(call.id) ?? '');
          let input = {};
          try {
            input = JSON.parse(call.function.arguments || '{}');
          } catch {
            /* argumentos rotos */
          }
          const tool = tools.find((item) => item.name === call.function.name);
          const label = tool ? safe(() => tool.label(input, { cwd: this.cwd })) : { title: call.function.name, arg: '' };
          const first = result.split('\n').find(Boolean) ?? '';
          this.add((w) => [toolTitle({ label }, result.startsWith('error') ? 'error' : 'done'), `  ${c.soft('╰')}  ${c.soft(truncate(first, w - 8))}`]);
        }
      }
    }
    this.follow = true;
    this.render();
  }

  // ---------- dibujo ----------

  schedule() {
    if (!this.pending) this.pending = setTimeout(() => this.render(), 33);
  }

  render() {
    clearTimeout(this.pending);
    this.pending = null;
    if (!this.term.active) return;
    const { width: W, height: H } = this.term.size();
    const bottom = this.bottom(W, H);
    const viewH = Math.max(1, H - bottom.lines.length);
    const all = this.transcript.lines(W);
    const maxTop = Math.max(0, all.length - viewH);
    this.top = this.follow ? maxTop : Math.min(this.top, maxTop);
    if (this.top >= maxTop) this.follow = true;
    this.viewH = viewH;
    this.allLines = all;
    const view = all.slice(this.top, this.top + viewH).map((line, i) => paintSelection(line, this.top + i, this.selection));
    while (view.length < viewH) view.push('');
    const cursor = bottom.cursor ? { row: viewH + bottom.cursor.row, col: bottom.cursor.col } : null;
    this.term.draw([...view, ...bottom.lines], cursor);
  }

  modelLabel() {
    const entry = this.router.current ?? this.router.candidates().awake[0] ?? this.router.candidates().list[0];
    if (this.config.model === 'auto') return entry ? `auto · ${displayName(this.config, entry)}` : 'auto';
    return entry ? displayName(this.config, entry) : this.config.model;
  }

  // Parte de abajo: trabajo en curso, sugerencias, entrada entre lineas y barra de estado.
  bottom(W, H) {
    const lines = [];
    let cursor = null;
    if (!this.follow) lines.push(c.soft('  ↓ hay mas abajo · rueda o av pag para bajar'));
    if (this.running && !this.overlay) {
      lines.push('');
      lines.push(this.spinnerLine());
      if (this.showTodos && this.agent.todos.some((item) => item.status !== 'completed')) {
        todoLines(this.agent.todos).forEach((line, i) => lines.push(`  ${i ? ' ' : c.soft('╰')}  ${line}`));
      }
    }
    for (const text of this.agent.queue) lines.push(c.soft(`  › ${truncate(text.replace(/\s+/g, ' '), W - 20)}  (en cola)`));
    const rule = c.soft('─'.repeat(W - 1));
    if (this.overlay) {
      const rendered = this.overlay.render(W);
      const block = Array.isArray(rendered) ? rendered : rendered.lines;
      const room = Math.max(4, H - 4 - lines.length);
      const cut = Math.max(0, block.length - room);
      lines.push('');
      if (!Array.isArray(rendered)) cursor = { row: lines.length + rendered.cursor.row - cut, col: rendered.cursor.col };
      lines.push(...block.slice(cut));
    } else {
      lines.push(...this.suggestionLines(W));
      const [glyph, effort] = EFFORT[this.config.effort] ?? EFFORT.medium;
      const right = `${c.sky(this.modelLabel())} ${c.soft('·')} ${c.soft(`${glyph} ${effort} · /effort`)}`;
      lines.push(' '.repeat(Math.max(0, W - 2 - width(right))) + right);
      lines.push(rule);
      const input = this.inputLines(W);
      cursor = { row: lines.length + input.cursor.row, col: input.cursor.col };
      lines.push(...input.lines);
      lines.push(rule);
    }
    lines.push(this.footer(W));
    return { lines, cursor };
  }

  spinnerLine() {
    const seconds = Math.floor((Date.now() - this.running.started) / 1000);
    const tokens = this.running.chars ? ` · ↓ ${formatTokens(Math.round(this.running.chars / 3.6))} tokens` : '';
    const what = this.thinking ? ' · pensando' : '';
    return `${c.brand(SPIN[this.tick % SPIN.length])} ${shimmer(`${this.running.verb}…`, this.tick)} ${c.soft(`(${clock(seconds)}${tokens}${what} · esc para interrumpir)`)}`;
  }

  inputLines(W) {
    const inner = W - 4;
    const { rows, cursor } = this.editor.layout(inner);
    const text = this.editor.text;
    const prompt = text.startsWith('!') ? c.warn('!') : text.startsWith('#') ? c.plum('#') : this.running ? c.soft('❯') : c.brand('❯');
    if (!text) {
      const placeholder = this.running ? 'escribe para redirigir a bichi sin parar el trabajo' : 'Prueba "explicame este proyecto" o "arregla los tests"';
      return { lines: [`${prompt} ${dim(placeholder)}`], cursor: { row: 0, col: 2 } };
    }
    const shift = rows.length > MAX_INPUT_ROWS ? Math.max(0, Math.min(cursor.row - MAX_INPUT_ROWS + 1, rows.length - MAX_INPUT_ROWS)) : 0;
    const lines = rows.slice(shift, shift + MAX_INPUT_ROWS).map((row, i) => `${i === 0 && shift === 0 ? prompt : ' '} ${highlightTags(row)}`);
    return { lines, cursor: { row: cursor.row - shift, col: 2 + cursor.col } };
  }

  footer(W) {
    const info = MODE_INFO[this.mode];
    let left;
    if (this.hint && Date.now() < this.hint.until) left = c.soft(`  ${this.hint.text}`);
    else if (this.editor.text.startsWith('!')) left = c.warn('  ! modo shell: enter ejecuta el comando aqui mismo');
    else if (this.editor.text.startsWith('#')) left = c.plum('  # enter guarda esto en la memoria');
    else if (this.mode === 'normal') left = c.soft('  ? atajos · shift+tab para cambiar de modo');
    else left = `  ${c[info.color](`▸▸ ${info.label}`)} ${c.soft('(shift+tab para cambiar)')}`;
    const parts = [];
    if (this.agent.subagents) parts.push(c.plum(`← ${this.agent.subagents} ${this.agent.subagents === 1 ? 'agente' : 'agentes'}`));
    if (this.agent.goal && !this.agent.goal.done) parts.push(c.ok(`◎ objetivo · ronda ${this.agent.goal.rounds + 1}`));
    const ctx = Math.min(100, Math.round((this.agent.contextUsed() / this.agent.contextLimit()) * 100));
    if (ctx >= 30) parts.push(ctx >= 65 ? c.warn(`contexto ${ctx}%`) : c.soft(`contexto ${ctx}%`));
    const right = parts.join(c.soft(' · '));
    const gap = W - 2 - width(left) - width(right);
    return gap > 1 ? `${left}${' '.repeat(gap)}${right}` : left;
  }

  suggestionLines(W) {
    const list = this.suggestions;
    if (!list?.items.length) return [];
    const nameWidth = Math.min(32, Math.max(...list.items.map((item) => width(item.label))) + 3);
    const descWidth = W - nameWidth - 8;
    const out = [];
    list.items.forEach((item, i) => {
      const active = i === list.index;
      const name = pad(active ? bold(c.sky(item.label)) : c.ice(item.label), nameWidth);
      const all = item.hint && descWidth > 12 ? wrap(item.hint, descWidth) : [''];
      const desc = all.slice(0, 2);
      if (all.length > 2) desc[1] = truncate(`${desc[1]} …`, descWidth);
      desc.forEach((part, k) => out.push(`  ${k === 0 && active ? c.brand('❯') : ' '} ${k === 0 ? name : ' '.repeat(nameWidth)}${active ? c.sky(part) : c.soft(part)}`));
    });
    return out;
  }

  // ---------- completado de /comandos y @archivos ----------

  updateSuggestions() {
    const token = this.editor.token();
    if (!token) return (this.suggestions = null);
    const query = token.text.slice(1);
    let items = [];
    if (token.text.startsWith('/') && token.atStart) {
      const lower = query.toLowerCase();
      const custom = loadCommands(this.cwd).map((command) => ({ name: command.name, description: command.description }));
      const skills = listSkills(this.cwd).map((skill) => ({ name: skill.name, description: `(skill) ${skill.description}` }));
      items = [...COMMANDS.filter((command) => !command.hidden), ...custom, ...skills]
        .filter((command) => command.name.startsWith(lower) || (lower.length > 1 && command.name.includes(lower)))
        .sort((a, b) => b.name.startsWith(lower) - a.name.startsWith(lower))
        .slice(0, 8)
        .map((command) => ({ label: `/${command.name}`, hint: command.description, value: `/${command.name} ` }));
    } else if (token.text.startsWith('@')) items = this.pathSuggestions(query);
    this.suggestions = items.length ? { items, index: Math.min(this.suggestions?.index ?? 0, items.length - 1), token } : null;
  }

  // Carpetas y archivos como en un explorador; sin barra, ademas busqueda en todo el proyecto.
  pathSuggestions(query) {
    const normalized = query.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    const dir = slash >= 0 ? normalized.slice(0, slash + 1) : '';
    const rest = normalized.slice(slash + 1).toLowerCase();
    const children = new Map();
    for (const file of this.files) {
      if (!file.startsWith(dir)) continue;
      const tail = file.slice(dir.length);
      const cut = tail.indexOf('/');
      const name = cut >= 0 ? tail.slice(0, cut + 1) : tail;
      const lower = name.toLowerCase();
      if (rest && !lower.startsWith(rest) && !(rest.length > 1 && lower.includes(rest))) continue;
      children.set(name, cut >= 0);
    }
    const entries = [...children.entries()].sort(([a, dirA], [b, dirB]) => dirB - dirA || a.localeCompare(b)).map(([name, isDir]) => ({ path: dir + name, isDir }));
    if (!dir && rest.length > 1 && entries.length < 8) {
      const seen = new Set(entries.map((entry) => entry.path));
      for (const file of this.files) {
        if (entries.length >= 8) break;
        if (!seen.has(file) && file.toLowerCase().includes(rest)) entries.push({ path: file, isDir: false });
      }
    }
    return entries.slice(0, 8).map((entry) => ({ label: `+ ${entry.path}`, value: entry.isDir ? `@${entry.path}` : `@${entry.path} ` }));
  }

  acceptSuggestion() {
    const list = this.suggestions;
    const item = list.items[list.index];
    this.editor.replaceToken(this.editor.token() ?? list.token, item.value);
    this.suggestions = null;
    return item;
  }

  // ---------- raton ----------

  onMouse(event) {
    if (!event) return;
    if (event.type === 'wheelup') return this.scroll(-3);
    if (event.type === 'wheeldown') return this.scroll(3);
    const inView = event.y < this.viewH;
    if (event.type === 'press' && event.button === 0) {
      this.selection = null;
      this.pressed = inView ? { line: this.top + event.y, col: event.x } : null;
      return this.render();
    }
    if (event.type === 'drag' && this.pressed) {
      if (event.y >= this.viewH) this.scroll(1);
      if (event.y <= 0) this.scroll(-1);
      this.selection = { start: this.pressed, end: { line: this.top + Math.min(event.y, this.viewH - 1), col: event.x } };
      return this.render();
    }
    if (event.type === 'release' && this.pressed) {
      const start = this.pressed;
      this.pressed = null;
      if (this.selection) {
        const text = selectedText(this.allLines, this.selection);
        if (text.trim()) {
          this.term.copy(text);
          copyNative(text);
          this.flash('copiado al portapapeles');
        }
        return this.render();
      }
      const line = this.allLines[start.line] ?? '';
      const link = linksIn(line).find((item) => start.col >= item.from && start.col < item.to);
      if (link) {
        openTarget(link.url);
        this.flash(`abriendo ${link.url.replace(/^file:\/\/\/?/, '')}`);
      }
    }
  }

  scroll(delta) {
    const maxTop = Math.max(0, this.allLines.length - this.viewH);
    this.top = Math.max(0, Math.min(maxTop, this.top + delta));
    this.follow = this.top >= maxTop;
    this.render();
  }

  flash(text, ms = 2500) {
    this.hint = { text, until: Date.now() + ms };
    setTimeout(() => this.schedule(), ms + 10);
    this.schedule();
  }

  // ---------- teclas ----------

  async onKey(key) {
    if (key.name === 'mouse') return this.onMouse(parseMouse(key.sequence));
    this.selection = null;
    if (key.name === 'pageup') return this.scroll(-(this.viewH - 2));
    if (key.name === 'pagedown') return this.scroll(this.viewH - 2);
    if (this.overlay) {
      this.overlay.key(key);
      return this.render();
    }
    const editor = this.editor;
    const name = key.name;

    if (key.ctrl && name === 'c') {
      if (this.running) return this.interrupt();
      if (editor.text) {
        editor.clear();
        this.suggestions = null;
        return this.render();
      }
      if (Date.now() - this.lastCtrlC < 1500) return this.exit();
      this.lastCtrlC = Date.now();
      return this.flash('pulsa ctrl+c otra vez para salir', 1500);
    }
    if (key.ctrl && name === 'd' && !editor.text) return this.exit();
    if (name === 'escape') {
      if (this.suggestions) {
        this.suggestions = null;
        return this.render();
      }
      if (this.running) return this.interrupt();
      const double = Date.now() - this.lastEsc < 600;
      this.lastEsc = Date.now();
      if (double) {
        if (editor.text) editor.clear();
        else return this.rewind();
      } else this.flash(editor.text ? 'esc otra vez para borrar' : 'esc otra vez para volver a un mensaje anterior', 600);
      return this.render();
    }
    if (name === 'tab' && key.shift) {
      this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
      return this.render();
    }
    if (this.suggestions) {
      const list = this.suggestions;
      if (name === 'up' || name === 'down') {
        list.index = (list.index + (name === 'up' ? -1 : 1) + list.items.length) % list.items.length;
        return this.render();
      }
      if (name === 'tab' || (name === 'enter' && !key.meta && !key.ctrl)) {
        const item = this.acceptSuggestion();
        if (name === 'enter' && item.label.startsWith('/')) return this.submit();
        this.updateSuggestions();
        return this.render();
      }
    }
    if (name === 'enter') {
      if (key.meta || key.ctrl || key.shift) editor.insert('\n');
      else if (editor.text.slice(0, editor.cursor).endsWith('\\')) {
        editor.backspace();
        editor.insert('\n');
      } else return this.submit();
    } else if (name === 'paste') this.paste(key.paste);
    else if (key.meta && name === 'v') return this.pasteImage();
    else if (name === 'backspace') key.meta || key.ctrl ? editor.deleteWord() : this.backspace();
    else if (name === 'delete') editor.del();
    else if (name === 'left') key.ctrl || key.meta ? editor.wordLeft() : editor.left();
    else if (name === 'right') key.ctrl || key.meta ? editor.wordRight() : editor.right();
    else if (name === 'home' || (key.ctrl && name === 'a')) editor.home();
    else if (name === 'end' || (key.ctrl && name === 'e')) editor.end();
    else if (name === 'up') {
      if (!editor.up()) editor.historyPrev();
    } else if (name === 'down') {
      if (!editor.down()) editor.historyNext();
    } else if (key.ctrl && name === 'u') editor.killToStart();
    else if (key.ctrl && name === 'k') editor.killToEnd();
    else if (key.ctrl && name === 'w') editor.deleteWord();
    else if (key.ctrl && name === 'l') {
      this.term.prev = [];
      return this.render();
    } else if (key.ctrl && name === 'o') return this.toggleVerbose();
    else if (key.ctrl && name === 'r') return this.searchHistory();
    else if (key.ctrl && name === 't') {
      this.showTodos = !this.showTodos;
      this.flash(this.showTodos ? 'lista de tareas visible' : 'lista de tareas oculta');
    } else if (key.meta && name === 'b') editor.wordLeft();
    else if (key.meta && name === 'f') editor.wordRight();
    else if (name === '?' && !editor.text) {
      this.add(() => shortcutsLines());
      return this.render();
    } else if (key.text && !key.ctrl && !key.meta) editor.insert(key.text);
    this.updateSuggestions();
    this.render();
  }

  // Una marca de imagen se borra entera.
  backspace() {
    const before = this.editor.text.slice(0, this.editor.cursor);
    const tag = /\[Imagen #\d+\]$/.exec(before);
    if (!tag) return this.editor.backspace();
    this.editor.text = this.editor.text.slice(0, this.editor.cursor - tag[0].length) + this.editor.text.slice(this.editor.cursor);
    this.editor.cursor -= tag[0].length;
  }

  // Pegar (o arrastrar a la terminal) la ruta de una imagen la adjunta como [Imagen #n].
  paste(text) {
    const image = imagePath(text, this.cwd);
    if (image) return this.attach(storeImage(image));
    this.editor.paste(text);
  }

  attach(image) {
    const tag = `[Imagen #${++this.imageCount}]`;
    this.images.set(tag, image);
    const before = this.editor.text.slice(0, this.editor.cursor);
    this.editor.insert(`${before && !/\s$/.test(before) ? ' ' : ''}${tag} `);
    this.updateSuggestions();
    this.render();
  }

  async pasteImage() {
    this.flash('leyendo el portapapeles…');
    const image = await clipboardImage().catch(() => null);
    if (!image) return this.flash('no hay ninguna imagen en el portapapeles');
    this.attach(image);
  }

  toggleVerbose() {
    this.config.verbose = !this.config.verbose;
    saveConfig(this.config);
    this.transcript.items.forEach((item) => item.update());
    this.flash(this.config.verbose ? 'detalle: resultados completos y razonamiento visibles (ctrl+o)' : 'detalle oculto (ctrl+o)');
    this.render();
  }

  async searchHistory() {
    const found = await this.overlayRun(new HistorySearch(this.editor.history));
    if (found) this.editor.set(found);
    this.render();
  }

  interrupt() {
    if (!this.running) return;
    this.running.interrupted = true;
    if (this.agent.goal) this.agent.goal.paused = true;
    this.agent.interrupt();
  }

  // ---------- enviar ----------

  async submit() {
    const raw = this.editor.value();
    const text = raw.trim();
    this.suggestions = null;
    if (!text) return this.render();
    this.editor.remember(raw);
    this.state.history = this.editor.history;
    saveState(this.state);
    this.editor.clear();
    this.follow = true;

    if (this.running) {
      if (text.startsWith('/')) return this.flash('espera a que termine (o pulsa esc) para usar comandos');
      this.agent.steer(text);
      return this.render();
    }
    if (text.startsWith('/')) {
      const [command, ...rest] = text.slice(1).split(/\s+/);
      this.render();
      return runCommand(this, command.toLowerCase(), rest.join(' ').trim(), text);
    }
    if (text.startsWith('!')) return this.runShell(text.slice(1).trim());
    if (text.startsWith('#')) return this.remember(text.slice(1).trim());
    return this.send(text);
  }

  async send(text, { display = text } = {}) {
    this.follow = true;
    const images = [...this.images].filter(([tag]) => text.includes(tag));
    this.add((w) => userBlock(display, w).map(highlightTags));
    await this.run(async () => {
      let content = this.withContext(text);
      for (const [tag, image] of images) {
        const item = this.add(() => [notice(`mirando ${tag}…`, c.plum)], { gap: 0 });
        const description = await describe(this.router, image);
        item.render = () => [notice(`${tag} vista`, c.plum)];
        item.update();
        content += `\n\n${tag} (${image.name}, guardada en ${image.file}):\n${description}`;
      }
      await this.agent.send(content);
    });
    await this.pursueGoal();
  }

  // /goal: mientras el objetivo no este cumplido, bichi sigue trabajando solo (con un tope de rondas).
  async pursueGoal() {
    const goal = this.agent.goal;
    if (!goal) return;
    if (goal.done) {
      const summary = goal.done;
      this.agent.goal = null;
      this.add(() => [notice(`objetivo cumplido: ${summary}`, c.ok)]);
      return this.render();
    }
    if (goal.paused || goal.rounds >= GOAL_ROUNDS) {
      goal.paused = true;
      this.add(() => [notice('objetivo en pausa · /goal para seguir, /goal off para dejarlo', c.warn)]);
      return this.render();
    }
    goal.rounds++;
    this.add(() => [notice(`objetivo · ronda ${goal.rounds + 1}`, c.ok)]);
    await this.run(() => this.agent.send(`(sigue con el objetivo: ${goal.text}. Revisa que falta, hazlo y verificalo. Si ya esta cumplido del todo, llama goal_done.)`));
    return this.pursueGoal();
  }

  withContext(text) {
    const extra = [...this.pendingContext.splice(0)];
    for (const match of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
      const file = path.resolve(this.cwd, match[1]);
      try {
        if (existsSync(file) && readFileSync(file).length < 200_000) extra.push(`<archivo ruta="${match[1]}">\n${readFileSync(file, 'utf8')}\n</archivo>`);
      } catch {
        /* carpeta o ilegible: queda la mencion */
      }
    }
    if (this.interruptedLast) {
      extra.push('(nota: el usuario interrumpio tu trabajo anterior)');
      this.interruptedLast = false;
    }
    return extra.length ? `${extra.join('\n\n')}\n\n${text}` : text;
  }

  async run(job) {
    this.running = { started: Date.now(), verb: VERBS[Math.floor(Math.random() * VERBS.length)], chars: 0 };
    this.verbTimer = setInterval(() => {
      if (this.running) this.running.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    }, 9000);
    this.setTitle();
    this.render();
    try {
      await job();
    } catch (error) {
      this.endText();
      if (error.name === 'AbortError') {
        this.note('interrumpido · dime que hago distinto', c.warn);
        this.interruptedLast = true;
      } else {
        this.note(error.message, c.err);
        this.note('prueba otra vez, /model para elegir otro modelo o /config para tus claves');
      }
    } finally {
      clearInterval(this.verbTimer);
      this.endText();
      for (const item of this.toolItems.values()) item.remove();
      this.toolItems.clear();
      this.running = null;
      this.saveSession();
      this.setTitle();
      this.refreshFiles();
      this.render();
    }
  }

  // ---------- eventos del agente ----------

  endText() {
    this.assistant = null;
    this.closeThinking();
  }

  closeThinking() {
    const thinking = this.thinking;
    if (!thinking) return;
    this.thinking = null;
    thinking.seconds = Math.max(1, Math.round((Date.now() - thinking.started) / 1000));
    if (thinking.seconds < 2 && !this.config.verbose) thinking.remove();
    else thinking.update();
  }

  agentUi() {
    return {
      onModel: () => this.schedule(),
      onReasoning: (text) => {
        if (!this.thinking) {
          const item = this.add((w) =>
            item.seconds
              ? reasoningBlock(this.config.verbose ? item.text : '', item.seconds, w)
              : [`${c.plum('»')} ${dim('pensando…')}`, ...(this.config.verbose ? wrap(dim(item.text.slice(-800)), w - 4).map((line) => `  ${line}`) : [])],
          );
          item.text = '';
          item.started = Date.now();
          this.thinking = item;
        }
        this.thinking.text += text;
        this.thinking.update();
        if (this.running) this.running.chars += text.length;
        this.schedule();
      },
      onText: (text) => {
        this.closeThinking();
        if (!this.assistant) {
          if (!text.trim()) return;
          const item = this.add((w) => assistantLines(item.text, w));
          item.text = '';
          this.assistant = item;
          text = text.replace(/^\s+/, '');
        }
        this.assistant.text += text;
        this.assistant.update();
        if (this.running) this.running.chars += text.length;
        this.schedule();
      },
      onAssistantEnd: () => this.endText(),
      onSwitch: (info) => {
        if (info.reset && this.assistant) {
          this.assistant.remove();
          this.assistant = null;
        }
        const from = displayName(this.config, info.from);
        if (info.to && info.to !== info.from) this.note(`${from}: ${info.reason} · sigo con ${displayName(this.config, info.to)}`, c.warn);
        else if (!info.to) this.note(`${from}: ${info.reason}`, c.warn);
      },
      onToolStart: (view) => {
        this.endText();
        const item = this.add((w) => this.toolRender(view, w));
        this.toolItems.set(view.id, item);
      },
      onToolProgress: (id, output) => {
        const item = this.toolItems.get(id);
        if (item) item.progress = output.slice(-2000);
      },
      onSubActivity: (id, sub, reason) => {
        const item = this.toolItems.get(id);
        if (item) (item.activity ??= []).push(`${sub.label.title} ${sub.label.arg ?? ''}${reason ? ` (${reason})` : ''}`.trim());
        this.schedule();
      },
      onSubagents: () => this.schedule(),
      onToolEnd: (view, outcome) => {
        const item = this.toolItems.get(view.id);
        this.toolItems.delete(view.id);
        const done = (w) => toolBlock(view, outcome, { columns: w, verbose: this.config.verbose });
        if (item) {
          item.render = done;
          item.update();
        } else this.add(done);
        this.schedule();
      },
      onToolDenied: (view, reason) => {
        this.endText();
        this.add(() => deniedBlock(view, reason));
      },
      onNotice: (text) => this.note(text, c.warn),
      onSteer: (text) => {
        this.endText();
        this.add((w) => userBlock(text, w));
      },
      onCompact: (phase) => {
        if (phase === 'start') this.note('el contexto se esta llenando: resumiendo la conversacion con los modelos gratis…', c.plum);
        else this.note('conversacion resumida, sigo con espacio libre', c.ok);
      },
      permission: (view, preview, rule) => this.askPermission(view, preview, rule),
      allowProject: (rule) => addProjectAllow(this.cwd, rule),
      question: (question, options) => this.askQuestion(question, options),
      approvePlan: (plan) => this.approvePlan(plan),
    };
  }

  toolRender(view, w) {
    const item = this.toolItems.get(view.id);
    const lines = [toolTitle(view, 'running').replace('●', this.tick % 8 < 4 ? c.brand('●') : c.deep('●'))];
    if (item?.progress) for (const line of item.progress.trimEnd().split('\n').slice(-4)) lines.push(`    ${dim(truncate(strip(line), w - 8))}`);
    for (const activity of (item?.activity ?? []).slice(-4)) lines.push(`  ${c.soft('╰')}  ${dim(truncate(activity, w - 8))}`);
    return lines;
  }

  // ---------- dialogos ----------

  async overlayRun(widget) {
    this.overlay = widget;
    this.render();
    try {
      return await widget.promise;
    } finally {
      this.overlay = null;
      this.render();
    }
  }

  choose(spec) {
    return this.overlayRun(new Menu(spec));
  }

  field(spec) {
    return this.overlayRun(new Field(spec));
  }

  async askPermission(view, preview, rule) {
    this.endText();
    const name = view.tool.name;
    const body = [];
    const { width: W, height: H } = this.term.size();
    const room = Math.max(6, H - 16);
    if (name === 'shell') {
      body.push(c.ice(String(view.input.command)));
      if (view.input.description) body.push(dim(view.input.description));
    } else if (preview?.ops) {
      body.push(`${c.ice(preview.file)}${preview.created ? c.soft('  (nuevo)') : ''}`);
      body.push(...renderDiff(preview.ops, { columns: Math.min(W, 100) - 8, maxLines: room }));
    } else body.push(c.ice(`${view.label.arg ?? ''}`), dim(JSON.stringify(view.input).slice(0, 300)));
    const what = name === 'shell' ? 'ejecuto este comando' : name === 'edit' ? 'aplico este cambio' : name === 'write' ? (preview?.created ? 'creo este archivo' : 'reescribo este archivo') : `uso ${view.label.title}`;
    const ruleText = rule.startsWith('shell:') ? `"${rule.slice(6)}"` : 'ediciones de archivos';
    const options = [
      { label: 'si', value: 'yes' },
      { label: `si, y no preguntes mas por ${ruleText} en esta sesion`, value: 'always' },
      ...(name === 'shell' ? [{ label: 'si, y siempre en este proyecto', value: 'project' }] : []),
      { label: 'no, y decirle que hacer distinto', value: 'no', hint: 'esc' },
    ];
    const title = view.sub ? `${view.label.title} · ${view.sub}` : view.label.title;
    const choice = await this.choose({ title, body: [...body, '', bold(`¿${what}?`)], options, escape: 'no', color: name === 'shell' ? c.warn : c.brand });
    if (choice === 'always' && name !== 'shell') this.mode = 'edits';
    if (choice !== 'no') return { choice };
    const feedback = await this.field({ title: 'que hago distinto', hint: 'cuentale a bichi que prefieres (enter vacio para solo decir que no)' });
    return { choice: 'no', feedback: feedback || '' };
  }

  async askQuestion(question, options) {
    this.endText();
    const list = options.slice(0, 6).map((option) => ({ label: option, value: option }));
    list.push({ label: 'escribir otra respuesta', value: '\u0000other' });
    const answer = await this.choose({ title: 'bichi pregunta', body: [c.ice(question)], options: list, escape: null });
    if (answer === '\u0000other') return this.field({ title: 'tu respuesta', hint: question });
    return answer;
  }

  async approvePlan(plan) {
    this.endText();
    this.add((w) => box(renderMarkdown(plan, Math.min(w, 110) - 6), Math.min(w - 1, 110), { title: 'plan', color: c.ok }));
    const choice = await this.choose({
      title: 'plan listo',
      body: ['¿sigo con este plan?'],
      options: [
        { label: 'si, y acepta las ediciones solo', value: 'edits' },
        { label: 'si, pero preguntame cada cambio', value: 'normal' },
        { label: 'no, sigue planeando', value: 'no', hint: 'esc' },
      ],
      escape: 'no',
      color: c.ok,
    });
    if (choice === 'no') {
      const feedback = await this.field({ title: 'que cambio del plan', hint: 'enter vacio para que siga investigando' });
      return { ok: false, feedback };
    }
    this.mode = choice;
    return { ok: true, mode: choice };
  }

  // Esc esc: volver a un mensaje anterior, con o sin el codigo de ese momento.
  async rewind() {
    const turns = this.agent.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith('('));
    if (!turns.length) return this.flash('aun no hay mensajes a los que volver');
    const options = turns
      .slice(-12)
      .reverse()
      .map(({ message, index }) => {
        const changed = this.agent.changedSince(index).length;
        const label = truncate(stripAttachments(message.content).replace(/\s+/g, ' '), 70);
        return { label, hint: changed ? `${changed} ${changed === 1 ? 'turno con cambios' : 'turnos con cambios'} de codigo despues` : '', value: index };
      });
    const index = await this.choose({ title: 'volver a un mensaje', body: [dim('la conversacion vuelve a antes de ese mensaje y el texto queda para editarlo.')], options, escape: null });
    if (index === null) return;
    let code = false;
    if (this.agent.changedSince(index).length) {
      const choice = await this.choose({
        title: 'restaurar',
        options: [
          { label: 'conversacion y codigo', hint: 'deshace tambien los cambios en archivos', value: 'both' },
          { label: 'solo la conversacion', hint: 'los archivos quedan como estan', value: 'chat' },
          { label: 'solo el codigo', hint: 'la conversacion sigue igual', value: 'code' },
        ],
        escape: null,
      });
      if (!choice) return;
      if (choice === 'code') {
        const files = await this.agent.restore(this.agent.changedSince(index));
        this.agent.turns = this.agent.turns.filter((turn) => turn.index < index);
        return this.note(`codigo restaurado en ${files.length} ${files.length === 1 ? 'archivo' : 'archivos'}`, c.ok);
      }
      code = choice === 'both';
    }
    const text = stripAttachments(this.agent.messages[index].content);
    const files = await this.agent.rewind(index, { code });
    this.replay();
    this.editor.set(text);
    this.note(`conversacion rebobinada${files.length ? ` y codigo restaurado en ${files.length} ${files.length === 1 ? 'archivo' : 'archivos'}` : ''}; edita el mensaje y envialo`, c.ok);
    this.render();
  }

  // ! comando: se ejecuta aqui y la salida va como contexto del siguiente mensaje.
  async runShell(command) {
    if (!command) return;
    const view = { id: 'bang', tool: shellTool, input: { command }, label: { title: 'Shell', arg: command } };
    this.add(() => [`${c.warn('!')} ${c.ice(command)}`]);
    await this.run(async () => {
      const item = this.add((w) => this.toolRender(view, w), { gap: 0 });
      this.toolItems.set('bang', item);
      const controller = new AbortController();
      this.agent.controller = controller;
      const result = await shellTool.run({ command, timeout: 600 }, { cwd: this.cwd, config: this.config, signal: controller.signal, progress: (output) => (item.progress = output.slice(-2000)) });
      this.toolItems.delete('bang');
      this.agent.controller = null;
      const lines = (result.output ?? '').split('\n');
      item.render = () => [...lines.slice(-200).map((line) => `  ${dim(line)}`), ...(result.exit ? [notice(`codigo ${result.exit}`, c.warn)] : [])];
      item.update();
      this.pendingContext.push(`(el usuario ejecuto en su terminal: ${command})\n<salida>\n${result.content.slice(0, 20000)}\n</salida>`);
    });
  }

  // # nota: a la memoria del proyecto (.bichi/BICHI.md), local o de usuario.
  async remember(note) {
    if (!note) return;
    const { paths } = await import('./config.mjs');
    const where = await this.choose({
      title: 'guardar en la memoria',
      body: [c.ice(note)],
      options: [
        { label: 'memoria del proyecto', hint: '.bichi/BICHI.md, se comparte en el repo', value: path.join(this.cwd, '.bichi', 'BICHI.md') },
        { label: 'memoria local del proyecto', hint: '.bichi/BICHI.local.md, solo para ti', value: path.join(this.cwd, '.bichi', 'BICHI.local.md') },
        { label: 'memoria de usuario', hint: 'para todos tus proyectos', value: paths.memory },
      ],
      escape: null,
    });
    if (!where) return;
    const { appendFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(where), { recursive: true });
    const exists = existsSync(where);
    const prefix = !exists ? '# Memoria para bichi\n\n' : readFileSync(where, 'utf8').endsWith('\n') ? '' : '\n';
    await appendFile(where, `${prefix}- ${note}\n`);
    this.note(`guardado en ${where}`, c.ok);
  }
}

// Respuesta de bichi: markdown con un punto delante.
export function assistantLines(text, w) {
  return renderMarkdown(text, w - 3).map((line, i) => `${i === 0 ? c.ice('●') : ' '} ${line}`);
}

// El texto que escribio el usuario, sin los archivos (@) ni las descripciones de imagenes que se le adjuntaron.
const stripAttachments = (text) =>
  text
    .replace(/<archivo ruta="[^"]+">[\s\S]*?<\/archivo>\n*/g, '')
    .replace(/\n\n\[Imagen #\d+\] \([^)]*\):\n[\s\S]*$/, '')
    .trim();

const highlightTags = (line) => line.replace(/\[(Imagen #\d+|pegado #\d+ \+\d+ lineas)\]/g, (tag) => fg('#c4a6f5')(tag));

function safe(fn) {
  try {
    return fn();
  } catch {
    return { title: '?', arg: '' };
  }
}

const clock = (seconds) => (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);

function openTarget(url) {
  const target = url.startsWith('file:') ? decodeURIComponent(url.replace(/^file:\/\/\/?/, process.platform === 'win32' ? '' : '/')) : url;
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function copyNative(text) {
  const [command, args] = process.platform === 'win32' ? ['clip', []] : process.platform === 'darwin' ? ['pbcopy', []] : ['sh', ['-c', 'wl-copy 2>/dev/null || xclip -selection clipboard']];
  try {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(process.platform === 'win32' ? Buffer.from(`﻿${text}`, 'utf16le') : text);
  } catch {
    /* sin portapapeles nativo: queda el OSC 52 */
  }
}

export function formatTokens(count) {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k` : String(count);
}

const SHORTCUTS = [
  ['enter', 'enviar'],
  ['alt+enter · ctrl+j · \\ enter', 'nueva linea'],
  ['shift+tab', 'cambiar modo: normal, acepta ediciones, plan, sin preguntas'],
  ['esc', 'interrumpir a bichi'],
  ['esc esc', 'volver a un mensaje anterior (con o sin el codigo)'],
  ['escribir mientras trabaja', 'redirigir sin parar (entra en el siguiente paso)'],
  ['/', 'comandos y skills'],
  ['@ruta', 'mencionar un archivo o carpeta (tab entra en carpetas)'],
  ['alt+v · pegar una ruta', 'adjuntar una imagen'],
  ['!comando', 'ejecutar en la shell y darselo a bichi como contexto'],
  ['#nota', 'guardar en la memoria'],
  ['ctrl+r', 'buscar en lo que escribiste antes'],
  ['ctrl+o', 'ver resultados completos y razonamiento'],
  ['ctrl+t', 'mostrar u ocultar la lista de tareas'],
  ['rueda · re pag · av pag', 'moverse por la conversacion'],
  ['arrastrar con el raton', 'seleccionar y copiar · clic en un link para abrirlo'],
  ['ctrl+c ctrl+c', 'salir'],
];

export function shortcutsLines() {
  return [bold(c.brand('atajos')), ...SHORTCUTS.map(([keys, label]) => `  ${fg('#a6d2ff')(pad(keys, 30))} ${c.soft(label)}`)];
}

export const shortcutsHelp = () => shortcutsLines().join('\n');
