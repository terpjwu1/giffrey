export const MIN_RETINA_SCALE_FACTOR = 1.25;

export interface CaptureDimensions {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly scaleFactor: number;
  readonly upscaled: boolean;
}

export interface DisplayCaptureInfo {
  readonly scaleFactor?: number;
  readonly size?: {
    readonly width?: number;
    readonly height?: number;
  } | null;
}

export function normalizeScaleFactor(scaleFactor: unknown): number {
  return typeof scaleFactor === "number" && Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
}

export function calculateCaptureDimensions(
  sourceWidth: number,
  sourceHeight: number,
  displayInfo: unknown
): CaptureDimensions {
  const info = displayInfo && typeof displayInfo === "object" ? displayInfo as DisplayCaptureInfo : { scaleFactor: displayInfo as number };
  const normalizedScaleFactor = normalizeScaleFactor(info.scaleFactor);
  const upscaled = normalizedScaleFactor >= MIN_RETINA_SCALE_FACTOR;
  const scaledWidth = Math.round(sourceWidth * (upscaled ? normalizedScaleFactor : 1));
  const scaledHeight = Math.round(sourceHeight * (upscaled ? normalizedScaleFactor : 1));
  const nativeWidth = info.size?.width;
  const nativeHeight = info.size?.height;

  return {
    sourceWidth,
    sourceHeight,
    outputWidth: upscaled && typeof nativeWidth === "number" && nativeWidth >= scaledWidth ? nativeWidth : scaledWidth,
    outputHeight: upscaled && typeof nativeHeight === "number" && nativeHeight >= scaledHeight ? nativeHeight : scaledHeight,
    scaleFactor: normalizedScaleFactor,
    upscaled,
  };
}

export async function getDisplayCaptureInfo(): Promise<DisplayCaptureInfo> {
  const giffrey = (window as Window & { giffrey?: { getDisplayCaptureInfo?: () => Promise<DisplayCaptureInfo> } }).giffrey;
  return await giffrey?.getDisplayCaptureInfo?.() || { scaleFactor: 1 };
}
