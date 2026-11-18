import { store } from './store.js';

const KEY = 'chats';
const TITLE_LENGTH = 42;
const listeners = new Set();

let chats = store.get(KEY, []);

const save = () => {
  chats.sort((a, b) => b.updated - a.updated);
  store.set(KEY, chats);
  listeners.forEach((listener) => listener(chats));
};

const titleOf = (text) => {
  const line = text.trim().split('\n')[0];
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}...` : line;
};

export const history = {
  all: () => chats,
  find: (id) => chats.find((chat) => chat.id === id),
  create(model) {
    return { id: crypto.randomUUID(), title: '', model, messages: [], updated: Date.now() };
  },
  push(chat, message) {
    chat.messages.push(message);
    if (!chat.title && message.role === 'user') chat.title = titleOf(message.content);
    this.touch(chat);
  },
  touch(chat) {
    chat.updated = Date.now();
    if (!chats.includes(chat)) chats.unshift(chat);
    save();
  },
  remove(id) {
    chats = chats.filter((chat) => chat.id !== id);
    save();
  },
  onChange(listener) {
    listeners.add(listener);
  },
};
