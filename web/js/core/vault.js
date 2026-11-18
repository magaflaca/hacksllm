// Copia local (IndexedDB) de los archivos de cada sesion de work: subidas y entregables. Asi se pueden
// descargar y restaurar aunque el servidor ya haya borrado el espacio.
const DB = 'hacksllm-work';
const STORE = 'files';
export const MAX_FILE = 25 * 1024 * 1024;
const BUDGET = 400 * 1024 * 1024;

let opening = null;
const database = () =>
  (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('session', 'session');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));

async function tx(mode, work) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const result = work(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

export const vault = {
  async put(session, path, blob) {
    if (blob.size > MAX_FILE) return false;
    try {
      await tx('readwrite', (files) => files.put({ key: `${session}/${path}`, session, path, blob, size: blob.size, saved: Date.now() }));
      await this.trim();
      return true;
    } catch {
      return false;
    }
  },
  get: (session, path) => tx('readonly', (files) => files.get(`${session}/${path}`)).catch(() => null),
  list: (session) => tx('readonly', (files) => files.index('session').getAll(session)).catch(() => []),
  async drop(session) {
    const records = await this.list(session);
    await tx('readwrite', (files) => records.forEach((record) => files.delete(record.key))).catch(() => {});
  },
  // Si se pasa del presupuesto, salen primero los archivos mas viejos.
  async trim() {
    const records = (await tx('readonly', (files) => files.getAll())).sort((a, b) => a.saved - b.saved);
    let total = records.reduce((sum, record) => sum + record.size, 0);
    const doomed = [];
    while (total > BUDGET && records.length) {
      const record = records.shift();
      total -= record.size;
      doomed.push(record.key);
    }
    if (doomed.length) await tx('readwrite', (files) => doomed.forEach((key) => files.delete(key)));
  },
};
