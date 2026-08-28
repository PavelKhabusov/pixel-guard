/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 340, height: 300 });

type Mixed<T> = T | 'mixed';

function m<T>(v: T | PluginAPI['mixed']): Mixed<T> {
  return v === figma.mixed ? 'mixed' : (v as T);
}

function toHex(c: RGB): string {
  const h = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function serPaints(paints: readonly Paint[] | PluginAPI['mixed']): any {
  if (paints === figma.mixed) return 'mixed';
  const out: any[] = [];
  for (const p of paints) {
    if (!p.visible) continue;
    if (p.type === 'SOLID') {
      out.push({ type: 'solid', color: toHex(p.color), opacity: p.opacity ?? 1 });
    } else if (p.type === 'IMAGE') {
      out.push({ type: 'image', scaleMode: p.scaleMode });
    } else {
      out.push({ type: p.type.toLowerCase() });
    }
  }
  return out;
}

function serEffects(effects: readonly Effect[]): any[] {
  const out: any[] = [];
  for (const e of effects) {
    if (!e.visible) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      out.push({
        type: e.type === 'DROP_SHADOW' ? 'drop-shadow' : 'inner-shadow',
        color: toHex(e.color), alpha: e.color.a,
        x: e.offset.x, y: e.offset.y, blur: e.radius, spread: (e as DropShadowEffect).spread ?? 0,
      });
    } else {
      out.push({ type: e.type.toLowerCase(), radius: (e as BlurEffect).radius });
    }
  }
  return out;
}

const ICON_MAX = 48;

const svgJobs: Array<{ node: SceneNode; box: any }> = [];

function serialize(node: SceneNode, root: { x: number; y: number }): any {
  const o: any = { id: node.id, name: node.name, type: node.type };
  // a mask (clipPath from an imported SVG) is not a visible shape — the overlay
  // would otherwise draw it as a solid black square under the icon
  if ('isMask' in node && (node as any).isMask) o.mask = true;
  const box = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;
  if (box) {
    o.x = Math.round((box.x - root.x) * 10) / 10;
    o.y = Math.round((box.y - root.y) * 10) / 10;
    o.w = Math.round(box.width * 10) / 10;
    o.h = Math.round(box.height * 10) / 10;
  }
  if ('opacity' in node && node.opacity !== 1) o.opacity = node.opacity;
  if (node.type === 'TEXT') {
    const rb = node.absoluteRenderBounds;
    if (rb && box) {
      o.renderW = Math.round(rb.width * 10) / 10;
      o.renderH = Math.round(rb.height * 10) / 10;
    }
    o.autoResize = node.textAutoResize;
  }

  if ('fills' in node) {
    const fills = serPaints(node.fills);
    if (fills === 'mixed' || fills.length) o.fills = fills;
  }
  if ('strokes' in node && node.strokes.length) {
    const strokes = serPaints(node.strokes);
    if (strokes !== 'mixed' && strokes.length) {
      o.strokes = strokes;
      o.strokeWeight = m(node.strokeWeight);
      if ('strokeAlign' in node) o.strokeAlign = node.strokeAlign;
    }
  }
  if ('clipsContent' in node && (node as FrameNode).clipsContent) o.clip = true;
  if ('cornerRadius' in node) {
    const r = m(node.cornerRadius as number | PluginAPI['mixed']);
    if (r === 'mixed') {
      const n = node as RectangleNode;
      o.cornerRadius = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
    } else if (r) o.cornerRadius = r;
  }
  if ('effects' in node && node.effects.length) {
    const eff = serEffects(node.effects);
    if (eff.length) o.effects = eff;
  }

  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    o.layout = {
      mode: node.layoutMode,
      wrap: node.layoutWrap === 'WRAP' || undefined,
      gap: node.itemSpacing,
      counterGap: node.layoutWrap === 'WRAP' ? node.counterAxisSpacing : undefined,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      align: node.primaryAxisAlignItems,
      counterAlign: node.counterAxisAlignItems,
    };
  }

  if (node.type === 'TEXT') {
    o.text = node.characters;
    const fn = m(node.fontName);
    o.font = {
      family: fn === 'mixed' ? 'mixed' : fn.family,
      style: fn === 'mixed' ? 'mixed' : fn.style,
      size: m(node.fontSize),
      weight: m(node.fontWeight),
      lineHeight: m(node.lineHeight),
      letterSpacing: m(node.letterSpacing),
      case: m(node.textCase),
      decoration: m(node.textDecoration),
      align: node.textAlignHorizontal,
    };
    // mixed colour/weight inside one text ("Форма: Лэндхаус" — grey label, dark value):
    // export the styled runs so the overlay can paint each one
    if (o.fills === 'mixed' || fn === 'mixed' || o.font.weight === 'mixed' || o.font.size === 'mixed') {
      try {
        o.segments = node.getStyledTextSegments(['fills', 'fontName', 'fontWeight', 'fontSize']).map((sg) => {
          const fill = serPaints(sg.fills);
          const solid = Array.isArray(fill) ? fill.find((f: any) => f.type === 'solid') : null;
          return {
            text: sg.characters,
            fill: solid ? solid.color : null,
            fillOpacity: solid ? solid.opacity : null,
            family: sg.fontName.family, weight: sg.fontWeight, size: sg.fontSize,
          };
        });
      } catch (_) { /* older API */ }
    }
  }

  if (node.type === 'INSTANCE' || node.type === 'COMPONENT') {
    try {
      const mc = node.type === 'INSTANCE' ? (node as InstanceNode).mainComponent : (node as ComponentNode);
      if (mc) o.component = mc.parent?.type === 'COMPONENT_SET' ? mc.parent.name : mc.name;
      const key = mainKey(node);
      if (key) o.componentKey = key;
    } catch (_) { /* dynamic-page mode */ }
    if (box && box.width <= ICON_MAX && box.height <= ICON_MAX) {
      o.icon = true;
      svgJobs.push({ node, box: o });
      return o;
    }

    if (dedupe && o.componentKey && box) {
      const ref = `${o.componentKey}:${Math.round(box.width)}x${Math.round(box.height)}`;
      if (compCache[ref]) {
        o.compRef = ref;
        return o;
      }
      // the first occurrence carries its children AND stores them in the dictionary:
      // this keeps the snapshot self-contained even if compLib is lost
      if ('children' in node && node.children.length) {
        // IMPORTANT: measure from the frame root, like everywhere else. This used to
        // use the node's own origin, which mixed absolute and relative coordinates
        // in the tree and broke all matching.
        const kids = node.children.filter((c) => c.visible).map((c) => serialize(c, root));
        if (kids.length) {
          o.children = kids;
          compCache[ref] = { x: o.x, y: o.y, children: kids };
        }
      }
      o.compDef = ref;
      return o;
    }
  }
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION' || node.type === 'STAR' || node.type === 'LINE') {
    svgJobs.push({ node, box: o });
    return o;
  }

  if ('children' in node && node.children.length) {
    const kids = node.children.filter((c) => c.visible).map((c) => serialize(c, root));
    if (kids.length) o.children = kids;
  }
  return o;
}

const SVG_LIMIT = 800;

/** Icons repeat dozens of times (arrows, social icons): export each shape
 *  ONCE into a shared dictionary; nodes reference it via svgRef. */
const svgCache: Record<string, string> = {};

/** Reusable blocks (header/footer/cards) are not serialized repeatedly:
 *  the first occurrence goes into a shared dictionary, the rest reference it via compRef.
 *  The key includes the size: the same component differs across breakpoints. */
const compCache: Record<string, any> = {};
let dedupe = false;

// Before export a node is identified by what makes it unique: the component
// for instances, the node itself otherwise. Storage is by content hash, so
// identical icons are still shared while same-named "Vector 20x20" are not
// confused with one another.
function svgPreKey(node: SceneNode): string {
  const mc = node.type === 'INSTANCE' ? mainKey(node) : null;
  const box = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;
  const size = box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '?';
  return mc ? `c:${mc}:${size}` : `id:${node.id}`;
}

function svgHash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x9e3779b1) ^ (h2 >>> 13);
  }
  return `s:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${s.length}`;
}

const svgRefByPreKey: Record<string, string> = {};

async function attachSvg(label: string) {
  const jobs = svgJobs.splice(0, svgJobs.length);
  if (!jobs.length) return;

  const uniq: typeof jobs = [];
  const seen: Record<string, boolean> = {};
  for (const j of jobs) {
    const k = svgPreKey(j.node);
    if (svgRefByPreKey[k] || seen[k]) continue;
    seen[k] = true;
    uniq.push(j);
  }

  const todo = uniq.slice(0, SVG_LIMIT);
  if (todo.length) {
    let done = 0;
    for (const j of todo) {
      done++;
      if (done === 1 || done === todo.length || done % 4 === 0)
        figma.ui.postMessage({ type: 'progress', stage: `SVG · ${label}`, done, total: todo.length });
      try {
        const bytes = await (j.node as any).exportAsync({ format: 'SVG' });
        let out = '';
        for (const b of bytes) out += String.fromCharCode(b);
        // a lettering logo path is ~40k; the dictionary stores each shape once
        if (out.length > 120000) continue;
        const ref = svgHash(out);
        svgCache[ref] = out;
        svgRefByPreKey[svgPreKey(j.node)] = ref;
      } catch (_) { /* node cannot be exported, skip it */ }
    }
  }

  for (const j of jobs) {
    const ref = svgRefByPreKey[svgPreKey(j.node)];
    if (ref) j.box.svgRef = ref;
  }
}

const BREAKPOINTS: Array<[string, number]> = [['desktop', 1920], ['tablet', 912], ['mobile', 357]];

function detectBreakpoints(frame: SceneNode): any[] {
  const kids = 'children' in frame ? frame.children.filter((c) => c.visible) : [];
  const out: any[] = [];
  for (const k of kids) {
    const box = 'absoluteBoundingBox' in k ? k.absoluteBoundingBox : null;
    if (!box) continue;
    const hit = BREAKPOINTS.find(([, w]) => Math.abs(box.width - w) <= 1);
    if (hit) out.push({ viewport: hit[0], id: k.id, name: k.name, width: box.width });
  }
  return out;
}

function nodePath(node: BaseNode): string {
  const parts: string[] = [];
  let cur: BaseNode | null = node;
  while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    parts.unshift(cur.name);
    cur = cur.parent;
  }
  return parts.join('/');
}

figma.on('selectionchange', () => {
  const n = figma.currentPage.selection[0];
  if (!n) return;
  const box = 'absoluteBoundingBox' in n ? n.absoluteBoundingBox : null;
  const light = serialize(n, { x: box ? box.x : 0, y: box ? box.y : 0 });
  delete light.children;
  figma.ui.postMessage({
    type: 'selection',
    node: { ...light, figmaId: n.id, path: nodePath(n) },
  });
});

function mainKey(node: SceneNode): string | null {
  if (node.type === 'INSTANCE') {
    try {
      const mc = (node as InstanceNode).mainComponent;
      if (mc) return mc.parent?.type === 'COMPONENT_SET' ? mc.parent.id : mc.id;
    } catch (_) { /* dynamic-page mode */ }
    return null;
  }
  if (node.type === 'COMPONENT') {
    return node.parent?.type === 'COMPONENT_SET' ? node.parent.id : node.id;
  }
  return null;
}

function collectModules(pages: any[]): any[] {
  const byKey: Record<string, any> = {};
  for (const pg of pages) {
    for (const fr of pg.frames) {
      const seenHere = new Set<string>();
      const visit = (n: any) => {
        if (n.componentKey) {
          const m = (byKey[n.componentKey] ||= {
            key: n.componentKey, name: n.component || n.name,
            pages: [], instances: 0, sizes: [],
          });
          m.instances++;
          if (!seenHere.has(n.componentKey)) {
            seenHere.add(n.componentKey);
            const where = `${pg.page}/${fr.frameName}`;
            if (!m.pages.includes(where)) m.pages.push(where);
          }
          const size = `${n.w}x${n.h}`;
          if (!m.sizes.includes(size)) m.sizes.push(size);
          return;
        }
        for (const c of n.children ?? []) visit(c);
      };
      visit(fr.tree);
    }
  }
  return Object.values(byKey)
    .map((m: any) => ({ ...m, shared: m.pages.length > 1 }))
    .sort((a: any, b: any) => Number(b.shared) - Number(a.shared) || b.pages.length - a.pages.length);
}

async function exportProject(png: boolean) {
  dedupe = true;
  const pages: any[] = [];
  const pageTotal = figma.root.children.length;
  let pageIdx = 0;
  for (const page of figma.root.children) {
    pageIdx++;
    figma.ui.postMessage({ type: 'progress', stage: `Page ${pageIdx}/${pageTotal} · ${page.name}`, done: pageIdx - 1, total: pageTotal });
    await page.loadAsync();
    const roots = page.children.filter(
      (n): n is FrameNode | ComponentNode | SectionNode =>
        n.visible && (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'SECTION')
    );
    if (!roots.length) continue;
    const frames: any[] = [];
    for (const frame of roots) {
      const box = frame.absoluteBoundingBox;
      if (!box) continue;
      figma.ui.postMessage({ type: 'progress', stage: `Page ${pageIdx}/${pageTotal} · ${frame.name}`, done: pageIdx - 1, total: pageTotal });
      svgJobs.length = 0;
      const item: any = {
        frameId: frame.id,
        frameName: frame.name,
        width: box.width,
        height: box.height,
        breakpoints: detectBreakpoints(frame),
        tree: serialize(frame, { x: box.x, y: box.y }),
      };
      await attachSvg(page.name + ' → ' + frame.name);
      item.svgLib = svgCache;
      if (png) {
        const bytes = await frame.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
        item.png = figma.base64Encode(bytes);
      }
      frames.push(item);
    }
    pages.push({ page: page.name, pageId: page.id, frames });
  }

  return {
    kind: 'project',
    compLib: compCache,
    svgLib: svgCache,
    fileKey: figma.fileKey ?? null,
    fileName: figma.root.name,
    frameName: `${figma.root.name} (project)`,
    pages,
    modules: collectModules(pages),
  };
}

async function renderNode(id: string, format: string, scale: number) {
  const node = await figma.getNodeByIdAsync(id) as SceneNode | null;
  if (!node) throw new Error(`node ${id} not found`);
  if (!('exportAsync' in node)) throw new Error(`node ${id} (${node.type}) cannot be exported`);

  const settings: any = format === 'SVG'
    ? { format: 'SVG' }
    : { format, constraint: { type: 'SCALE', value: scale || 1 } };

  const bytes = await Promise.race([
    (node as any).exportAsync(settings),
    new Promise((_, rej) => setTimeout(
      () => rej(new Error(`exportAsync hung on "${node.name}" (${node.type}). `
        + 'Usually this is a node with an image fill whose image has not loaded yet: '
        + 'scroll to it on the canvas so Figma loads it, then retry')),
      120000,
    )),
  ]) as Uint8Array;

  const box = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;
  return {
    id, name: node.name, type: node.type, format,
    width: box ? Math.round(box.width) : null,
    height: box ? Math.round(box.height) : null,
    bytes: figma.base64Encode(bytes),
  };
}

figma.ui.onmessage = async (msg: any) => {
  if (msg.type === 'render-request') {
    try {
      const r = await renderNode(msg.id, msg.format ?? 'PNG', msg.scale ?? 2);
      figma.ui.postMessage({ type: 'render-done', reqId: msg.reqId, result: r });
    } catch (e: any) {
      figma.ui.postMessage({ type: 'render-done', reqId: msg.reqId, error: e.message });
    }
    return;
  }
  if (msg.type === 'find-node') {
    try {
      const nodes: any[] = [];
      const q = String(msg.query ?? '').toLowerCase();
      for (const page of figma.root.children) {
        await page.loadAsync();
        for (const n of page.findAll((x) => x.name.toLowerCase().includes(q)).slice(0, 40)) {
          const box = 'absoluteBoundingBox' in n ? n.absoluteBoundingBox : null;
          nodes.push({ id: n.id, name: n.name, type: n.type, page: page.name,
            width: box ? Math.round(box.width) : null, height: box ? Math.round(box.height) : null });
        }
        if (nodes.length >= 40) break;
      }
      figma.ui.postMessage({ type: 'find-done', reqId: msg.reqId, nodes });
    } catch (e: any) {
      figma.ui.postMessage({ type: 'find-done', reqId: msg.reqId, error: e.message });
    }
    return;
  }
  if (msg.type === 'export-project') {
    try {
      const project = await exportProject(!!msg.png);
      const shared = project.modules.filter((m: any) => m.shared).length;
      figma.ui.postMessage({
        type: 'project',
        project,
        port: msg.port,
        mode: msg.mode || 'http',
        summary: `${project.pages.length} pages · ${project.pages.reduce((s: number, p: any) => s + p.frames.length, 0)} frame · ${project.modules.length} modules (${shared} shared)`,
      });
    } catch (e: any) {
      figma.ui.postMessage({ type: 'error', text: `Project export: ${e.message}` });
    }
    return;
  }
  if (msg.type !== 'export') return;
  const selection = figma.currentPage.selection.filter(
    (n): n is FrameNode | ComponentNode | SectionNode =>
      n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'SECTION'
  );
  if (!selection.length) {
    figma.ui.postMessage({ type: 'error', text: 'Select one or more frames' });
    return;
  }
  const frames: any[] = [];
  let frameIdx = 0;
  for (const frame of selection) {
    const box = frame.absoluteBoundingBox!;
    frameIdx++;
    figma.ui.postMessage({ type: 'progress', stage: `Frame ${frameIdx}/${selection.length} · ${frame.name}`, done: frameIdx - 1, total: selection.length });
    svgJobs.length = 0;
    const tree = serialize(frame, { x: box.x, y: box.y });
    await attachSvg(frame.name);
    const item: any = {
      svgLib: svgCache,
      fileKey: figma.fileKey ?? null,
      fileName: figma.root.name,
      page: figma.currentPage.name,
      frameId: frame.id,
      frameName: frame.name,
      width: box.width,
      height: box.height,
      breakpoints: detectBreakpoints(frame),
      tree,
    };
    if (msg.png) {
      figma.ui.postMessage({ type: 'progress', stage: `PNG · ${frame.name}`, done: frameIdx - 1, total: selection.length });
      const bytes = await frame.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
      item.png = figma.base64Encode(bytes);
    }
    frames.push(item);
  }
  figma.ui.postMessage({ type: 'payload', frames, port: msg.port, mode: msg.mode || 'http' });
};
