// /codex/* va a bichi codex (los modelos de la cuenta de ChatGPT para bichi code). Como /agy, con la clave del
// visitante y sin la clave web.
import { forward } from '../../lib/origin.js';

export const onRequest = ({ request, env }) => forward(request, env);
