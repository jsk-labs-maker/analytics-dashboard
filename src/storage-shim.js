// Storage shim — replaces Claude's window.storage with localStorage
// This makes the dashboard work outside of Claude's environment

window.storage = {
  async get(key) {
    try {
      const value = localStorage.getItem(`adsmit_${key}`);
      if (value === null) throw new Error("Key not found");
      return { key, value };
    } catch (e) {
      throw e;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(`adsmit_${key}`, value);
      return { key, value };
    } catch (e) {
      return null;
    }
  },
  async delete(key) {
    try {
      localStorage.removeItem(`adsmit_${key}`);
      return { key, deleted: true };
    } catch (e) {
      return null;
    }
  },
  async list(prefix) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(`adsmit_${prefix || ""}`)) {
        keys.push(k.replace("adsmit_", ""));
      }
    }
    return { keys };
  }
};
