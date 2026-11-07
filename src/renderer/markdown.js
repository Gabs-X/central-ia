// Renderizador de Markdown pequeno e seguro: escapa todo HTML antes de formatar.
(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank">$2</a>');
  }

  function render(md) {
    const blocks = [];
    // Guarda blocos de código para não serem formatados.
    let text = String(md || '').replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_m, _lang, code) => {
      blocks.push(`<pre><button class="copy">copiar</button><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    text = esc(text);

    const lines = text.split('\n');
    const out = [];
    let list = null;
    let para = [];
    let table = null;

    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
      list = null;
    };
    const flushTable = () => {
      if (table) {
        const [head, ...rows] = table;
        out.push(
          `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`,
        );
      }
      table = null;
    };
    const flushAll = () => { flushPara(); flushList(); flushTable(); };

    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if (/^\u0000\d+\u0000$/.test(line.trim())) {
        flushAll();
        out.push(line.trim());
      } else if (!line.trim()) {
        flushAll();
      } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        flushAll();
        out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
      } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
        flushPara(); flushTable();
        if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
        list.items.push(m[1]);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara(); flushTable();
        if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
        list.items.push(m[1]);
      } else if (/^\s*\|.*\|\s*$/.test(line)) {
        flushPara(); flushList();
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // linha separadora
        (table ||= []).push(line.trim().slice(1, -1).split('|').map((c) => c.trim()));
      } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
        flushAll();
        out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      } else {
        flushList(); flushTable();
        para.push(line);
      }
    }
    flushAll();

    return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  }

  window.renderMarkdown = render;
})();
