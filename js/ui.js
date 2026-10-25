// Small DOM helpers. All text goes in through textContent, never innerHTML,
// so a score title or tag can't inject markup.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

// Replace a node's children; accepts nested arrays and skips null/false.
export function fill(node, ...children) {
  clear(node);
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Modal form. fields: [{name, label, value, type, placeholder}]. Resolves to values or null.
export function promptForm(title, fields, { submit = 'Save', danger } = {}) {
  return new Promise((resolve) => {
    const inputs = fields.map((f) =>
      el('label', { class: 'field' },
        el('span', { text: f.label }),
        el('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', inputmode: f.inputmode, autocomplete: f.autocomplete })));
    const dlg = el('dialog', { class: 'modal' },
      el('form', { method: 'dialog' },
        el('h2', { text: title }),
        inputs,
        el('div', { class: 'row end' },
          el('button', { value: 'cancel', type: 'submit', class: 'ghost', text: 'Cancel' }),
          el('button', { value: 'ok', type: 'submit', class: danger ? 'danger' : 'primary', text: submit }))));
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      const out = {};
      for (const label of inputs) {
        const i = label.querySelector('input');
        out[i.name] = i.type === 'password' ? i.value : i.value.trim();
      }
      dlg.remove();
      resolve(ok ? out : null);
    });
    dlg.showModal();
    inputs[0]?.querySelector('input')?.focus();
  });
}

export function confirmBox(title, submit = 'Delete') {
  return promptForm(title, [], { submit, danger: true }).then((r) => r !== null);
}

export function toast(msg) {
  const t = el('div', { class: 'toast', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}
