import { Recording } from './gifcap';

interface GiffreyAPI {
  saveVideo(blob: ArrayBuffer): Promise<string | null>;
}

export function shouldShowExportVideo(recording: Recording): boolean {
  return recording.videoBlob != null;
}

export async function exportVideo(blob: Blob, api: GiffreyAPI): Promise<string | null> {
  const arrayBuffer = await blob.arrayBuffer();
  return api.saveVideo(arrayBuffer);
}
