// La aplicacion interactiva: caja de entrada, stream de respuestas, herramientas, permisos y atajos.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { addProjectAllow, flushState, saveConfig, saveState, VERSION } from './config.mjs';
import { Agent } from './core/agent.mjs';
import { MODE_INFO, MODES } from './core/permissions.mjs';
import { loadCommands } from './core/project.mjs';
import { newSessionId, saveSession } from './core/sessions.mjs';
import { displayName } from './providers.mjs';
import { COMMANDS, runCommand } from './commands.mjs';
import { listFiles } from './tools/files.mjs';
import { killAll, shell as shellTool } from './tools/shell.mjs';
import { beetle, logo } from './ui/art.mjs';
import { deniedBlock, keyHint, notice, reasoningBlock, todoLines, toolBlock, toolTitle, userBlock } from './ui/blocks.mjs';
import { renderDiff } from './ui/diff.mjs';
import { Editor } from './ui/editor.mjs';
import { createDecoder, DISABLE_PASTE, ENABLE_PASTE } from './ui/keys.mjs';
import { Markdown } from './ui/markdown.mjs';
import { Screen } from './ui/screen.mjs';
import { bold, c, cols, dim, fg, pad, shimmer, truncate, width } from './ui/term.mjs';
import { box, Field, Menu } from './ui/widgets.mjs';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const VERBS = ['bichiando', 'rebuscando', 'tramando', 'cavilando', 'zumbando', 'escarbando', 'hilando', 'revoloteando', 'maquinando', 'rumiando', 'tejiendo', 'cocinando', 'afinando', 'husmeando', 'garabateando', 'destripando bugs'];
const EFFORT_LABEL = { low: 'esfuerzo bajo', medium: 'esfuerzo medio', high: 'esfuerzo alto' };

export class App {
  constructor({ config, state, router, cwd, settings, extraTools, session }) {
    Object.assign(this, { config, state, router, cwd, settings, extraTools });
    this.screen = new Screen();
    this.editor = new Editor(state.history);
    this.mode = MODES.includes(config.mode) ? config.mode : 'normal';
    this.overlay = null; // menu o campo activo
    this.suggestions = null;
    this.running = null; // {started, verb, tokens}
    this.tools = new Map(); // herramientas en marcha
    this.md = null;
    this.reasoning = { text: '', started: 0 };
    this.showTodos = true;
    this.lastEsc = 0;
    this.lastCtrlC = 0;
    this.pendingContext = [];
    this.lastOutput = null;
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
    process.stdout.write(ENABLE_PASTE);
    const decoder = createDecoder((key) => this.onKey(key).catch((error) => this.print(notice(error.message, c.err))));
    input.on('data', (data) => decoder.feed(data));
    process.on('SIGINT', () => this.onKey({ name: 'c', ctrl: true }));
    this.refreshFiles();
    this.screen.setLive((columns) => this.live(columns));
    this.ticker = setInterval(() => {
      this.tick++;
      if (this.running || this.tools.size) this.screen.schedule();
    }, 90);
  }

  banner() {
    const columns = cols();
    const pic = beetle('happy');
    const name = logo('BICHI CODE');
    const model = this.modelLabel();
    const info = [
      ...name,
      `${c.soft('v')}${c.sky(VERSION)} ${c.soft('·')} ${c.ice('tu bicho programador')}`,
      '',
      `${c.soft('modelo ')} ${c.sky(model)}${this.config.model === 'auto' ? c.soft('  (cambia solo si uno se agota)') : ''}`,
      `${c.soft('carpeta')} ${this.cwd.replace(process.env.HOME ?? process.env.USERPROFILE ?? '\u0000', '~')}`,
    ];
    const lines = [];
    const rows = Math.max(pic.length, info.length);
    for (let i = 0; i < rows; i++) lines.push(`${pad(pic[i] ?? '', 18)}  ${info[i] ?? ''}`);
    const w = Math.min(columns - 1, Math.max(...lines.map(width)) + 6);
    const framed = columns >= 60 ? box(lines, w, { color: c.deep, padX: 2 }) : info;
    this.print(['', ...framed, `  ${keyHint('/', 'comandos')}  ${keyHint('@', 'archivos')}  ${keyHint('!', 'shell')}  ${keyHint('shift+tab', 'modos')}  ${keyHint('esc', 'interrumpir')}`, ''].join('\n'));
  }

  async exit(code = 0) {
    clearInterval(this.ticker);
    this.saveSession();
    flushState(this.state);
    killAll();
    this.screen.release();
    process.stdout.write(DISABLE_PASTE);
    const total = this.agent.usage.prompt + this.agent.usage.completion;
    const lines = [`${c.brand('●')} ${c.ice('hasta luego')}${total ? c.soft(`  · ${formatTokens(total)} tokens en esta sesion`) : ''}`];
    if (this.session.messages.length) lines.push(c.soft(`  para seguir: bichi -r ${this.session.id}`));
    process.stdout.write(`\n${lines.join('\n')}\n`);
    process.stdin.setRawMode?.(false);
    process.exit(code);
  }

  print(text) {
    this.screen.print(text);
  }

  space() {
    this.print('');
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

  // ---------- zona viva ----------

  modelLabel() {
    const entry = this.router.current ?? this.router.candidates().awake[0] ?? this.router.candidates().list[0];
    if (this.config.model === 'auto') return entry ? `auto · ${displayName(this.config, entry)}` : 'auto';
    return entry ? displayName(this.config, entry) : this.config.model;
  }

  live(columns) {
    const lines = [];
    if (this.running && !this.overlay) lines.push(...this.activity(columns));
    if (this.md?.buffer) lines.push(`${this.mdPrefix()}${this.md.partial()}`);
    if (this.showTodos && this.running && this.agent.todos.length && this.agent.todos.some((t) => t.status !== 'completed')) {
      lines.push(...todoLines(this.agent.todos).map((line) => `  ${line}`));
    }
    if (this.agent.queue.length) for (const text of this.agent.queue) lines.push(c.soft(`  › ${truncate(text.replace(/\s+/g, ' '), columns - 8)}  (en cola)`));
    if (this.overlay) {
      if (lines.length) lines.push('');
      const rendered = this.overlay.render(columns);
      if (Array.isArray(rendered)) return { lines: [...lines, ...rendered] };
      const offset = lines.length;
      return { lines: [...lines, ...rendered.lines], cursor: { row: rendered.cursor.row + offset, col: rendered.cursor.col } };
    }
    if (lines.length) lines.push('');
    const { boxLines, cursorRow, cursorCol } = this.inputBox(columns);
    const offset = lines.length;
    lines.push(...boxLines);
    lines.push(...this.suggestionLines(columns));
    lines.push(this.statusLine(columns));
    return { lines, cursor: { row: offset + cursorRow, col: cursorCol } };
  }

  activity(columns) {
    const seconds = Math.floor((Date.now() - this.running.started) / 1000);
    const verb = this.running.verb;
    const lines = [];
    for (const view of this.tools.values()) {
      lines.push(toolTitle(view, 'running').replace('●', this.tick % 8 < 4 ? c.brand('●') : c.deep('○')));
      if (view.progress) {
        const tail = view.progress.trimEnd().split('\n').slice(-3);
        for (const line of tail) lines.push(`    ${dim(truncate(line.replace(/\x1b\[[0-9;]*m/g, ''), columns - 8))}`);
      }
      for (const item of (view.activity ?? []).slice(-3)) lines.push(`    ${c.soft('╰')} ${dim(item)}`);
    }
    const thinking = this.reasoning.started && !this.md?.buffer ? ' · pensando' : '';
    const tokens = this.running.chars ? ` · ↓ ${formatTokens(Math.round(this.running.chars / 3.6))} tokens` : '';
    const label = `${verb}…`;
    lines.push(`${c.brand(SPIN[this.tick % SPIN.length])} ${shimmer(label, this.tick)} ${c.soft(`(${seconds}s${tokens}${thinking} · esc para interrumpir)`)}`);
    return lines;
  }

  inputBox(columns) {
    const w = Math.min(columns - 1, 160);
    const inner = w - 6;
    const { rows, cursor } = this.editor.layout(inner);
    const border = this.running ? c.soft : this.mode === 'yolo' ? c.err : this.mode === 'plan' ? c.ok : this.mode === 'edits' ? c.plum : c.brand;
    const empty = !this.editor.text;
    const placeholder = this.running ? 'escribe para redirigir a bichi sin parar el trabajo' : 'pide algo, / para comandos, @ para archivos, ! para shell';
    const bang = this.editor.text.startsWith('!');
    const hash = this.editor.text.startsWith('#');
    const prompt = bang ? c.warn('!') : hash ? c.plum('#') : c.brand('›');
    const shownRows = rows.length > 12 ? rows.slice(Math.max(0, Math.min(cursor.row - 6, rows.length - 12)), Math.max(0, Math.min(cursor.row - 6, rows.length - 12)) + 12) : rows;
    const rowShift = rows.length > 12 ? Math.max(0, Math.min(cursor.row - 6, rows.length - 12)) : 0;
    const body = (empty ? [dim(placeholder)] : shownRows).map((row, i) => `${border('│')} ${i === 0 && rowShift === 0 ? prompt : ' '} ${pad(empty ? truncate(row, inner) : row, inner)} ${border('│')}`);
    const boxLines = [border(`╭${'─'.repeat(w - 2)}╮`), ...body, border(`╰${'─'.repeat(w - 2)}╯`)];
    return { boxLines, cursorRow: 1 + (empty ? 0 : cursor.row - rowShift), cursorCol: 4 + (empty ? 0 : cursor.col) };
  }

  statusLine(columns) {
    const info = MODE_INFO[this.mode];
    const left =
      this.mode === 'normal'
        ? c.soft(this.editor.text.startsWith('!') ? '  modo shell: enter ejecuta el comando' : this.editor.text.startsWith('#') ? '  enter guarda esto en la memoria' : '  ? atajos  ·  shift+tab modos')
        : `  ${c[info.color === 'soft' ? 'soft' : info.color]('▸▸ ' + info.label)} ${c.soft('(shift+tab)')}`;
    const ctx = Math.min(100, Math.round((this.agent.contextUsed() / this.agent.contextLimit()) * 100));
    const right = `${c.sky(this.modelLabel())} ${c.soft('·')} ${c.soft(EFFORT_LABEL[this.config.effort] ?? this.config.effort)}${ctx >= 5 ? ` ${c.soft('·')} ${ctx >= 70 ? c.warn(`contexto ${ctx}%`) : c.soft(`contexto ${ctx}%`)}` : ''}`;
    const gap = columns - 2 - width(left) - width(right);
    return gap > 1 ? `${left}${' '.repeat(gap)}${right}` : left;
  }

  suggestionLines(columns) {
    const list = this.suggestions;
    if (!list?.items.length) return [];
    return list.items.map((item, i) => {
      const active = i === list.index;
      const name = pad(active ? bold(c.sky(item.label)) : c.brand(item.label), Math.max(14, ...list.items.map((entry) => entry.label.length + 2)));
      return truncate(`  ${active ? c.brand('❯') : ' '} ${name} ${dim(item.hint ?? '')}`, columns - 2);
    });
  }

  // ---------- completado de /comandos y @archivos ----------

  updateSuggestions() {
    const token = this.editor.token();
    if (!token) return (this.suggestions = null);
    const query = token.text.slice(1).toLowerCase();
    let items = [];
    if (token.text.startsWith('/') && token.atStart) {
      const custom = loadCommands(this.cwd).map((command) => ({ name: command.name, description: command.description }));
      items = [...COMMANDS.filter((command) => !command.hidden), ...custom]
        .filter((command) => command.name.startsWith(query) || (query.length > 1 && command.name.includes(query)))
        .slice(0, 9)
        .map((command) => ({ label: `/${command.name}`, hint: command.description, value: `/${command.name} ` }));
    } else if (token.text.startsWith('@')) {
      const scored = [];
      for (const file of this.files) {
        const lower = file.toLowerCase();
        const base = lower.slice(lower.lastIndexOf('/') + 1);
        const at = lower.indexOf(query);
        if (query && at < 0) continue;
        scored.push({ file, score: base.startsWith(query) ? 0 : at >= 0 && lower[at - 1] === '/' ? 1 : 2 + file.length / 1000 });
        if (scored.length > 4000) break;
      }
      items = scored
        .sort((a, b) => a.score - b.score)
        .slice(0, 8)
        .map(({ file }) => ({ label: `@${file}`, value: `@${file} ` }));
    }
    this.suggestions = items.length ? { items, index: Math.min(this.suggestions?.index ?? 0, items.length - 1), token } : null;
  }

  acceptSuggestion() {
    const list = this.suggestions;
    const item = list.items[list.index];
    this.editor.replaceToken(this.editor.token() ?? list.token, item.value);
    this.suggestions = null;
    return item;
  }

  // ---------- teclas ----------

  async onKey(key) {
    if (this.overlay) {
      this.overlay.key(key);
      return this.screen.render();
    }
    const editor = this.editor;
    const name = key.name;

    if (key.ctrl && name === 'c') {
      if (this.running) return this.interrupt();
      if (editor.text) {
        editor.clear();
        this.suggestions = null;
        return this.screen.render();
      }
      if (Date.now() - this.lastCtrlC < 1500) return this.exit();
      this.lastCtrlC = Date.now();
      this.print(notice('pulsa ctrl+c otra vez para salir'));
      return;
    }
    if (key.ctrl && name === 'd' && !editor.text) return this.exit();
    if (name === 'escape') {
      if (this.suggestions) {
        this.suggestions = null;
        return this.screen.render();
      }
      if (this.running) return this.interrupt();
      const double = Date.now() - this.lastEsc < 600;
      this.lastEsc = Date.now();
      if (double) {
        if (editor.text) editor.clear();
        else return this.rewind();
      }
      return this.screen.render();
    }
    if (name === 'tab' && key.shift) {
      this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
      return this.screen.render();
    }
    if (this.suggestions) {
      const list = this.suggestions;
      if (name === 'up') {
        list.index = (list.index - 1 + list.items.length) % list.items.length;
        return this.screen.render();
      }
      if (name === 'down') {
        list.index = (list.index + 1) % list.items.length;
        return this.screen.render();
      }
      if (name === 'tab' || (name === 'enter' && !key.meta && !key.ctrl)) {
        const item = this.acceptSuggestion();
        if (name === 'enter' && item.label.startsWith('/')) return this.submit();
        this.updateSuggestions();
        return this.screen.render();
      }
    }
    if (name === 'enter') {
      if (key.meta || key.ctrl || key.shift) editor.insert('\n');
      else if (editor.text.slice(0, editor.cursor).endsWith('\\')) {
        editor.backspace();
        editor.insert('\n');
      } else return this.submit();
    } else if (name === 'paste') editor.paste(key.paste);
    else if (name === 'backspace') key.meta || key.ctrl ? editor.deleteWord() : editor.backspace();
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
    else if (key.ctrl && name === 'l') return this.screen.clear();
    else if (key.ctrl && name === 'o') return this.toggleVerbose();
    else if (key.ctrl && name === 't') {
      this.showTodos = !this.showTodos;
      if (!this.running && this.agent.todos.length) this.print(['', ...todoLines(this.agent.todos).map((line) => `  ${line}`)].join('\n'));
    } else if (key.meta && name === 'b') editor.wordLeft();
    else if (key.meta && name === 'f') editor.wordRight();
    else if (name === '?' && !editor.text) return this.print(shortcutsHelp());
    else if (key.text && !key.ctrl && !key.meta) editor.insert(key.text);
    this.updateSuggestions();
    this.screen.render();
  }

  toggleVerbose() {
    this.config.verbose = !this.config.verbose;
    saveConfig(this.config);
    this.print(notice(this.config.verbose ? 'detalle activado: resultados completos y razonamiento visibles' : 'detalle desactivado'));
    if (this.config.verbose && this.lastOutput) this.print(toolBlock(this.lastOutput.view, this.lastOutput.outcome, { columns: cols(), verbose: true }).join('\n'));
  }

  interrupt() {
    if (!this.running) return;
    this.running.interrupted = true;
    this.agent.interrupt();
  }

  // ---------- enviar ----------

  async submit() {
    const raw = this.editor.value();
    const text = raw.trim();
    this.suggestions = null;
    if (!text) return this.screen.render();
    this.editor.remember(raw);
    this.state.history = this.editor.history;
    saveState(this.state);
    this.editor.clear();

    if (this.running) {
      if (text.startsWith('/')) {
        this.print(notice('espera a que termine (o pulsa esc) para usar comandos'));
        return;
      }
      this.agent.steer(text);
      return this.screen.render();
    }
    if (text.startsWith('/')) {
      const [command, ...rest] = text.slice(1).split(/\s+/);
      return runCommand(this, command.toLowerCase(), rest.join(' ').trim(), text);
    }
    if (text.startsWith('!')) return this.runShell(text.slice(1).trim());
    if (text.startsWith('#')) return this.remember(text.slice(1).trim());
    return this.send(text);
  }

  async send(text, { display = text } = {}) {
    this.space();
    this.print(userBlock(display, cols()).join('\n'));
    const content = this.withContext(text);
    await this.run(() => this.agent.send(content));
  }

  // Adjunta archivos mencionados con @ y lo pendiente (salidas de ! y notas).
  withContext(text) {
    const extra = [...this.pendingContext.splice(0)];
    for (const match of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
      const file = path.resolve(this.cwd, match[1]);
      try {
        if (existsSync(file) && readFileSync(file).length < 200_000) extra.push(`<archivo ruta="${match[1]}">\n${readFileSync(file, 'utf8')}\n</archivo>`);
      } catch {
        /* carpeta o ilegible: se deja la mencion tal cual */
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
    this.screen.render();
    try {
      await job();
    } catch (error) {
      this.endText();
      if (error.name === 'AbortError') {
        this.print(notice('interrumpido · dime que hago distinto', c.warn));
        this.interruptedLast = true;
      } else this.print(notice(`${error.message}`, c.err) + `\n${notice('prueba otra vez, /model para elegir otro modelo o /config para tus claves')}`);
    } finally {
      clearInterval(this.verbTimer);
      this.endText();
      this.tools.clear();
      this.running = null;
      this.reasoning = { text: '', started: 0 };
      this.saveSession();
      this.screen.render();
    }
  }

  // ---------- eventos del agente ----------

  mdPrefix() {
    return this.mdFirst ? `${c.ice('●')} ` : '  ';
  }

  endText() {
    if (!this.md) return;
    const rest = this.md.end();
    if (rest.length) this.printMd(rest);
    this.md = null;
  }

  printMd(lines) {
    const out = lines.map((line) => {
      const prefixed = `${this.mdPrefix()}${line}`;
      this.mdFirst = false;
      return prefixed;
    });
    this.print(out.join('\n'));
  }

  flushReasoning() {
    if (!this.reasoning.started) return;
    const seconds = Math.max(1, Math.round((Date.now() - this.reasoning.started) / 1000));
    if (this.config.verbose || seconds >= 3) {
      this.space();
      this.print(reasoningBlock(this.config.verbose ? this.reasoning.text : '', seconds, cols()).join('\n'));
    }
    this.reasoning = { text: '', started: 0 };
  }

  agentUi() {
    return {
      onModel: () => this.screen.schedule(),
      onReasoning: (text) => {
        if (!this.reasoning.started) this.reasoning.started = Date.now();
        this.reasoning.text += text;
        if (this.running) this.running.chars += text.length;
        this.screen.schedule();
      },
      onText: (text) => {
        this.flushReasoning();
        if (!this.md) {
          if (!text.trim()) return;
          this.md = new Markdown(cols() - 3);
          this.mdFirst = true;
          this.space();
          text = text.replace(/^\s+/, '');
        }
        if (this.running) this.running.chars += text.length;
        const lines = this.md.push(text);
        if (lines.length) this.printMd(lines);
        this.screen.schedule();
      },
      onAssistantEnd: () => {
        this.flushReasoning();
        this.endText();
      },
      onSwitch: (info) => {
        this.endText();
        if (info.reset && !info.quiet) this.print(notice('(respuesta cortada, se repite)'));
        const from = displayName(this.config, info.from);
        if (info.to && info.to !== info.from) this.print(notice(`${from}: ${info.reason} · sigo con ${displayName(this.config, info.to)}`, c.warn));
        else if (!info.to) this.print(notice(`${from}: ${info.reason}`, c.warn));
      },
      onToolStart: (view) => {
        this.endText();
        this.tools.set(view.id, view);
        this.screen.schedule();
      },
      onToolProgress: (id, output) => {
        const view = this.tools.get(id);
        if (view) view.progress = output.slice(-2000);
        this.screen.schedule();
      },
      onSubActivity: (id, sub, reason) => {
        const view = this.tools.get(id);
        if (view) (view.activity ??= []).push(`${sub.label.title} ${sub.label.arg ?? ''}${reason ? ` (${reason})` : ''}`.trim());
        this.screen.schedule();
      },
      onToolEnd: (view, outcome) => {
        this.tools.delete(view.id);
        this.lastOutput = { view, outcome };
        this.space();
        this.print(toolBlock(view, outcome, { columns: cols(), verbose: this.config.verbose }).join('\n'));
      },
      onToolDenied: (view, reason) => {
        this.endText();
        this.space();
        this.print(deniedBlock(view, reason).join('\n'));
      },
      onNotice: (text) => this.print(notice(text, c.warn)),
      onSteer: (text) => {
        this.endText();
        this.space();
        this.print(userBlock(text, cols()).join('\n'));
      },
      onCompact: (phase) => {
        if (phase === 'start') this.print(notice('resumiendo la conversacion para liberar contexto…'));
        else this.print(notice('conversacion resumida', c.ok));
      },
      permission: (view, preview, rule) => this.askPermission(view, preview, rule),
      allowProject: (rule) => addProjectAllow(this.cwd, rule),
      question: (question, options) => this.askQuestion(question, options),
      approvePlan: (plan) => this.approvePlan(plan),
    };
  }

  // ---------- dialogos ----------

  async overlayRun(widget) {
    this.overlay = widget;
    this.screen.render();
    try {
      return await widget.promise;
    } finally {
      this.overlay = null;
      this.screen.render();
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
    const columns = cols();
    const room = Math.max(6, (process.stdout.rows || 30) - 16);
    if (name === 'shell') {
      body.push(c.ice(String(view.input.command)));
      if (view.input.description) body.push(dim(view.input.description));
    } else if (preview?.ops) {
      body.push(`${c.ice(preview.file)}${preview.created ? c.soft('  (nuevo)') : ''}`);
      body.push(...renderDiff(preview.ops, { columns: Math.min(columns, 100) - 8, maxLines: room }));
    } else body.push(c.ice(`${view.label.arg ?? ''}`), dim(JSON.stringify(view.input).slice(0, 300)));
    const what = name === 'shell' ? 'ejecuto este comando' : name === 'edit' ? 'aplico este cambio' : name === 'write' ? (preview?.created ? 'creo este archivo' : 'reescribo este archivo') : `uso ${view.label.title}`;
    const ruleText = rule.startsWith('shell:') ? `"${rule.slice(6)}"` : 'ediciones de archivos';
    const options = [
      { label: 'si', value: 'yes' },
      { label: `si, y no preguntes mas por ${ruleText} en esta sesion`, value: 'always' },
      ...(name === 'shell' ? [{ label: `si, y siempre en este proyecto`, value: 'project' }] : []),
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
    this.space();
    const md = new Markdown(cols() - 6);
    const lines = [...md.push(`${plan}\n`), ...md.end()];
    this.print(box(lines, Math.min(cols() - 1, 110), { title: 'plan', color: c.ok }).join('\n'));
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

  // Esc Esc: volver a un mensaje anterior (se puede editar y reenviar).
  async rewind() {
    const turns = this.agent.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith('(Esta conversacion se resumio'));
    if (!turns.length) return;
    const options = turns
      .slice(-9)
      .reverse()
      .map(({ message, index }) => ({ label: truncate(message.content.replace(/\s+/g, ' ').replace(/<archivo[\s\S]*?<\/archivo>/g, ''), 70), value: index }));
    const index = await this.choose({ title: 'volver a un mensaje', body: [dim('la conversacion vuelve a ese punto y el mensaje queda para editarlo. los archivos no cambian (para eso, /undo).')], options, escape: null });
    if (index === null) return;
    const text = this.agent.messages[index].content;
    this.agent.messages.splice(index);
    this.editor.set(text);
    this.print(notice('conversacion rebobinada; edita el mensaje y envialo'));
  }

  // ! comando: lo ejecuta directo y lo deja como contexto para el siguiente mensaje.
  async runShell(command) {
    if (!command) return;
    this.space();
    this.print(`${c.warn('!')} ${c.ice(command)}`);
    const view = { id: 'bang', tool: shellTool, input: { command }, label: { title: 'Shell', arg: command } };
    await this.run(async () => {
      this.tools.set('bang', view);
      const controller = new AbortController();
      this.agent.controller = controller;
      const result = await shellTool.run({ command, timeout: 600 }, { cwd: this.cwd, config: this.config, signal: controller.signal, progress: (output) => (view.progress = output.slice(-2000)) });
      this.tools.delete('bang');
      this.agent.controller = null;
      const output = result.output ?? '';
      const lines = output.split('\n');
      const shownLines = this.config.verbose ? lines : lines.slice(-40);
      this.print([...(lines.length > shownLines.length ? [c.soft(`  … ${lines.length - shownLines.length} lineas antes`)] : []), ...shownLines.map((line) => `  ${dim(line)}`), ...(result.exit ? [notice(`codigo ${result.exit}`, c.warn)] : [])].join('\n'));
      this.pendingContext.push(`(el usuario ejecuto en su terminal: ${command})\n<salida>\n${result.content.slice(0, 20000)}\n</salida>`);
    });
  }

  // # nota: se guarda en la memoria del proyecto o del usuario.
  async remember(note) {
    if (!note) return;
    const { paths } = await import('./config.mjs');
    const where = await this.choose({
      title: 'guardar en la memoria',
      body: [c.ice(note)],
      options: [
        { label: 'memoria del proyecto', hint: 'BICHI.md, se comparte en el repo', value: path.join(this.cwd, 'BICHI.md') },
        { label: 'memoria local del proyecto', hint: 'BICHI.local.md, solo para ti', value: path.join(this.cwd, 'BICHI.local.md') },
        { label: 'memoria de usuario', hint: 'para todos tus proyectos', value: paths.memory },
      ],
      escape: null,
    });
    if (!where) return;
    const { appendFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(where), { recursive: true });
    const prefix = existsSync(where) && !readFileSync(where, 'utf8').endsWith('\n') ? '\n' : '';
    await appendFile(where, `${prefix}- ${note}\n`);
    this.print(notice(`guardado en ${where}`, c.ok));
  }
}

export function formatTokens(count) {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k` : String(count);
}

export function shortcutsHelp() {
  const rows = [
    ['enter', 'enviar'],
    ['alt+enter · ctrl+j · \\ enter', 'nueva linea'],
    ['shift+tab', 'cambiar modo: normal, acepta ediciones, plan, sin preguntas'],
    ['esc', 'interrumpir a bichi'],
    ['esc esc', 'volver a un mensaje anterior'],
    ['escribir mientras trabaja', 'redirigir sin parar (entra en el siguiente paso)'],
    ['/', 'comandos'],
    ['@ruta', 'mencionar un archivo (se adjunta)'],
    ['!comando', 'ejecutar en la shell y darselo a bichi como contexto'],
    ['#nota', 'guardar en la memoria'],
    ['ctrl+o', 'ver resultados completos y razonamiento'],
    ['ctrl+t', 'mostrar u ocultar la lista de tareas'],
    ['ctrl+l', 'limpiar pantalla'],
    ['↑ ↓', 'historial'],
    ['ctrl+c ctrl+c', 'salir'],
  ];
  return ['', ...rows.map(([keys, label]) => `  ${fg('#a6d2ff')(pad(keys, 30))} ${c.soft(label)}`), ''].join('\n');
}
