export function selectMimeType(hasAudio: boolean): string {
  return hasAudio ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp9';
}

export interface CombinedStreamResult {
  stream: MediaStream;
  hasAudio: boolean;
}

export function buildCombinedStream(
  displayStream: MediaStream,
  micStream: MediaStream | null
): CombinedStreamResult {
  const tracks: MediaStreamTrack[] = [...displayStream.getVideoTracks()];

  if (micStream) {
    tracks.push(...micStream.getAudioTracks());
  }

  return {
    stream: new MediaStream(tracks),
    hasAudio: micStream !== null && micStream.getAudioTracks().length > 0,
  };
}
