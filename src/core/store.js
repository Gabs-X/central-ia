// Persistência simples em JSON dentro da pasta de dados do app.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = this.#load();
    this.timer = null;
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return { ...structuredClone(this.defaults), ...JSON.parse(raw) };
    } catch {
      return structuredClone(this.defaults);
    }
  }

  // Grava com pequeno atraso para juntar várias alterações seguidas.
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

// Mescla profunda só para objetos simples (usada na configuração).
function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}

module.exports = { JsonStore, deepMerge };
