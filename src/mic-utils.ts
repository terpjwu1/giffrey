export function selectMimeType(hasAudio: boolean): string {
  // VP8 respects videoBitsPerSecond; VP9's screen-content mode ignores it
  return hasAudio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8';
}

export interface CombinedStreamResult {
  stream: MediaStream;
  hasAudio: boolean;
}

export function getAudioTracks(micStream: MediaStream | null): MediaStreamTrack[] {
  return micStream ? micStream.getAudioTracks() : [];
}

export function buildCombinedStream(
  displayStream: MediaStream,
  micStream: MediaStream | null
): CombinedStreamResult {
  const audioTracks = getAudioTracks(micStream);
  const tracks: MediaStreamTrack[] = [...displayStream.getVideoTracks(), ...audioTracks];

  return {
    stream: new MediaStream(tracks),
    hasAudio: audioTracks.length > 0,
  };
}

export function buildCanvasRecordingStream(
  canvasStream: MediaStream,
  micStream: MediaStream | null
): CombinedStreamResult {
  const audioTracks = getAudioTracks(micStream);

  return {
    stream: new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]),
    hasAudio: audioTracks.length > 0,
  };
}
