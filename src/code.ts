// Layerport, sandbox side.
// Selection (frames or whole Sections) -> layer spec + PNG bytes -> the UI
// composes layered PSDs with ag-psd. Image-bearing layers export hi-res
// (up to 3x, capped at 6000px on the long edge) and embed as Smart Objects.
// Hidden layers can carry over as hidden PSD layers. Rotated subtrees are
// flattened safely. Opacity and blend modes carry per layer.

import type { ColorSpec, GroupSpec, LayerSpec, RasterSpec, TextRunSpec, TextSpec, UnitValue } from './shared/spec';

figma.showUI(__html__, { width: 420, height: 720, themeColors: false });

let EXPORT_SCALE = 1;
let JPG_SCALE = 0; // 0 = no JPG proof
let PNG_SCALE = 0; // 0 = no PNG proof
let INCLUDE_HIDDEN = false;
// After Effects handoff: AE ignores embedded Smart Object sources and works
// from the preview pixels, so hi-res embedding is wasted bytes. Image layers
// export at canvas resolution as plain pixel layers instead.
let AE_PRESET = false;
const HI_SCALE = 3;
const MAX_EDGE = 6000;

// ---------- 导出运行令牌（修复二次导出 bug 的核心）----------
// 旧版用 figma.ui.once('message') 等待 UI 的确认，但它对「任何」消息都放行：
// 只要上一轮有一个 piece 没等到确认（界面卡死或用户又点了一次导出），
// 旧循环就会被错误唤醒，和新一轮导出交叉发送 piece，导致第二次导出
// 内容错乱。现在每一轮导出发一个递增 runToken：
//   1) ack 必须带上匹配的 token 才算数；
//   2) 新一轮导出开始时旧运行直接作废（在每个 piece 前检查）；
//   3) piece / begin / done 消息都带 token，UI 端丢弃过期运行的残留消息。
let runToken = 0;
let ackWait: { token: number; resolve: () => void } | null = null;

function resolveAck(msg: any): void {
  const w = ackWait;
  if (!w) return;
  if (msg.run != null && msg.run !== w.token) return; // 迟到的旧 ack，忽略
  ackWait = null;
  w.resolve();
}

function waitAck(token: number): Promise<void> {
  return new Promise<void>((resolve) => {
    ackWait = { token, resolve };
  });
}

// ---------- 字体预检与替换 ----------
// 导出前把设计里用到的字体和「Figma 能列出的本机字体」比对：
// 缺哪个就在界面上标红。同时把这些字体的 PSD 字体名换成系统出厂字体
// （Windows: 微软雅黑 / Arial，macOS: 苹方 / Helvetica），这样 Photoshop
// 打开 PSD 时不会弹缺字体，也不会出现文字空白——导出结果一定可读。
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
const IS_MAC = /mac/i.test(String((globalThis as any).navigator?.platform || ''));

// PSD 里写的字体名要和系统字体的 PostScript 名一致，PS 才能精确匹配。
const PS_NAME_OVERRIDE: Record<string, string> = {
  'microsoft yahei|regular': 'MicrosoftYaHei',
  'microsoft yahei|bold': 'MicrosoftYaHei-Bold',
  '微软雅黑|regular': 'MicrosoftYaHei',
  '微软雅黑|bold': 'MicrosoftYaHei-Bold',
  'arial|regular': 'ArialMT',
  'arial|bold': 'Arial-BoldMT',
  'segoe ui|regular': 'SegoeUI',
  'segoe ui|bold': 'SegoeUI-Bold',
  'helvetica|regular': 'Helvetica',
  'helvetica|bold': 'Helvetica-Bold',
  'pingfang sc|regular': 'PingFangSC-Regular',
  'pingfang sc|bold': 'PingFangSC-Semibold',
  'simsun|regular': 'SimSun',
};

function psFontName(family: string, style: string): string {
  const over = PS_NAME_OVERRIDE[String(family).toLowerCase() + '|' + String(style).toLowerCase()];
  if (over) return over;
  return String(family).replace(/\s+/g, '') + '-' + String(style).replace(/\s+/g, '');
}

interface FontUse {
  family: string;
  style: string;
  ps: string;
  sample: string;
  count: number;
  cjk: boolean;
}

const fontUses = new Map<string, FontUse>();

function addFontUse(fn: FontName | PluginAPI['mixed'], chars: string): void {
  if (!fn || (fn as any) === figma.mixed) return;
  const f = fn as FontName;
  const ps = psFontName(f.family, f.style);
  const u: FontUse = fontUses.get(ps) || {
    family: f.family,
    style: f.style,
    ps,
    sample: (chars || '').slice(0, 14),
    count: 0,
    cjk: false,
  };
  u.count++;
  u.cjk = u.cjk || CJK_RE.test(chars || '');
  fontUses.set(ps, u);
}

// 本机字体索引：精确名集合 + 各家族的可用字重。
let fontExact: Set<string> | null = null;
let fontFamilies = new Map<string, { name: string; styles: string[] }>();

async function loadFontIndex(): Promise<boolean> {
  try {
    const list = await figma.listAvailableFontsAsync();
    const exact = new Set<string>();
    const fams = new Map<string, { name: string; styles: string[] }>();
    for (const item of list) {
      const fam = item.fontName.family;
      const sty = item.fontName.style;
      exact.add((fam + '\u0000' + sty).toLowerCase());
      const key = fam.toLowerCase();
      const cur = fams.get(key);
      if (cur) cur.styles.push(sty);
      else fams.set(key, { name: fam, styles: [sty] });
    }
    fontExact = exact;
    fontFamilies = fams;
    return true;
  } catch (e) {
    fontExact = null;
    fontFamilies = new Map();
    return false;
  }
}

// 系统出厂字体优先——这些字体 Photoshop 一定能找到。
const FALLBACK_CJK = IS_MAC
  ? ['PingFang SC', 'Hiragino Sans GB', 'Heiti SC', 'Arial Unicode MS']
  : ['Microsoft YaHei', '微软雅黑', 'SimSun', 'SimHei', 'Arial Unicode MS', 'Segoe UI'];
const FALLBACK_LATIN = IS_MAC
  ? ['Helvetica', 'Helvetica Neue', 'Arial', 'PingFang SC']
  : ['Arial', 'Segoe UI', 'Tahoma', 'Verdana', 'Microsoft YaHei'];

function wantBold(style: string): boolean {
  return /bold|black|heavy|extrabold|ultrabold/i.test(style);
}

function pickStyle(styles: string[], bold: boolean): string {
  const has = (s: string) => styles.some((x) => x.toLowerCase() === s.toLowerCase());
  if (bold) {
    if (has('Bold')) return 'Bold';
    const b = styles.find((s) => /bold|black|heavy/i.test(s));
    if (b) return b;
  }
  if (has('Regular')) return 'Regular';
  const r = styles.find((s) => /regular|normal|book|roman/i.test(s));
  return r || styles[0] || (bold ? 'Bold' : 'Regular');
}

function pickFallback(cjk: boolean, bold: boolean): { family: string; style: string } {
  const list = cjk ? FALLBACK_CJK : FALLBACK_LATIN;
  for (const fam of list) {
    const info = fontFamilies.get(fam.toLowerCase());
    if (info) return { family: info.name, style: pickStyle(info.styles, bold) };
  }
  // 索引不可用时也照样兜底：出厂字体本来就在系统里。
  return { family: list[0], style: bold ? 'Bold' : 'Regular' };
}

interface FontResolution {
  ps: string;
  replaced: boolean;
  from: string;
  to: string;
}

const resolveCache = new Map<string, FontResolution>();

function resolveFont(fn: FontName, chars: string): FontResolution {
  const family = fn.family;
  const style = fn.style;
  const cjk = CJK_RE.test(chars || '');
  const key = (family + '|' + style + '|' + (cjk ? 'c' : 'l')).toLowerCase();
  const hit = resolveCache.get(key);
  if (hit) return hit;
  const orig = psFontName(family, style);
  let out: FontResolution = { ps: orig, replaced: false, from: family + ' / ' + style, to: '' };
  if (fontExact && !fontExact.has((family + '\u0000' + style).toLowerCase())) {
    const fam = fontFamilies.get(family.toLowerCase());
    if (fam) {
      // 家族装了，只是缺这个字重：同家族里换一个可用字重，保住字形。
      const st = pickStyle(fam.styles, wantBold(style));
      out = { ps: psFontName(fam.name, st), replaced: true, from: family + ' / ' + style, to: fam.name + ' / ' + st };
    } else {
      const fb = pickFallback(cjk, wantBold(style));
      out = { ps: psFontName(fb.family, fb.style), replaced: true, from: family + ' / ' + style, to: fb.family + ' / ' + fb.style };
    }
  }
  resolveCache.set(key, out);
  return out;
}

function noteReplace(warnings: string[], r: FontResolution): void {
  if (!r.replaced) return;
  const msg = '字体「' + r.from + '」本机未安装，已替换为「' + r.to + '」导出（PSD 打开不会缺字体）。';
  if (warnings.indexOf(msg) < 0) warnings.push(msg);
}

// 遍历选中内容，收集所有文字图层用到的字体（含实例内文字）。
function collectFonts(node: SceneNode): void {
  if (!INCLUDE_HIDDEN && node.visible === false) return;
  if (node.type === 'TEXT') {
    const chars = node.characters || '';
    let segs: any[] | null = null;
    try {
      segs = node.getStyledTextSegments(['fontName']) as any[];
    } catch (e) {
      segs = null;
    }
    if (segs && segs.length) {
      for (const s of segs) addFontUse(s.fontName, s.characters || chars);
    } else {
      addFontUse(node.fontName, chars);
    }
    return;
  }
  if ('children' in node) {
    for (const c of (node as ChildrenMixin).children) collectFonts(c);
  }
}

// 字体预检结果，发给 UI 标红。
function fontReport(): any[] {
  const rows: any[] = [];
  fontUses.forEach((u) => {
    const installed = !!fontExact && fontExact.has((u.family + '\u0000' + u.style).toLowerCase());
    const fam = fontFamilies.get(u.family.toLowerCase());
    const status: 'ok' | 'style' | 'missing' = installed ? 'ok' : fam ? 'style' : 'missing';
    const fb = status === 'ok' ? null : resolveFont({ family: u.family, style: u.style }, u.sample);
    rows.push({
      label: u.family + ' / ' + u.style,
      ps: u.ps,
      count: u.count,
      cjk: u.cjk,
      status,
      replacedBy: fb && fb.replaced ? fb.to : '',
    });
  });
  return rows;
}

function solidOf(paints: readonly Paint[] | PluginAPI['mixed'] | null | undefined): ColorSpec | null {
  if (paints === figma.mixed || !paints || !(paints as readonly Paint[]).length) return null;
  for (const p of paints as readonly Paint[]) {
    if (p.visible === false) continue;
    if (p.type === 'SOLID') {
      return {
        r: Math.round(p.color.r * 255),
        g: Math.round(p.color.g * 255),
        b: Math.round(p.color.b * 255),
        opacity: p.opacity == null ? 1 : p.opacity,
      };
    }
    return null;
  }
  return null;
}

function paintsHaveImage(paints: readonly Paint[] | PluginAPI['mixed'] | null | undefined): boolean {
  if (paints === figma.mixed || !paints) return false;
  for (const p of paints as readonly Paint[]) {
    if (p.visible !== false && p.type === 'IMAGE') return true;
  }
  return false;
}

function ownImage(node: SceneNode): boolean {
  const n = node as any;
  return ('fills' in node && paintsHaveImage(n.fills)) || ('strokes' in node && paintsHaveImage(n.strokes));
}

function subtreeHasImage(node: SceneNode): boolean {
  if (!INCLUDE_HIDDEN && node.visible === false) return false;
  if (ownImage(node)) return true;
  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children) {
      if (subtreeHasImage(child)) return true;
    }
  }
  return false;
}

function hasOwnPaint(node: SceneNode): boolean {
  const n = node as any;
  const f: readonly Paint[] | PluginAPI['mixed'] | null = 'fills' in node ? n.fills : null;
  const s: readonly Paint[] | PluginAPI['mixed'] | null = 'strokes' in node ? n.strokes : null;
  const hasFill = f && f !== figma.mixed && (f as readonly Paint[]).some((p) => p.visible !== false);
  const hasStroke = s && s !== figma.mixed && (s as readonly Paint[]).some((p) => p.visible !== false);
  return !!(hasFill || hasStroke);
}

function hasTextDeep(node: SceneNode): boolean {
  if (node.type === 'TEXT') return true;
  if (!('children' in node)) return false;
  for (const c of (node as ChildrenMixin).children) {
    if (!INCLUDE_HIDDEN && c.visible === false) continue;
    if (hasTextDeep(c)) return true;
  }
  return false;
}

function isRotated(node: SceneNode): boolean {
  const t = node.absoluteTransform;
  return Math.abs(t[0][1]) > 0.001 || Math.abs(t[1][0]) > 0.001;
}

function relPos(node: SceneNode, base: { x: number; y: number }): { x: number; y: number } {
  const t = node.absoluteTransform;
  return { x: t[0][2] - base.x, y: t[1][2] - base.y };
}

function hiScaleFor(w: number, h: number): number {
  const edge = Math.max(w, h);
  return Math.max(1, Math.min(HI_SCALE, MAX_EDGE / edge));
}

const BLEND: Record<string, string> = {
  NORMAL: 'normal', DARKEN: 'darken', MULTIPLY: 'multiply', COLOR_BURN: 'color burn',
  LINEAR_BURN: 'linear burn', LIGHTEN: 'lighten', SCREEN: 'screen', COLOR_DODGE: 'color dodge',
  LINEAR_DODGE: 'linear dodge', OVERLAY: 'overlay', SOFT_LIGHT: 'soft light', HARD_LIGHT: 'hard light',
  DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation',
  COLOR: 'color', LUMINOSITY: 'luminosity', PASS_THROUGH: 'pass through',
};

function commonProps<T extends LayerSpec>(node: SceneNode, spec: T): T {
  spec.opacity = 'opacity' in node ? (node as any).opacity : 1;
  spec.blend = BLEND[(node as any).blendMode] || 'normal';
  return spec;
}

// Instance sublayers must not be mutated, not even visibility. Writing an
// override makes Figma rebuild that instance's sublayer tree, and every node
// reference the plugin still holds into it throws "node does not exist" on
// the next read or write. Reviewer-reported on a six-level nested instance.
// Anything that needs a temporary change is done on a detached clone.
function inInstance(node: SceneNode): boolean {
  return node.type === 'INSTANCE' || node.id.charAt(0) === 'I';
}

// Clone a node into a temp page-level frame at the same absolute transform,
// detached from its component so it can be edited freely. Caller disposes.
function stageClone(node: SceneNode): { shell: SceneNode; dispose: () => void } {
  const tmp = figma.createFrame();
  figma.currentPage.appendChild(tmp);
  tmp.name = '__layerport_tmp';
  tmp.fills = [];
  tmp.clipsContent = false;
  let shell: SceneNode = node.clone();
  tmp.appendChild(shell);
  shell.relativeTransform = node.absoluteTransform;
  if (shell.type === 'INSTANCE') shell = shell.detachInstance();
  return { shell, dispose: () => tmp.remove() };
}

async function exportPng(node: SceneNode, scale: number): Promise<Uint8Array> {
  return await (node as ExportMixin & SceneNode).exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
}

// Export a rotated node by cloning into a temp frame at its render bounds.
async function exportRotated(node: SceneNode, base: { x: number; y: number }, warnings: string[]): Promise<RasterSpec | null> {
  const rb = (node as SceneNode & { absoluteRenderBounds: Rect | null }).absoluteRenderBounds;
  if (!rb) return null;
  const tmp = figma.createFrame();
  figma.currentPage.appendChild(tmp);
  tmp.name = '__layerport_export_tmp';
  tmp.fills = [];
  tmp.clipsContent = false;
  tmp.resizeWithoutConstraints(Math.max(1, rb.width), Math.max(1, rb.height));
  tmp.x = rb.x;
  tmp.y = rb.y;
  let bytes: Uint8Array;
  const hi = !AE_PRESET && subtreeHasImage(node);
  const scale = hi ? hiScaleFor(rb.width, rb.height) : EXPORT_SCALE;
  try {
    const clone = node.clone();
    tmp.appendChild(clone);
    const t = node.absoluteTransform;
    clone.relativeTransform = [
      [t[0][0], t[0][1], t[0][2] - rb.x],
      [t[1][0], t[1][1], t[1][2] - rb.y],
    ];
    clone.visible = true;
    bytes = await exportPng(tmp, scale);
  } finally {
    // 无论中途是否抛错，临时 Frame 都必须清掉，否则残留在画布上。
    tmp.remove();
  }
  warnings.push('旋转图层「' + node.name + '」已栅格化导出。');
  return {
    kind: 'raster', name: node.name,
    x: rb.x - base.x, y: rb.y - base.y, w: rb.width, h: rb.height,
    png: bytes, hiRes: hi && scale > 1 ? scale : 0,
  };
}

async function renderedLines(
  node: TextNode,
  fontName: FontName,
  fontSize: number,
  letterSpacing: UnitValue,
  lineHeight: UnitValue,
): Promise<string> {
  // Hug boxes never soft-wrap; fixed and auto-height boxes wrap at node width.
  if (node.textAutoResize === 'WIDTH_AND_HEIGHT') return node.characters;
  const chars = node.characters;
  if (chars.indexOf(' ') < 0) return chars;
  try {
    await figma.loadFontAsync(fontName);
    const m = figma.createText();
    try {
      m.fontName = fontName;
      m.fontSize = fontSize;
      if (letterSpacing && letterSpacing.unit) m.letterSpacing = letterSpacing as LetterSpacing;
      if (lineHeight && lineHeight.unit) m.lineHeight = lineHeight as LineHeight;
      m.textAutoResize = 'HEIGHT';
      m.resize(node.width, m.height);
      m.characters = 'Ag';
      const oneLine = m.height;
      const out: string[] = [];
      const paras = chars.split('\n');
      for (const para of paras) {
        const words = para.split(' ');
        let current = '';
        for (const word of words) {
          const test = current ? current + ' ' + word : word;
          m.characters = test;
          if (m.height > oneLine * 1.5 && current) {
            out.push(current);
            current = word;
          } else {
            current = test;
          }
        }
        out.push(current);
      }
      return out.join('\n');
    } finally {
      // 字体缺失时 fontName 赋值会抛错；无论成败都必须清掉临时文字节点，
      // 否则每次导出都会在画布上留下垃圾节点。
      m.remove();
    }
  } catch (e) {
    return chars;
  }
}

async function textSpec(node: TextNode, base: { x: number; y: number }, warnings: string[]): Promise<TextSpec> {
  const pos = relPos(node, base);
  let segs: any[] | null;
  try {
    segs = node.getStyledTextSegments(['fontSize', 'fontName', 'fills', 'letterSpacing', 'lineHeight', 'openTypeFeatures']) as any[];
  } catch (e) {
    segs = null;
  }
  const s0 = segs && segs.length ? segs[0] : null;
  const fontName: FontName = s0 ? s0.fontName : (node.fontName as FontName);
  const fontSize: number = s0 ? s0.fontSize : (node.fontSize as number);
  addFontUse(fontName, node.characters);
  // 缺失字体会在这里被换成本机可用的系统字体，保证 PSD 里不出现没装的字体名。
  const effFont = resolveFont(fontName, node.characters);
  noteReplace(warnings, effFont);
  let color = solidOf(s0 ? s0.fills : node.fills);
  if (!color) {
    color = { r: 0, g: 0, b: 0, opacity: 1 };
    warnings.push('文字「' + node.characters.slice(0, 24) + '」使用了非纯色填充，已按黑色导出。');
  }
  const lh: any = s0 ? s0.lineHeight : node.lineHeight;
  const ls: any = s0 ? s0.letterSpacing : node.letterSpacing;
  const lhSafe: UnitValue = lh && lh.unit ? lh : { unit: 'AUTO' };
  const lsSafe: UnitValue = ls && ls.unit ? ls : { unit: 'PERCENT', value: 0 };
  const chars = await renderedLines(node, fontName, fontSize, lsSafe, lhSafe);
  let runs: TextRunSpec[] | null = null;
  if (segs && segs.length > 1) {
    runs = segs.map((s: any) => {
      const otf = s.openTypeFeatures || {};
      addFontUse(s.fontName, s.characters);
      const rEff = resolveFont(s.fontName, s.characters);
      noteReplace(warnings, rEff);
      return {
        length: s.characters.length,
        fontSize: s.fontSize,
        psFont: rEff.ps,
        color: solidOf(s.fills) || { r: 0, g: 0, b: 0, opacity: 1 },
        letterSpacing: s.letterSpacing && s.letterSpacing.unit ? s.letterSpacing : { unit: 'PERCENT', value: 0 },
        sups: !!otf.SUPS,
        subs: !!otf.SUBS,
      };
    });
  }
  return commonProps(node, {
    kind: 'text', name: node.name, chars,
    x: pos.x, y: pos.y, w: node.width, h: node.height,
    fontSize, psFont: effFont.ps,
    color,
    lineHeight: lhSafe,
    letterSpacing: lsSafe,
    align: node.textAlignHorizontal,
    runs,
  } as TextSpec);
}

async function rasterSpec(node: SceneNode, base: { x: number; y: number }): Promise<RasterSpec> {
  const pos = relPos(node, base);
  const hi = !AE_PRESET && subtreeHasImage(node);
  const scale = hi ? hiScaleFor(node.width, node.height) : EXPORT_SCALE;
  const bytes = await exportPng(node, scale);
  return commonProps(node, {
    kind: 'raster', name: node.name,
    x: pos.x, y: pos.y, w: node.width, h: node.height,
    png: bytes, hiRes: hi && scale > 1 ? scale : 0,
  } as RasterSpec);
}

async function bgRaster(node: SceneNode, base: { x: number; y: number }): Promise<RasterSpec> {
  const hi = !AE_PRESET && ownImage(node);
  const scale = hi ? hiScaleFor(node.width, node.height) : EXPORT_SCALE;
  let bytes: Uint8Array | null = null;
  if (inInstance(node)) {
    // Render the container shell from a detached clone; the source instance
    // is never touched.
    const staged = stageClone(node);
    try {
      if ('children' in staged.shell) {
        for (const c of (staged.shell as ChildrenMixin).children) c.visible = false;
      }
      bytes = await exportPng(staged.shell, scale);
    } finally {
      staged.dispose();
    }
  } else {
    const hidden: SceneNode[] = [];
    if ('children' in node) {
      for (const c of (node as ChildrenMixin).children) {
        if (c.visible) {
          c.visible = false;
          hidden.push(c);
        }
      }
    }
    try {
      bytes = await exportPng(node, scale);
    } finally {
      for (const h of hidden) h.visible = true;
    }
  }
  const pos = relPos(node, base);
  return commonProps(node, {
    kind: 'raster', name: node.name + '（背景）',
    x: pos.x, y: pos.y, w: node.width, h: node.height,
    png: bytes, hiRes: hi && scale > 1 ? scale : 0,
  } as RasterSpec);
}

async function walk(node: SceneNode, base: { x: number; y: number }, warnings: string[]): Promise<LayerSpec | null> {
  const wasHidden = node.visible === false;
  if (wasHidden && !INCLUDE_HIDDEN) return null;
  if (wasHidden && inInstance(node)) {
    // Cannot flip visibility inside an instance; walk a visible detached
    // clone at the same position instead and mark the result hidden.
    const staged = stageClone(node);
    try {
      staged.shell.visible = true;
      const spec = await walk(staged.shell, base, warnings);
      if (spec) {
        spec.hidden = true;
        spec.name = node.name;
      }
      return spec;
    } finally {
      staged.dispose();
    }
  }
  if (wasHidden) node.visible = true;
  let spec: LayerSpec | null = null;
  try {
    if (node.type === 'TEXT') {
      spec = await textSpec(node, base, warnings);
    } else if (isRotated(node)) {
      spec = await exportRotated(node, base, warnings);
    } else {
      const isContainer = 'children' in node && (node as ChildrenMixin).children.length > 0;
      // Flatten only when nothing below needs its own layer: no text AND no
      // image-bearing children (a lone image node itself stays a single
      // raster/Smart Object; siblings with images each get their own layer).
      let childHasImage = false;
      if (isContainer) {
        for (const c of (node as ChildrenMixin).children) {
          if (subtreeHasImage(c)) {
            childHasImage = true;
            break;
          }
        }
      }
      if (!isContainer || (!hasTextDeep(node) && !childHasImage)) {
        spec = await rasterSpec(node, base);
      } else {
        const layers: LayerSpec[] = [];
        if (hasOwnPaint(node)) layers.push(await bgRaster(node, base));
        for (const c of (node as ChildrenMixin).children) {
          const child = await walk(c, base, warnings);
          if (child) layers.push(child);
        }
        spec = commonProps(node, { kind: 'group', name: node.name, layers } as GroupSpec);
      }
    }
  } finally {
    if (wasHidden) node.visible = false;
  }
  if (spec && wasHidden) spec.hidden = true;
  return spec;
}

function expandSelection(): SceneNode[] {
  const out: SceneNode[] = [];
  function collect(n: SceneNode) {
    if (n.type === 'SECTION') {
      for (const c of n.children) collect(c);
    } else if (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE' || n.type === 'GROUP') {
      out.push(n);
    }
  }
  for (const n of figma.currentPage.selection) collect(n);
  return out;
}

// 递归统计图层数（含自身），用于「选中了多少个图层」的显示。
function countLayers(node: SceneNode): number {
  let n = 1;
  if ('children' in node) {
    for (const c of (node as ChildrenMixin).children) n += countLayers(c);
  }
  return n;
}

// 把当前选中内容（画板数、图层总数、各画板尺寸）发给 UI 显示。
function reportSelection(): void {
  const sel = expandSelection();
  const frames = sel.map((f) => ({
    name: f.name,
    w: Math.round(f.width),
    h: Math.round(f.height),
    layers: countLayers(f),
  }));
  figma.ui.postMessage({
    type: 'selection',
    frames,
    count: frames.length,
    layers: frames.reduce((a, f) => a + f.layers, 0),
  });
}

async function run(token: number) {
  fontUses.clear();
  resolveCache.clear();
  const sel = expandSelection();
  if (!sel.length) {
    figma.ui.postMessage({ type: 'status', text: '请先选中画板（Frame）或分区（Section），再点击导出。' });
    return;
  }
  // 字体预检：在真正导出之前就把「缺哪个字体」标红给用户看。
  for (const root of sel) collectFonts(root);
  const indexOk = await loadFontIndex();
  if (token !== runToken) return; // 已被更新的导出取代
  figma.ui.postMessage({ type: 'fontCheck', ok: indexOk, fonts: indexOk ? fontReport() : [] });
  figma.ui.postMessage({ type: 'begin', run: token, count: sel.length });
  for (let i = 0; i < sel.length; i++) {
    if (token !== runToken) return; // 已被更新的导出取代，静默退出
    const root = sel[i];
    const t = root.absoluteTransform;
    const base = { x: t[0][2], y: t[1][2] };
    const warnings: string[] = [];
    figma.ui.postMessage({ type: 'status', text: '正在读取 ' + root.name + '（' + (i + 1) + '/' + sel.length + '）…' });
    try {
      const spec = await walk(root, base, warnings);
      if (token !== runToken) return;
      const composite = await exportPng(root, EXPORT_SCALE);
      // Proofs are PNG bytes at the requested scale; the UI converts the JPG
      // one. Renders are reused when scales coincide.
      let proofJpg: Uint8Array | null = null;
      if (JPG_SCALE === EXPORT_SCALE) proofJpg = composite;
      else if (JPG_SCALE > 0) proofJpg = await exportPng(root, JPG_SCALE);
      let proofPng: Uint8Array | null = null;
      if (PNG_SCALE === EXPORT_SCALE) proofPng = composite;
      else if (PNG_SCALE > 0 && PNG_SCALE === JPG_SCALE) proofPng = proofJpg;
      else if (PNG_SCALE > 0) proofPng = await exportPng(root, PNG_SCALE);
      if (token !== runToken) return;
      figma.ui.postMessage({
        type: 'piece', run: token, name: root.name, page: figma.currentPage.name, index: i + 1,
        width: Math.round(root.width), height: Math.round(root.height),
        scale: EXPORT_SCALE, spec, composite,
        proofJpg, proofPng, warnings,
      });
      // 只等「本轮 token 的 ack」，其它消息（比如用户又点了一次导出）
      // 不会再错误地唤醒这里。
      await waitAck(token);
    } catch (err: any) {
      if (token !== runToken) return;
      figma.ui.postMessage({ type: 'pieceError', run: token, name: root.name, error: String((err && err.message) || err) });
    }
  }
  if (token !== runToken) return;
  figma.ui.postMessage({ type: 'done', run: token });
}

figma.ui.onmessage = async (msg: any) => {
  if (!msg) return;
  if (msg.type === 'ack') {
    resolveAck(msg);
    return;
  }
  if (msg.type === 'export') {
    // 新一轮导出：令牌 +1，旧运行在下一个检查点自动作废，
    // 不再和这一轮交叉发消息。
    runToken++;
    EXPORT_SCALE = msg.scale === 2 ? 2 : 1;
    JPG_SCALE = msg.jpgScale || 0;
    PNG_SCALE = msg.pngScale || 0;
    INCLUDE_HIDDEN = !!msg.includeHidden;
    AE_PRESET = !!msg.aePreset;
    void run(runToken);
  } else if (msg.type === 'saveRenameMap') {
    await figma.clientStorage.setAsync('layerportRenameMap', msg.map);
    figma.ui.postMessage({ type: 'renameMapLoaded', count: Object.keys(msg.map).length });
  } else if (msg.type === 'saveLastExport') {
    // 记住上一次导出的信息（时间、文件数、保存位置），下次打开插件时显示。
    await figma.clientStorage.setAsync('layerportLastExport', msg.info);
  } else if (msg.type === 'ready') {
    reportSelection();
  }
};

figma.on('selectionchange', reportSelection);

(async function init() {
  const map = await figma.clientStorage.getAsync('layerportRenameMap');
  if (map) figma.ui.postMessage({ type: 'renameMapLoaded', count: Object.keys(map).length, map });
  const last = await figma.clientStorage.getAsync('layerportLastExport');
  if (last) figma.ui.postMessage({ type: 'lastExportLoaded', info: last });
})();
