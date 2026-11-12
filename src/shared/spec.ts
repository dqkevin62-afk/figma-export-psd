// Layer spec passed from the plugin sandbox to the UI thread.
// The sandbox reads the Figma document and produces these; the UI
// composes them into a PSD document with ag-psd.

export interface ColorSpec {
  r: number;
  g: number;
  b: number;
  opacity: number;
}

export interface UnitValue {
  unit: string;
  value?: number;
}

export interface BaseSpec {
  name: string;
  opacity?: number;
  blend?: string;
  hidden?: boolean;
}

export interface RasterSpec extends BaseSpec {
  kind: 'raster';
  x: number;
  y: number;
  w: number;
  h: number;
  png: Uint8Array;
  // When > 0, the PNG was exported at this multiple of layout size and
  // should embed as a Smart Object scaled back down to layout size.
  hiRes: number;
}

export interface TextRunSpec {
  length: number;
  fontSize: number;
  psFont: string;
  color: ColorSpec;
  letterSpacing: UnitValue;
  sups: boolean;
  subs: boolean;
}

export interface TextSpec extends BaseSpec {
  kind: 'text';
  chars: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  psFont: string;
  color: ColorSpec;
  lineHeight: UnitValue;
  letterSpacing: UnitValue;
  align: string;
  runs: TextRunSpec[] | null;
}

export interface GroupSpec extends BaseSpec {
  kind: 'group';
  layers: LayerSpec[];
}

export type LayerSpec = RasterSpec | TextSpec | GroupSpec;
