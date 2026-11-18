import { store } from './store.js';

const TITLE_LENGTH = 42;

const titleOf = (text) => {
  const line = text.trim().split('\n')[0];
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}...` : line;
};

// Historial guardado en localStorage: una entrada solo se guarda cuando recibe su primer mensaje.
export function createHistory(key, { limit = 200, onEvict = () => {} } = {}) {
  const listeners = new Set();
  let items = store.get(key, []);

  const save = () => {
    items.sort((a, b) => b.updated - a.updated);
    items.splice(limit).forEach(onEvict);
    store.set(key, items);
    listeners.forEach((listener) => listener(items));
  };

  return {
    all: () => items,
    find: (id) => items.find((item) => item.id === id),
    create: (fields = {}) => ({ id: crypto.randomUUID(), title: '', messages: [], updated: Date.now(), ...fields }),
    push(item, message) {
      item.messages.push(message);
      if (!item.title && message.role === 'user') item.title = titleOf(message.content);
      this.touch(item);
    },
    touch(item) {
      item.updated = Date.now();
      if (!items.includes(item)) items.unshift(item);
      save();
    },
    remove(id) {
      items = items.filter((item) => item.id !== id);
      save();
    },
    onChange(listener) {
      listeners.add(listener);
    },
  };
}

export const history = createHistory('chats');
