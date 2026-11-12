// Layerport UI thread. Receives layer specs + PNG bytes from the sandbox,
// composes PSD documents with ag-psd, and hands the files to the browser.

import { writePsdUint8Array } from 'ag-psd';
import type { GroupSpec, LayerSpec } from '../shared/spec';
import { exportName, parseRenameMap } from './naming';
import { canvasToImageData, decodePng, imgToCanvas, toPsdLayer, type LinkedFile } from './psd';
import { encodeTiff, type TiffMode } from './tiff';
import { buildZip, type ZipEntry } from './zip';

let renameMap: Record<string, string> = {};
// Every file the run produces accumulates here and is delivered ONCE at the
// end: a single file downloads directly, anything more becomes one ZIP.
// Figma's plugin sandbox honors only the first synthetic download click per
// burst, so firing psd + proofs + tiff as separate downloads loses files.
let runFiles: ZipEntry[] = [];
let runBase: string | null = null;
let batchCount = 0;
const usedNames = new Set<string>();
// Settings snapshot taken when Export is pressed, so changing controls while
// a batch is composing cannot produce mixed output.
let settings = { dpi: 72, tiff: false, tiffMode: 'rgb' as TiffMode, jpgScale: 0, pngScale: 0, template: '{frame}' };

const MIME: Record<string, string> = {
  psd: 'image/vnd.adobe.photoshop',
  jpg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
};

const $ = (id: string) => document.getElementById(id)!;
const checked = (id: string) => ($(id) as HTMLInputElement).checked;
const selValue = (id: string) => ($(id) as HTMLSelectElement).value;
const log = $('log');
const selInfo = $('selInfo');
const selList = $('selList');
const progress = $('progress');
const progressText = $('progressText');
// 进度条画在导出按钮上：按钮内一层从左往右推进的深色填充 + 按钮文字显示百分比。
const btnFill = $('btnFill');
const btnLabel = $('btnLabel');
const fontBox = $('fontBox');
const result = $('result');
const logSummary = $('logSummary');
let doneCount = 0;
let totalCount = 0;
// 成功 / 失败计数：结束时用绿点、红点逐个显示，并给出失败原因与解决办法。
let okCount = 0;
let failCount = 0;
interface Failure { name: string; raw: string; cause: string; fix: string; }
const failures: Failure[] = [];

// 把常见报错翻译成「原因 + 该怎么办」，用户不需要看懂英文堆栈。
function explainError(raw: string): { cause: string; fix: string } {
  const e = (raw || '').toLowerCase();
  if (e.indexOf('memory') >= 0 || e.indexOf('allocation') >= 0 || e.indexOf('array buffer') >= 0) {
    return {
      cause: '内存不足：一次性合成的像素太多（画板尺寸过大或一次导出的画板过多）。',
      fix: '取消「以 2x 导出」，或把画板分批选中后分几次导出；也可以关闭 JPG / PNG 预览图再试。',
    };
  }
  if (e.indexOf('does not exist') >= 0 || e.indexOf('cannot read') >= 0 || e.indexOf('undefined') >= 0) {
    return {
      cause: '图层在导出过程中被修改或删除，读到的节点已经不存在。',
      fix: '确认导出期间没有在 Figma 里编辑该画板，按 R 刷新插件后重新导出。',
    };
  }
  if (e.indexOf('not allowed') >= 0 || e.indexOf('permission') >= 0 || e.indexOf('no access') >= 0) {
    return {
      cause: '没有该画板的读取权限（多来自团队库组件或只读文件）。',
      fix: '让文件所有者给你编辑权限，或先把画板复制到自己的文件里再导出。',
    };
  }
  if (e.indexOf('image') >= 0 && (e.indexOf('decode') >= 0 || e.indexOf('load') >= 0)) {
    return {
      cause: '有图片素材无法渲染（图片填充被删除、链接失效或格式不支持）。',
      fix: '把该画板里失效的图片重新拖入替换，再单独导出这一张确认。',
    };
  }
  if (e.indexOf('font') >= 0) {
    return {
      cause: '字体相关错误：某个文字图层用的字体加载失败。',
      fix: '插件已自动把缺失字体替换为系统字体，请更新到最新版本后重试；仍失败就把该文字图层复制成新图层再导出。',
    };
  }
  if (e.indexOf('out of range') >= 0 || e.indexOf('resize') >= 0 || e.indexOf('invalid') >= 0) {
    return {
      cause: '画板尺寸或图层数据超出可处理范围（尺寸为 0、过大或图层过多）。',
      fix: '检查画板是否有 0 尺寸的子图层；把超大画板缩小或拆分后再导出。',
    };
  }
  return {
    cause: '未归类的异常，原始信息：' + (raw || '（无）'),
    fix: '先重试一次；仍失败请单独导出这一张画板，并把上面这条原始信息发给我排查。',
  };
}

function recordFailure(name: string, raw: string): void {
  failCount++;
  const ex = explainError(raw);
  failures.push({ name, raw, cause: ex.cause, fix: ex.fix });
  addRow('✖ ' + name + '｜' + ex.cause, 'err');
  addRow('　→ 解决办法：' + ex.fix, 'err');
}

// ---- 完成音效（Web Audio 现场合成，不依赖任何音频文件）----
let audioCtx: AudioContext | null = null;
function ensureAudio(): AudioContext | null {
  try {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    let ctx = audioCtx;
    if (!ctx) {
      ctx = new Ctor() as AudioContext;
      audioCtx = ctx;
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch (e) {
    return null;
  }
}
function tone(ctx: AudioContext, freq: number, delay: number, dur: number, vol: number, type: OscillatorType) {
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}
function playDone(allOk: boolean): void {
  const ctx = ensureAudio();
  if (!ctx) return;
  if (allOk) {
    // 上行两声：完成
    tone(ctx, 784, 0, 0.16, 0.13, 'sine');
    tone(ctx, 1047, 0.1, 0.26, 0.12, 'sine');
  } else {
    // 下行两声：有失败
    tone(ctx, 494, 0, 0.16, 0.11, 'triangle');
    tone(ctx, 349, 0.13, 0.3, 0.11, 'triangle');
  }
}

function renderResult(): void {
  result.replaceChildren();
  result.style.display = 'block';
  const line = document.createElement('div');
  line.className = 'line';
  const gDot = document.createElement('span');
  gDot.className = 'dot g';
  const gCnt = document.createElement('span');
  gCnt.className = 'cnt';
  gCnt.textContent = String(okCount);
  const gTxt = document.createElement('span');
  gTxt.textContent = '成功';
  const rDot = document.createElement('span');
  rDot.className = 'dot r';
  rDot.style.marginLeft = '6px';
  const rCnt = document.createElement('span');
  rCnt.className = 'cnt';
  rCnt.textContent = String(failCount);
  const rTxt = document.createElement('span');
  rTxt.textContent = '失败';
  line.append(gDot, gCnt, gTxt, rDot, rCnt, rTxt);
  if (failCount) {
    const tip = document.createElement('span');
    tip.className = 'more';
    tip.textContent = '（展开下方「点击查看详细信息」看原因与解决办法）';
    line.appendChild(tip);
  }
  result.appendChild(line);

  const dots = document.createElement('div');
  dots.className = 'dots';
  const CAP = 80;
  const total = okCount + failCount;
  const shown = Math.min(total, CAP);
  for (let i = 0; i < shown; i++) {
    const d = document.createElement('span');
    d.className = 'dot ' + (i < okCount ? 'g' : 'r');
    dots.appendChild(d);
  }
  if (total > CAP) {
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = '+' + (total - CAP);
    dots.appendChild(more);
  }
  result.appendChild(dots);
}

function updateProgress(): void {
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  btnFill.style.width = pct + '%';
  btnLabel.textContent = totalCount > 0 ? '导出中 ' + pct + '%' : '导出选中内容为 PSD';
}

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function addRow(text: string, cls?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'row' + (cls ? ' ' + cls : '');
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function uniqueName(base: string): string {
  let name = base;
  for (let i = 2; usedNames.has(name); i++) name = base + '-' + i;
  usedNames.add(name);
  return name;
}

$('saveRenameMap').onclick = () => {
  try {
    const map = parseRenameMap(($('renameMapBox') as HTMLTextAreaElement).value);
    renameMap = map;
    parent.postMessage({ pluginMessage: { type: 'saveRenameMap', map } }, '*');
  } catch (e: any) {
    addRow('重命名映射解析失败：' + e.message, 'err');
  }
};

$('go').onclick = () => {
  log.replaceChildren();
  usedNames.clear();
  totalCount = 0;
  doneCount = 0;
  okCount = 0;
  failCount = 0;
  failures.length = 0;
  progress.style.display = 'none';
  progressText.textContent = '';
  btnFill.style.width = '0%';
  btnLabel.textContent = '导出中 0%';
  result.style.display = 'none';
  result.replaceChildren();
  fontBox.style.display = 'none';
  fontBox.replaceChildren();
  logSummary.textContent = '点击查看详细信息';
  // 在用户点击这一次手势里初始化音频，完成时才不会被浏览器拦。
  ensureAudio();
  settings = {
    dpi: parseInt(selValue('dpi'), 10) || 72,
    tiff: checked('tiffOut'),
    tiffMode: selValue('tiffMode') as TiffMode,
    jpgScale: checked('jpgProof') ? parseInt(selValue('jpgScale'), 10) : 0,
    pngScale: checked('pngProof') ? parseInt(selValue('pngScale'), 10) : 0,
    template: ($('nameTemplate') as HTMLInputElement).value,
  };
  parent.postMessage(
    {
      pluginMessage: {
        type: 'export',
        scale: checked('scale2') ? 2 : 1,
        jpgScale: settings.jpgScale,
        pngScale: settings.pngScale,
        includeHidden: checked('includeHidden'),
        aePreset: checked('aePreset'),
      },
    },
    '*',
  );
};

async function toJpegBytes(pngBytes: Uint8Array): Promise<Uint8Array> {
  const img = await decodePng(pngBytes);
  const canvas = imgToCanvas(img, img.naturalWidth, img.naturalHeight);
  return await new Promise<Uint8Array>((resolve) => {
    canvas.toBlob(
      (blob) => {
        blob!.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)));
      },
      'image/jpeg',
      0.92,
    );
  });
}

function tiffFromCanvas(canvas: HTMLCanvasElement, mode: TiffMode, dpi: number): Uint8Array {
  // Composite over white first: print files have no alpha, and JPEG-style
  // black fill is the wrong default for paper.
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  const rgba = ctx.getImageData(0, 0, flat.width, flat.height).data;
  return encodeTiff(rgba, flat.width, flat.height, dpi, mode);
}

onmessage = async (e: MessageEvent) => {
  const msg = e.data.pluginMessage;
  if (!msg) return;
  if (msg.type === 'renameMapLoaded') {
    if (msg.map) renameMap = msg.map;
    $('renameMapStatus').textContent = '（已载入 ' + msg.count + ' 条名称）';
    return;
  }
  if (msg.type === 'selection') {
    const frames: { name: string; w: number; h: number; layers: number }[] = msg.frames || [];
    selList.replaceChildren();
    if (!frames.length) {
      selInfo.textContent = '未选中画板：请在 Figma 中选中一个或多个画板 / 分区。';
      return;
    }
    const ws = frames.map((f) => f.w);
    const hs = frames.map((f) => f.h);
    const minW = Math.min(...ws);
    const maxW = Math.max(...ws);
    const minH = Math.min(...hs);
    const maxH = Math.max(...hs);
    const sizeText =
      minW === maxW && minH === maxH
        ? minW + '×' + maxH
        : minW + '×' + minH + ' ~ ' + maxW + '×' + maxH;
    selInfo.textContent = '已选 ' + frames.length + ' 个画板 · 共 ' + msg.layers + ' 个图层 · 尺寸 ' + sizeText;
    for (const f of frames) {
      const row = document.createElement('div');
      row.className = 'row';
      row.textContent = f.name + ' — ' + f.w + '×' + f.h + '，' + f.layers + ' 个图层';
      selList.appendChild(row);
    }
    return;
  }
  if (msg.type === 'begin') {
    batchCount = msg.count;
    totalCount = msg.count;
    doneCount = 0;
    runFiles = [];
    runBase = null;
    progress.style.display = 'block';
    updateProgress();
    return;
  }
  if (msg.type === 'status') {
    addRow(msg.text);
    // 没有导出任务时（例如未选中画板），把提示显示在进度条那一行，
    // 避免折叠的日志里静默无反馈。
    if (totalCount === 0) {
      progress.style.display = 'block';
      btnFill.style.width = '0%';
      btnLabel.textContent = '导出选中内容为 PSD';
      progressText.textContent = msg.text;
    }
    return;
  }
  if (msg.type === 'pieceError') {
    recordFailure(msg.name, msg.error);
    doneCount++;
    updateProgress();
    return;
  }
  if (msg.type === 'done') {
    const outBytes = runFiles.reduce((a, f) => a + f.data.length, 0);
    let outCount = 0;
    if (runFiles.length === 1) {
      const f = runFiles[0];
      const ext = f.name.slice(f.name.lastIndexOf('.') + 1);
      download(new Blob([f.data as BlobPart], { type: MIME[ext] || 'application/octet-stream' }), f.name);
      addRow('已下载 ' + f.name + '。', 'ok');
      outCount = 1;
    } else if (runFiles.length > 1) {
      outCount = runFiles.length;
      const zipRow = addRow('正在打包 ' + runFiles.length + ' 个文件…');
      const zip = buildZip(runFiles);
      const zipName = batchCount === 1 && runBase ? runBase + '.zip' : 'Layerport_' + runFiles.length + 'files_' + Math.round(zip.size / 1048576) + 'MB.zip';
      download(zip, zipName);
      zipRow.textContent = zipName + ' 已下载（' + runFiles.length + ' 个文件打包成一个 ZIP；Figma 每次导出只允许保存一次）。';
      zipRow.className = 'row ok';
    }
    runFiles = [];
    if (!okCount && !failCount) {
      addRow('本次没有生成任何文件。', 'warn');
    } else {
      addRow('全部完成：成功 ' + okCount + ' 个，失败 ' + failCount + ' 个。', failCount ? 'err' : 'ok');
    }
    btnFill.style.width = '100%';
    btnLabel.textContent = '导出完成 100%';
    progressText.textContent =
      '导出完成：成功 ' + okCount + ' 个，失败 ' + failCount + ' 个' + (outBytes ? ' · ' + fmtSize(outBytes) : '');
    renderResult();
    logSummary.textContent = failCount
      ? '点击查看详细信息（含 ' + failCount + ' 项失败原因与解决办法）'
      : '点击查看详细信息';
    playDone(failCount === 0 && okCount > 0);
    return;
  }
  if (msg.type === 'fontCheck') {
    const list: any[] = msg.fonts || [];
    if (!msg.ok) {
      fontBox.className = 'alert red';
      fontBox.style.display = 'block';
      fontBox.textContent = '无法读取本机字体列表，字体将按设计原样写入 PSD：若本机缺字体，Photoshop 会替换字体。';
      return;
    }
    if (!list.length) {
      fontBox.style.display = 'none';
      return;
    }
    const bad = list.filter((f) => f.status !== 'ok');
    fontBox.replaceChildren();
    fontBox.style.display = 'block';
    if (!bad.length) {
      fontBox.className = 'alert ok';
      fontBox.textContent = '字体检查通过：' + list.length + ' 个字体本机均已安装，文字可在 Photoshop 里正常显示。';
      return;
    }
    fontBox.className = 'alert red';
    const head = document.createElement('div');
    head.textContent = '⚠ 本机未安装 ' + bad.length + ' 个字体，已自动替换为系统默认字体导出，PSD 打开不会缺字体：';
    const ul = document.createElement('ul');
    for (const f of bad) {
      const li = document.createElement('li');
      const onlyStyle = f.status === 'style';
      li.textContent = f.label + (f.replacedBy ? ' → 已替换为 ' + f.replacedBy : '') + (onlyStyle ? '（仅缺该字重）' : '');
      ul.appendChild(li);
    }
    const tail = document.createElement('div');
    tail.className = 'tail';
    tail.textContent = '想保留原始字形：安装上述字体后重新导出即可自动恢复。';
    fontBox.append(head, ul, tail);
    return;
  }
  if (msg.type !== 'piece') return;
  const row = addRow('正在生成 ' + msg.name + '…');
  try {
    const scale: number = msg.scale || 1;
    const dpi = settings.dpi;
    const spec: LayerSpec = msg.spec;
    const rootLayers = spec.kind === 'group' ? (spec as GroupSpec).layers : [spec];
    const linkedFiles: LinkedFile[] = [];
    const children = [];
    for (const l of rootLayers) children.push(await toPsdLayer(l, scale, linkedFiles));
    const compImg = await decodePng(msg.composite);
    const compCanvas = imgToCanvas(compImg, compImg.naturalWidth, compImg.naturalHeight);
    const psd: any = {
      width: msg.width * scale,
      height: msg.height * scale,
      imageData: canvasToImageData(compCanvas),
      imageResources: {
        resolutionInfo: {
          horizontalResolution: dpi,
          horizontalResolutionUnit: 'PPI',
          widthUnit: 'Inches',
          verticalResolution: dpi,
          verticalResolutionUnit: 'PPI',
          heightUnit: 'Inches',
        },
      },
      children,
    };
    if (linkedFiles.length) psd.linkedFiles = linkedFiles;
    const buf = writePsdUint8Array(psd, { generateThumbnail: true });
    const base = uniqueName(
      exportName(msg.name, renameMap, settings.template, {
        frame: msg.name,
        page: msg.page || '',
        n: msg.index || 1,
        width: msg.width,
        height: msg.height,
      }),
    );
    if (!runBase) runBase = base;
    let tiff: Uint8Array | null = null;
    if (settings.tiff) tiff = tiffFromCanvas(compCanvas, settings.tiffMode, dpi);
    runFiles.push({ name: base + '.psd', data: buf });
    if (msg.proofJpg) runFiles.push({ name: base + '.jpg', data: await toJpegBytes(msg.proofJpg) });
    if (msg.proofPng) runFiles.push({ name: base + '.png', data: new Uint8Array(msg.proofPng) });
    if (tiff) runFiles.push({ name: base + '.tif', data: tiff });
    const extras = [msg.proofJpg && 'JPG', msg.proofPng && 'PNG', tiff && 'TIFF'].filter(Boolean).join(', ');
    row.textContent = base + ' → PSD（' + Math.round(buf.byteLength / 1024) + ' KB，' + linkedFiles.length + ' 个智能对象' + (extras ? '，附加 ' + extras : '') + '）';
    row.className = 'row ok';
    okCount++;
    (msg.warnings || []).forEach((w: string) => addRow(msg.name + '：' + w, 'warn'));
  } catch (err: any) {
    row.remove();
    recordFailure(msg.name, String((err && err.message) || err));
  }
  doneCount++;
  updateProgress();
  parent.postMessage({ pluginMessage: { type: 'ack' } }, '*');
};

// 通知沙箱：UI 已就绪，请推送当前选中信息（画板数 / 图层数 / 尺寸）。
parent.postMessage({ pluginMessage: { type: 'ready' } }, '*');
