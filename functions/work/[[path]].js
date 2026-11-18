// /work/* va a bichi work. Aqui no se pone la clave web: el agente solo trabaja con la clave del visitante.
import { forward } from '../../lib/origin.js';

export const onRequest = ({ request, env }) => forward(request, env);
