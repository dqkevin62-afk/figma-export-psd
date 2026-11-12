# Figma 导出 PSD 插件工具

把 Figma 画板导出为**分层 Photoshop PSD** 的插件。图层组、画板裁剪蒙版、可编辑文字、智能对象图片与纯色矢量形状都会保留，可直接给 Photoshop 精修、给 After Effects 做动效、给 Premiere 剪片。

本仓库是开源项目 [Layerport](https://github.com/graymade/layerport)（MIT）的**中文汉化增强版**，针对中文用户补了字体兜底、失败原因解释和导出进度提示。全程本地运行，不联网、不上传任何设计数据。

- 当前版本：**v1.2.5**（2026-11-12）
- 许可：MIT（见 [LICENSE](LICENSE)）
- 完整图文说明：[使用说明.txt](使用说明.txt)（中英双语，中文在前）

---

## 一、如何安装

### 1. 直接下载（不需要会代码）

到 [Releases](../../releases) 页下载最新的 `Figma-Export-PSD-v1.2.5.zip`，解压到任意目录，得到：

```
manifest.json     插件入口声明（导入时选的就是这个文件）
dist\code.js      插件主逻辑
dist\ui.html      插件界面 + PSD 生成器
使用说明.txt       中英双语说明书
```

### 2. 导入 Figma

Figma 插件只能通过桌面版导入，浏览器版不支持。

1. 打开 **Figma 桌面应用**
2. 菜单 **Plugins → Development → Import plugin from manifest…**
   （中文界面：插件 → 开发 → 从 manifest 导入插件）
3. 选中解压目录里的 `manifest.json` —— 选**文件本身**，不要选文件夹
4. 之后从 **Plugins → Development → Figma 导出 PSD 插件工具** 运行

### 3. 从源码构建（可选，想改代码时用）

```bash
git clone https://github.com/dqkevin62-afk/figma-export-psd.git
cd figma-export-psd
npm install
npm run build      # 产物输出到 dist/
npm run typecheck  # 类型检查
```

`dist/` 已随仓库提交，所以只下载 ZIP 也能直接用，不必构建。

---

## 二、功能

### 选中信息实时显示

面板顶部显示 `已选 5 个画板 · 共 63 个图层 · 尺寸 1024×1024 ~ 1920×1080`；展开「点击查看详细信息」可看到每个画板的名称、尺寸与图层数。支持直接选分区（Section），插件会自动展开其中的画板。

### 导出选项

| 选项 | 作用 |
|---|---|
| 以 2x 导出 | 整个 PSD 与文字字号一起放大一倍，给缩放留余量 |
| 分辨率标记 | 72 / 150 / 300 PPI，只写元数据，不改像素 |
| 包含隐藏图层 | 隐藏图层保留为 PSD 隐藏图层，而不是丢弃 |
| After Effects 交接 | 图片导出为普通像素层（不用智能对象），因为 AE 只读预览像素 |
| JPG / PNG 预览图 | 额外输出 1x–4x 预览图 |
| 扁平化 TIFF | 额外合成扁平图，可选 RGB / CMYK（标准公式，非 ICC） |
| 文件名模板 | `{frame}` `{page}` `{date}` `{n}` `{width}` `{height}` |
| 批量重命名映射 | 名称带 `[#ID]` 的画板按 JSON/CSV 映射改名，优先级高于模板，可持久保存 |

### 进度、结果与音效

- 进度条直接画在导出按钮上：`导出中 42%` → `导出完成 100%`
- 完成后显示绿点（成功数）/ 红点（失败数），一个点对应一个文件，并给出总体积
- 播放完成音效：全部成功是上行两声，有失败是下行两声
- 每个失败都写明**原因 + 解决办法**（内存不足、图层被删、权限、图片失效等均已归类为中文说明）

### 字体兜底（本版重点）

导出前先做字体预检：

- 全部已安装 → 绿色「字体检查通过」
- 有缺失 → **红色警告块逐个列出**，并显示替换成了什么

缺失字体会在写入 PSD 前自动替换为本机系统字体（中文 → 微软雅黑，英文/数字 → Arial，粗体用对应 Bold），因此 **Photoshop 打开 PSD 不会再提示缺字体，文字一定显示得出来**。想保留原始字形：装上字体后重新导出即可恢复（装完字体要完全退出并重开 Photoshop）。

### 多画板批量

选中多个画板导出时自动打包成一个 ZIP（Figma 每次导出只允许保存一次文件）；中文文件名已按 ZIP 规范的 UTF-8 标志位写出，Windows 资源管理器里不会乱码。

---

## 三、导出之后

**Photoshop**：直接打开，图层组、蒙版、可编辑文字、智能对象、混合模式都在。

**After Effects**：导出时勾「After Effects 交接」→ AE `文件 → 导入 → 文件` → 选 **合成 - 保持图层大小** → 每层可单独做动效。

**Premiere Pro**：`文件 → 导入`，按需选 单个图层 / 序列 / 合并所有图层。

---

## 四、已知限制

- 旋转过的图层会栅格化（外观保留，不再是矢量/文字）
- 只有纯色填充+描边的形状导出为可编辑矢量；复杂矢量样式以图片导出
- 文字只支持纯色填充，渐变/图案填充的文字按黑色导出
- 进度以画板为单位推进，单画板内部没有更细进度
- 画板很大 + 2x + 预览图同时开启时可能内存不足，建议分批导出

---

## 五、版本记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v1.2.5 | 2026-11-12 | 缺字体标红 + 自动替换系统字体 + 完成音效 + 成败圆点 + 失败原因与解决办法 + 按钮进度条百分比 |
| v1.2.4 | 2026-11-11 | 按钮进度条、折叠详细信息、选中信息显示、更名与重绘图标 |
| v1.2.3 | 2026-11-11 | 修复批量 ZIP 中文文件名乱码（补写 UTF-8 标志位） |
| v1.2.2 | 2026-11-11 | 导出结束字体清单提示 |
| v1.2.0 | 2026-11-11 | 全界面中文化 |

---

## 六、致谢与许可

原始项目：[graymade/layerport](https://github.com/graymade/layerport)，作者 Sam Gray，MIT 许可。本仓库在其基础上做了中文汉化与若干增强，同样以 MIT 发布，版权声明见 [LICENSE](LICENSE)。

---
---

# Figma to Layered PSD Export Plugin

Export Figma frames as **layered Photoshop PSD** files. Layer groups, frame clipping masks, live text, Smart Object images and solid-fill vector shapes are preserved — ready for Photoshop retouching, After Effects animation or Premiere editing.

This is a **Chinese-localised, enhanced build** of the open-source project [Layerport](https://github.com/graymade/layerport) (MIT). It runs fully offline and uploads nothing.

- Version: **v1.2.5** (2026-11-12)
- Licence: MIT (see [LICENSE](LICENSE))
- Full guide: [使用说明.txt](使用说明.txt) (Chinese first, English after)

## 1. Install

### Download the ready-to-use build

Grab `Figma-Export-PSD-v1.2.5.zip` from [Releases](../../releases) and unzip it anywhere:

```
manifest.json     plugin manifest (this is the file you import)
dist\code.js      plugin logic
dist\ui.html      plugin UI + PSD writer
使用说明.txt       bilingual manual
```

### Import into Figma

Only the **Figma desktop app** can import local plugins.

1. Open the Figma desktop app.
2. **Plugins → Development → Import plugin from manifest…**
3. Select `manifest.json` inside the unzipped folder (the file, not the folder).
4. Run it from **Plugins → Development**.

### Build from source (optional)

```bash
git clone https://github.com/dqkevin62-afk/figma-export-psd.git
cd figma-export-psd
npm install
npm run build
npm run typecheck
```

`dist/` is committed, so downloading the ZIP is enough — no build step required.

## 2. Features

- **Live selection info** — frame count, total layer count and the size range of the selection, with a per-frame breakdown.
- **Export options** — 2x scale, 72/150/300 PPI tag, include hidden layers, After Effects handoff (pixel layers instead of Smart Objects), JPG/PNG proof at 1x–4x, flattened TIFF in RGB or CMYK.
- **Naming** — token template (`{frame}` `{page}` `{date}` `{n}` `{width}` `{height}`) plus a persistent batch rename map for frames tagged `[#ID]`.
- **In-button progress** — the button itself shows `导出中 42%` and ends at `导出完成 100%`.
- **Result summary** — green dots for successful files, red dots for failures, total size, and a completion sound (two rising notes on full success, two descending notes when something failed).
- **Failure reasons with fixes** — every failed frame lists the cause and a suggested fix in Chinese.
- **Font fallback** — missing fonts are listed in a red block before export and substituted with system fonts (Microsoft YaHei for Chinese, Arial for Latin) so the PSD always opens with visible text.
- **Batch export** — multiple frames are packed into one UTF-8-correct ZIP (Chinese filenames no longer garble in Windows Explorer).

## 3. After export

**Photoshop**: open the PSD directly; groups, masks, live text, Smart Objects and blend modes are intact.

**After Effects**: enable "After Effects 交接" → `File → Import → File` → **Composition – Retain Layer Sizes**.

**Premiere Pro**: `File → Import`, then pick Individual Layers / Sequence / Merge All Layers.

## 4. Known limitations

- Rotated layers are rasterised (appearance kept, no longer vector/text).
- Only solid fill + stroke shapes become editable vectors; complex vector styles are exported as images.
- Text supports solid fill only; gradient or pattern text exports black.
- Progress advances per frame; there is no sub-frame progress.
- Very large frames with 2x and proofs may run out of memory — export in batches.

## 5. Credits

Based on [graymade/layerport](https://github.com/graymade/layerport) by Sam Gray (MIT). This fork is released under the same licence.
