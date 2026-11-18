// Herramientas de control: lista de tareas, preguntas al usuario, subagentes y salida del modo plan.

export const todo = {
  name: 'todo_write',
  kind: 'meta',
  description:
    'Mantiene la lista de tareas del trabajo actual (se muestra al usuario). Usala en trabajos de 3 pasos o mas: escribe la lista completa cada vez, con una sola tarea in_progress, y marca completed en cuanto termines cada una.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  label: () => ({ title: 'Tareas', arg: '' }),
  async run(input, ctx) {
    const todos = (Array.isArray(input.todos) ? input.todos : []).map((item) => ({
      content: String(item.content ?? item.task ?? item),
      status: ['pending', 'in_progress', 'completed'].includes(item.status) ? item.status : 'pending',
    }));
    ctx.agent.todos = todos;
    const done = todos.filter((item) => item.status === 'completed').length;
    return { content: 'lista actualizada', summary: `${done}/${todos.length}`, todos };
  },
};

export const ask = {
  name: 'ask_user',
  kind: 'meta',
  description: 'Pregunta algo al usuario con opciones para elegir (el usuario tambien puede escribir otra respuesta). Solo para decisiones que de verdad le tocan a el.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, description: 'de 2 a 5 opciones' },
    },
    required: ['question'],
  },
  label: (input) => ({ title: 'Pregunta', arg: input.question }),
  async run(input, ctx) {
    if (!ctx.ui?.question) return { content: 'no hay usuario para preguntar; decide tu con lo que sepas', summary: 'sin usuario' };
    const answer = await ctx.ui.question(String(input.question), (input.options ?? []).map(String));
    return { content: answer ? `el usuario respondio: ${answer}` : 'el usuario no respondio', summary: answer ?? 'sin respuesta' };
  },
};

export const task = {
  name: 'task',
  kind: 'meta',
  get description() {
    return 'Lanza un subagente con su propio contexto para una tarea autonoma (investigar el codigo, buscar en muchos archivos, hacer un cambio acotado). Devuelve su informe final. Varias llamadas en la misma respuesta corren en paralelo. Dale instrucciones completas: no ve esta conversacion.';
  },
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'que hace, en 3 a 6 palabras' },
      prompt: { type: 'string', description: 'la tarea completa y que debe devolver' },
      agent: { type: 'string', description: 'tipo de agente (opcional): general o uno de los definidos por el usuario' },
    },
    required: ['prompt'],
  },
  label: (input) => ({ title: 'Agente', arg: input.description ?? input.agent ?? 'tarea' }),
  async run(input, ctx) {
    const report = await ctx.spawn({ prompt: String(input.prompt), agent: input.agent, description: input.description });
    return { content: report.text || '(el subagente no devolvio nada)', summary: report.summary };
  },
};

export const exitPlan = {
  name: 'exit_plan_mode',
  kind: 'meta',
  description: 'En modo plan: presenta el plan final al usuario para que lo apruebe. Si lo aprueba, puedes empezar a hacer cambios.',
  parameters: { type: 'object', properties: { plan: { type: 'string', description: 'el plan en markdown' } }, required: ['plan'] },
  label: () => ({ title: 'Plan', arg: '' }),
  async run(input, ctx) {
    if (!ctx.ui?.approvePlan) return { content: 'aprobado', summary: 'aprobado' };
    const verdict = await ctx.ui.approvePlan(String(input.plan));
    if (verdict.ok) return { content: `el usuario aprobo el plan${verdict.mode === 'edits' ? ' (ediciones automaticas)' : ''}. empieza a implementarlo.`, summary: 'aprobado' };
    return { content: `el usuario no aprobo el plan.${verdict.feedback ? ` dice: ${verdict.feedback}` : ' sigue planeando y pregunta que cambiar.'}`, summary: 'no aprobado' };
  },
};
