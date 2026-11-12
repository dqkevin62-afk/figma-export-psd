"use strict";
(() => {
  // src/code.ts
  figma.showUI(__html__, { width: 420, height: 720, themeColors: false });
  var EXPORT_SCALE = 1;
  var JPG_SCALE = 0;
  var PNG_SCALE = 0;
  var INCLUDE_HIDDEN = false;
  var AE_PRESET = false;
  var HI_SCALE = 3;
  var MAX_EDGE = 6e3;
  var CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
  var _a;
  var IS_MAC = /mac/i.test(String(((_a = globalThis.navigator) == null ? void 0 : _a.platform) || ""));
  var PS_NAME_OVERRIDE = {
    "microsoft yahei|regular": "MicrosoftYaHei",
    "microsoft yahei|bold": "MicrosoftYaHei-Bold",
    "微软雅黑|regular": "MicrosoftYaHei",
    "微软雅黑|bold": "MicrosoftYaHei-Bold",
    "arial|regular": "ArialMT",
    "arial|bold": "Arial-BoldMT",
    "segoe ui|regular": "SegoeUI",
    "segoe ui|bold": "SegoeUI-Bold",
    "helvetica|regular": "Helvetica",
    "helvetica|bold": "Helvetica-Bold",
    "pingfang sc|regular": "PingFangSC-Regular",
    "pingfang sc|bold": "PingFangSC-Semibold",
    "simsun|regular": "SimSun"
  };
  function psFontName(family, style) {
    const over = PS_NAME_OVERRIDE[String(family).toLowerCase() + "|" + String(style).toLowerCase()];
    if (over) return over;
    return String(family).replace(/\s+/g, "") + "-" + String(style).replace(/\s+/g, "");
  }
  var fontUses = /* @__PURE__ */ new Map();
  function addFontUse(fn, chars) {
    if (!fn || fn === figma.mixed) return;
    const f = fn;
    const ps = psFontName(f.family, f.style);
    const u = fontUses.get(ps) || {
      family: f.family,
      style: f.style,
      ps,
      sample: (chars || "").slice(0, 14),
      count: 0,
      cjk: false
    };
    u.count++;
    u.cjk = u.cjk || CJK_RE.test(chars || "");
    fontUses.set(ps, u);
  }
  var fontExact = null;
  var fontFamilies = /* @__PURE__ */ new Map();
  async function loadFontIndex() {
    try {
      const list = await figma.listAvailableFontsAsync();
      const exact = /* @__PURE__ */ new Set();
      const fams = /* @__PURE__ */ new Map();
      for (const item of list) {
        const fam = item.fontName.family;
        const sty = item.fontName.style;
        exact.add((fam + "\0" + sty).toLowerCase());
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
      fontFamilies = /* @__PURE__ */ new Map();
      return false;
    }
  }
  var FALLBACK_CJK = IS_MAC ? ["PingFang SC", "Hiragino Sans GB", "Heiti SC", "Arial Unicode MS"] : ["Microsoft YaHei", "微软雅黑", "SimSun", "SimHei", "Arial Unicode MS", "Segoe UI"];
  var FALLBACK_LATIN = IS_MAC ? ["Helvetica", "Helvetica Neue", "Arial", "PingFang SC"] : ["Arial", "Segoe UI", "Tahoma", "Verdana", "Microsoft YaHei"];
  function wantBold(style) {
    return /bold|black|heavy|extrabold|ultrabold/i.test(style);
  }
  function pickStyle(styles, bold) {
    const has = (s) => styles.some((x) => x.toLowerCase() === s.toLowerCase());
    if (bold) {
      if (has("Bold")) return "Bold";
      const b = styles.find((s) => /bold|black|heavy/i.test(s));
      if (b) return b;
    }
    if (has("Regular")) return "Regular";
    const r = styles.find((s) => /regular|normal|book|roman/i.test(s));
    return r || styles[0] || (bold ? "Bold" : "Regular");
  }
  function pickFallback(cjk, bold) {
    const list = cjk ? FALLBACK_CJK : FALLBACK_LATIN;
    for (const fam of list) {
      const info = fontFamilies.get(fam.toLowerCase());
      if (info) return { family: info.name, style: pickStyle(info.styles, bold) };
    }
    return { family: list[0], style: bold ? "Bold" : "Regular" };
  }
  var resolveCache = /* @__PURE__ */ new Map();
  function resolveFont(fn, chars) {
    const family = fn.family;
    const style = fn.style;
    const cjk = CJK_RE.test(chars || "");
    const key = (family + "|" + style + "|" + (cjk ? "c" : "l")).toLowerCase();
    const hit = resolveCache.get(key);
    if (hit) return hit;
    const orig = psFontName(family, style);
    let out = { ps: orig, replaced: false, from: family + " / " + style, to: "" };
    if (fontExact && !fontExact.has((family + "\0" + style).toLowerCase())) {
      const fam = fontFamilies.get(family.toLowerCase());
      if (fam) {
        const st = pickStyle(fam.styles, wantBold(style));
        out = { ps: psFontName(fam.name, st), replaced: true, from: family + " / " + style, to: fam.name + " / " + st };
      } else {
        const fb = pickFallback(cjk, wantBold(style));
        out = { ps: psFontName(fb.family, fb.style), replaced: true, from: family + " / " + style, to: fb.family + " / " + fb.style };
      }
    }
    resolveCache.set(key, out);
    return out;
  }
  function noteReplace(warnings, r) {
    if (!r.replaced) return;
    const msg = "字体「" + r.from + "」本机未安装，已替换为「" + r.to + "」导出（PSD 打开不会缺字体）。";
    if (warnings.indexOf(msg) < 0) warnings.push(msg);
  }
  function collectFonts(node) {
    if (!INCLUDE_HIDDEN && node.visible === false) return;
    if (node.type === "TEXT") {
      const chars = node.characters || "";
      let segs = null;
      try {
        segs = node.getStyledTextSegments(["fontName"]);
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
    if ("children" in node) {
      for (const c of node.children) collectFonts(c);
    }
  }
  function fontReport() {
    const rows = [];
    fontUses.forEach((u) => {
      const installed = !!fontExact && fontExact.has((u.family + "\0" + u.style).toLowerCase());
      const fam = fontFamilies.get(u.family.toLowerCase());
      const status = installed ? "ok" : fam ? "style" : "missing";
      const fb = status === "ok" ? null : resolveFont({ family: u.family, style: u.style }, u.sample);
      rows.push({
        label: u.family + " / " + u.style,
        ps: u.ps,
        count: u.count,
        cjk: u.cjk,
        status,
        replacedBy: fb && fb.replaced ? fb.to : ""
      });
    });
    return rows;
  }
  function solidOf(paints) {
    if (paints === figma.mixed || !paints || !paints.length) return null;
    for (const p of paints) {
      if (p.visible === false) continue;
      if (p.type === "SOLID") {
        return {
          r: Math.round(p.color.r * 255),
          g: Math.round(p.color.g * 255),
          b: Math.round(p.color.b * 255),
          opacity: p.opacity == null ? 1 : p.opacity
        };
      }
      return null;
    }
    return null;
  }
  function paintsHaveImage(paints) {
    if (paints === figma.mixed || !paints) return false;
    for (const p of paints) {
      if (p.visible !== false && p.type === "IMAGE") return true;
    }
    return false;
  }
  function ownImage(node) {
    const n = node;
    return "fills" in node && paintsHaveImage(n.fills) || "strokes" in node && paintsHaveImage(n.strokes);
  }
  function subtreeHasImage(node) {
    if (!INCLUDE_HIDDEN && node.visible === false) return false;
    if (ownImage(node)) return true;
    if ("children" in node) {
      for (const child of node.children) {
        if (subtreeHasImage(child)) return true;
      }
    }
    return false;
  }
  function hasOwnPaint(node) {
    const n = node;
    const f = "fills" in node ? n.fills : null;
    const s = "strokes" in node ? n.strokes : null;
    const hasFill = f && f !== figma.mixed && f.some((p) => p.visible !== false);
    const hasStroke = s && s !== figma.mixed && s.some((p) => p.visible !== false);
    return !!(hasFill || hasStroke);
  }
  function hasTextDeep(node) {
    if (node.type === "TEXT") return true;
    if (!("children" in node)) return false;
    for (const c of node.children) {
      if (!INCLUDE_HIDDEN && c.visible === false) continue;
      if (hasTextDeep(c)) return true;
    }
    return false;
  }
  function isRotated(node) {
    const t = node.absoluteTransform;
    return Math.abs(t[0][1]) > 1e-3 || Math.abs(t[1][0]) > 1e-3;
  }
  function relPos(node, base) {
    const t = node.absoluteTransform;
    return { x: t[0][2] - base.x, y: t[1][2] - base.y };
  }
  function hiScaleFor(w, h) {
    const edge = Math.max(w, h);
    return Math.max(1, Math.min(HI_SCALE, MAX_EDGE / edge));
  }
  var BLEND = {
    NORMAL: "normal",
    DARKEN: "darken",
    MULTIPLY: "multiply",
    COLOR_BURN: "color burn",
    LINEAR_BURN: "linear burn",
    LIGHTEN: "lighten",
    SCREEN: "screen",
    COLOR_DODGE: "color dodge",
    LINEAR_DODGE: "linear dodge",
    OVERLAY: "overlay",
    SOFT_LIGHT: "soft light",
    HARD_LIGHT: "hard light",
    DIFFERENCE: "difference",
    EXCLUSION: "exclusion",
    HUE: "hue",
    SATURATION: "saturation",
    COLOR: "color",
    LUMINOSITY: "luminosity",
    PASS_THROUGH: "pass through"
  };
  function commonProps(node, spec) {
    spec.opacity = "opacity" in node ? node.opacity : 1;
    spec.blend = BLEND[node.blendMode] || "normal";
    return spec;
  }
  function inInstance(node) {
    return node.type === "INSTANCE" || node.id.charAt(0) === "I";
  }
  function stageClone(node) {
    const tmp = figma.createFrame();
    figma.currentPage.appendChild(tmp);
    tmp.name = "__layerport_tmp";
    tmp.fills = [];
    tmp.clipsContent = false;
    let shell = node.clone();
    tmp.appendChild(shell);
    shell.relativeTransform = node.absoluteTransform;
    if (shell.type === "INSTANCE") shell = shell.detachInstance();
    return { shell, dispose: () => tmp.remove() };
  }
  async function exportPng(node, scale) {
    return await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
  }
  async function exportRotated(node, base, warnings) {
    const rb = node.absoluteRenderBounds;
    if (!rb) return null;
    const tmp = figma.createFrame();
    figma.currentPage.appendChild(tmp);
    tmp.name = "__layerport_export_tmp";
    tmp.fills = [];
    tmp.clipsContent = false;
    tmp.resizeWithoutConstraints(Math.max(1, rb.width), Math.max(1, rb.height));
    tmp.x = rb.x;
    tmp.y = rb.y;
    const clone = node.clone();
    tmp.appendChild(clone);
    const t = node.absoluteTransform;
    clone.relativeTransform = [
      [t[0][0], t[0][1], t[0][2] - rb.x],
      [t[1][0], t[1][1], t[1][2] - rb.y]
    ];
    clone.visible = true;
    const hi = !AE_PRESET && subtreeHasImage(node);
    const scale = hi ? hiScaleFor(rb.width, rb.height) : EXPORT_SCALE;
    let bytes;
    try {
      bytes = await exportPng(tmp, scale);
    } finally {
      tmp.remove();
    }
    warnings.push("旋转图层「" + node.name + "」已栅格化导出。");
    return {
      kind: "raster",
      name: node.name,
      x: rb.x - base.x,
      y: rb.y - base.y,
      w: rb.width,
      h: rb.height,
      png: bytes,
      hiRes: hi && scale > 1 ? scale : 0
    };
  }
  async function renderedLines(node, fontName, fontSize, letterSpacing, lineHeight) {
    if (node.textAutoResize === "WIDTH_AND_HEIGHT") return node.characters;
    const chars = node.characters;
    if (chars.indexOf(" ") < 0) return chars;
    try {
      await figma.loadFontAsync(fontName);
      const m = figma.createText();
      m.fontName = fontName;
      m.fontSize = fontSize;
      if (letterSpacing && letterSpacing.unit) m.letterSpacing = letterSpacing;
      if (lineHeight && lineHeight.unit) m.lineHeight = lineHeight;
      m.textAutoResize = "HEIGHT";
      m.resize(node.width, m.height);
      m.characters = "Ag";
      const oneLine = m.height;
      const out = [];
      const paras = chars.split("\n");
      for (const para of paras) {
        const words = para.split(" ");
        let current = "";
        for (const word of words) {
          const test = current ? current + " " + word : word;
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
      m.remove();
      return out.join("\n");
    } catch (e) {
      return chars;
    }
  }
  async function textSpec(node, base, warnings) {
    const pos = relPos(node, base);
    let segs;
    try {
      segs = node.getStyledTextSegments(["fontSize", "fontName", "fills", "letterSpacing", "lineHeight", "openTypeFeatures"]);
    } catch (e) {
      segs = null;
    }
    const s0 = segs && segs.length ? segs[0] : null;
    const fontName = s0 ? s0.fontName : node.fontName;
    const fontSize = s0 ? s0.fontSize : node.fontSize;
    addFontUse(fontName, node.characters);
    const effFont = resolveFont(fontName, node.characters);
    noteReplace(warnings, effFont);
    let color = solidOf(s0 ? s0.fills : node.fills);
    if (!color) {
      color = { r: 0, g: 0, b: 0, opacity: 1 };
      warnings.push("文字「" + node.characters.slice(0, 24) + "」使用了非纯色填充，已按黑色导出。");
    }
    const lh = s0 ? s0.lineHeight : node.lineHeight;
    const ls = s0 ? s0.letterSpacing : node.letterSpacing;
    const lhSafe = lh && lh.unit ? lh : { unit: "AUTO" };
    const lsSafe = ls && ls.unit ? ls : { unit: "PERCENT", value: 0 };
    const chars = await renderedLines(node, fontName, fontSize, lsSafe, lhSafe);
    let runs = null;
    if (segs && segs.length > 1) {
      runs = segs.map((s) => {
        const otf = s.openTypeFeatures || {};
        addFontUse(s.fontName, s.characters);
        const rEff = resolveFont(s.fontName, s.characters);
        noteReplace(warnings, rEff);
        return {
          length: s.characters.length,
          fontSize: s.fontSize,
          psFont: rEff.ps,
          color: solidOf(s.fills) || { r: 0, g: 0, b: 0, opacity: 1 },
          letterSpacing: s.letterSpacing && s.letterSpacing.unit ? s.letterSpacing : { unit: "PERCENT", value: 0 },
          sups: !!otf.SUPS,
          subs: !!otf.SUBS
        };
      });
    }
    return commonProps(node, {
      kind: "text",
      name: node.name,
      chars,
      x: pos.x,
      y: pos.y,
      w: node.width,
      h: node.height,
      fontSize,
      psFont: effFont.ps,
      color,
      lineHeight: lhSafe,
      letterSpacing: lsSafe,
      align: node.textAlignHorizontal,
      runs
    });
  }
  async function rasterSpec(node, base) {
    const pos = relPos(node, base);
    const hi = !AE_PRESET && subtreeHasImage(node);
    const scale = hi ? hiScaleFor(node.width, node.height) : EXPORT_SCALE;
    const bytes = await exportPng(node, scale);
    return commonProps(node, {
      kind: "raster",
      name: node.name,
      x: pos.x,
      y: pos.y,
      w: node.width,
      h: node.height,
      png: bytes,
      hiRes: hi && scale > 1 ? scale : 0
    });
  }
  async function bgRaster(node, base) {
    const hi = !AE_PRESET && ownImage(node);
    const scale = hi ? hiScaleFor(node.width, node.height) : EXPORT_SCALE;
    let bytes = null;
    if (inInstance(node)) {
      const staged = stageClone(node);
      try {
        if ("children" in staged.shell) {
          for (const c of staged.shell.children) c.visible = false;
        }
        bytes = await exportPng(staged.shell, scale);
      } finally {
        staged.dispose();
      }
    } else {
      const hidden = [];
      if ("children" in node) {
        for (const c of node.children) {
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
      kind: "raster",
      name: node.name + "（背景）",
      x: pos.x,
      y: pos.y,
      w: node.width,
      h: node.height,
      png: bytes,
      hiRes: hi && scale > 1 ? scale : 0
    });
  }
  async function walk(node, base, warnings) {
    const wasHidden = node.visible === false;
    if (wasHidden && !INCLUDE_HIDDEN) return null;
    if (wasHidden && inInstance(node)) {
      const staged = stageClone(node);
      try {
        staged.shell.visible = true;
        const spec2 = await walk(staged.shell, base, warnings);
        if (spec2) {
          spec2.hidden = true;
          spec2.name = node.name;
        }
        return spec2;
      } finally {
        staged.dispose();
      }
    }
    if (wasHidden) node.visible = true;
    let spec = null;
    try {
      if (node.type === "TEXT") {
        spec = await textSpec(node, base, warnings);
      } else if (isRotated(node)) {
        spec = await exportRotated(node, base, warnings);
      } else {
        const isContainer = "children" in node && node.children.length > 0;
        let childHasImage = false;
        if (isContainer) {
          for (const c of node.children) {
            if (subtreeHasImage(c)) {
              childHasImage = true;
              break;
            }
          }
        }
        if (!isContainer || !hasTextDeep(node) && !childHasImage) {
          spec = await rasterSpec(node, base);
        } else {
          const layers = [];
          if (hasOwnPaint(node)) layers.push(await bgRaster(node, base));
          for (const c of node.children) {
            const child = await walk(c, base, warnings);
            if (child) layers.push(child);
          }
          spec = commonProps(node, { kind: "group", name: node.name, layers });
        }
      }
    } finally {
      if (wasHidden) node.visible = false;
    }
    if (spec && wasHidden) spec.hidden = true;
    return spec;
  }
  function expandSelection() {
    const out = [];
    function collect(n) {
      if (n.type === "SECTION") {
        for (const c of n.children) collect(c);
      } else if (n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE" || n.type === "GROUP") {
        out.push(n);
      }
    }
    for (const n of figma.currentPage.selection) collect(n);
    return out;
  }
  function countLayers(node) {
    let n = 1;
    if ("children" in node) {
      for (const c of node.children) n += countLayers(c);
    }
    return n;
  }
  function reportSelection() {
    const sel = expandSelection();
    const frames = sel.map((f) => ({
      name: f.name,
      w: Math.round(f.width),
      h: Math.round(f.height),
      layers: countLayers(f)
    }));
    figma.ui.postMessage({
      type: "selection",
      frames,
      count: frames.length,
      layers: frames.reduce((a, f) => a + f.layers, 0)
    });
  }
  async function run() {
    fontUses.clear();
    resolveCache.clear();
    const sel = expandSelection();
    if (!sel.length) {
      figma.ui.postMessage({ type: "status", text: "请先选中画板（Frame）或分区（Section），再点击导出。" });
      return;
    }
    for (const root of sel) collectFonts(root);
    const indexOk = await loadFontIndex();
    figma.ui.postMessage({ type: "fontCheck", ok: indexOk, fonts: indexOk ? fontReport() : [] });
    figma.ui.postMessage({ type: "begin", count: sel.length });
    for (let i = 0; i < sel.length; i++) {
      const root = sel[i];
      const t = root.absoluteTransform;
      const base = { x: t[0][2], y: t[1][2] };
      const warnings = [];
      figma.ui.postMessage({ type: "status", text: "正在读取 " + root.name + "（" + (i + 1) + "/" + sel.length + "）…" });
      try {
        const spec = await walk(root, base, warnings);
        const composite = await exportPng(root, EXPORT_SCALE);
        let proofJpg = null;
        if (JPG_SCALE === EXPORT_SCALE) proofJpg = composite;
        else if (JPG_SCALE > 0) proofJpg = await exportPng(root, JPG_SCALE);
        let proofPng = null;
        if (PNG_SCALE === EXPORT_SCALE) proofPng = composite;
        else if (PNG_SCALE > 0 && PNG_SCALE === JPG_SCALE) proofPng = proofJpg;
        else if (PNG_SCALE > 0) proofPng = await exportPng(root, PNG_SCALE);
        figma.ui.postMessage({
          type: "piece",
          name: root.name,
          page: figma.currentPage.name,
          index: i + 1,
          width: Math.round(root.width),
          height: Math.round(root.height),
          scale: EXPORT_SCALE,
          spec,
          composite,
          proofJpg,
          proofPng,
          warnings
        });
        await new Promise((resolve) => {
          figma.ui.once("message", () => resolve());
        });
      } catch (err) {
        figma.ui.postMessage({ type: "pieceError", name: root.name, error: String(err && err.message || err) });
      }
    }
    figma.ui.postMessage({ type: "done" });
  }
  figma.ui.onmessage = async (msg) => {
    if (!msg) return;
    if (msg.type === "export") {
      EXPORT_SCALE = msg.scale === 2 ? 2 : 1;
      JPG_SCALE = msg.jpgScale || 0;
      PNG_SCALE = msg.pngScale || 0;
      INCLUDE_HIDDEN = !!msg.includeHidden;
      AE_PRESET = !!msg.aePreset;
      run();
    } else if (msg.type === "saveRenameMap") {
      await figma.clientStorage.setAsync("layerportRenameMap", msg.map);
      figma.ui.postMessage({ type: "renameMapLoaded", count: Object.keys(msg.map).length });
    } else if (msg.type === "ready") {
      reportSelection();
    }
  };
  figma.on("selectionchange", reportSelection);
  (async function init() {
    const map = await figma.clientStorage.getAsync("layerportRenameMap");
    if (map) figma.ui.postMessage({ type: "renameMapLoaded", count: Object.keys(map).length, map });
  })();
})();
