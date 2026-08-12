export function findNode(tree, key) {
  if (key.startsWith('@')) {
    const name = key.slice(1).toLowerCase();
    let found = null;
    walk(tree, (n) => {
      if (found) return;
      const comp = (n.component ?? '').toLowerCase();
      if (comp === name || (!comp && n.name.toLowerCase() === name && (n.type === 'COMPONENT' || n.type === 'INSTANCE'))) found = n;
    });
    return found;
  }
  if (key.includes(':')) {
    let found = null;
    walk(tree, (n) => {
      if (n.id === key) found = n;
    });
    return found;
  }
  const parts = key.split('/').map((p) => p.trim().toLowerCase()).filter(Boolean);
  let scope = [tree];
  let node = null;
  for (const part of parts) {
    node = null;
    for (const s of scope) {
      const hit = findByName(s, part);
      if (hit) { node = hit; break; }
    }
    if (!node) return null;
    scope = [node];
  }
  return node;
}

function findByName(root, name) {
  const queue = [...(root.children ?? [])];
  while (queue.length) {
    const n = queue.shift();
    if (n.name.trim().toLowerCase() === name) return n;
    if (n.children) queue.push(...n.children);
  }
  return null;
}

export function walk(node, fn) {
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
}
