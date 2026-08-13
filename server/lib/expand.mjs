/**
 * Разворачивает compRef обратно в дерево: плагин сериализует переиспользуемый
 * компонент один раз, остальные вхождения ссылаются на него. Координаты детей
 * в словаре относительны своего экземпляра, поэтому сдвигаем их на позицию
 * текущего вхождения.
 */
export function expandTree(node, lib, base = null) {
  if (!lib || !node) return node;
  const out = { ...node };

  if (node.compRef && lib[node.compRef]?.children) {
    const proto = lib[node.compRef];
    const dx = (node.x ?? 0) - (proto.x ?? 0);
    const dy = (node.y ?? 0) - (proto.y ?? 0);
    out.children = proto.children.map((c) => shift(expandTree(c, lib), dx, dy));
    return out;
  }

  if (node.children?.length) out.children = node.children.map((c) => expandTree(c, lib, base));
  return out;
}

function shift(node, dx, dy) {
  if (!dx && !dy) return node;
  const out = { ...node, x: (node.x ?? 0) + dx, y: (node.y ?? 0) + dy };
  if (node.children?.length) out.children = node.children.map((c) => shift(c, dx, dy));
  return out;
}
