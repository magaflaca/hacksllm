// /agy/* va a bichi agy (Antigravity trabajando en la PC del usuario de bichi code). Como /work, con la clave del
// visitante y sin la clave web.
import { forward } from '../../lib/origin.js';

export const onRequest = ({ request, env }) => forward(request, env);
