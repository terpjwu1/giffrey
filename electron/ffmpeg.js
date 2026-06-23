const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function resolveFFmpegPath(isPackaged, resourcesPath, platform) {
  if (isPackaged && resourcesPath) {
    const bin = (platform ?? process.platform) === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    return path.join(resourcesPath, bin);
  }
  return require('ffmpeg-static');
}

function validateFFmpeg(ffmpegPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(ffmpegPath)) {
      resolve({
        valid: false,
        error: {
          code: 'ffmpeg_missing',
          message: `FFmpeg binary not found at: ${ffmpegPath}`,
          recoverable: false,
        },
      });
      return;
    }

    execFile(ffmpegPath, ['-version'], (error) => {
      if (error) {
        resolve({
          valid: false,
          error: {
            code: 'ffmpeg_invalid',
            message: `FFmpeg binary exists but failed validation: ${error.message}`,
            recoverable: false,
          },
        });
      } else {
        resolve({ valid: true });
      }
    });
  });
}

function roundEven(n) {
  return Math.floor(n / 2) * 2;
}

function buildFFmpegArgs(options) {
  const { inputPath, outputPath, trim, crop, hasAudio } = options;

  const cropW = roundEven(crop.width);
  const cropH = roundEven(crop.height);
  const cropX = roundEven(crop.left);
  const cropY = roundEven(crop.top);

  const isNativeCapture = inputPath.endsWith('.mp4');

  const args = ['-y', '-i', inputPath];

  const validTrim = !(trim.startMs > 0 && trim.endMs > 0 && trim.startMs >= trim.endMs);
  if (validTrim && trim.startMs > 0) {
    args.push('-ss', (trim.startMs / 1000).toString());
  }
  if (validTrim && trim.endMs > 0 && trim.startMs > 0) {
    args.push('-t', ((trim.endMs - trim.startMs) / 1000).toString());
  } else if (validTrim && trim.endMs > 0) {
    args.push('-t', (trim.endMs / 1000).toString());
  }
  const needsTrim = validTrim && (trim.startMs > 0 || trim.endMs > 0);

  const isFullCrop = cropX === 0 && cropY === 0;
  const needsCrop = !isFullCrop;

  // Q2: This app writes native ScreenCaptureKit recordings as .mp4 and MediaRecorder captures as .webm, so the extension is the dispatch signal here.
  // Q3: Remuxing an already-finalized MP4 with -c copy is valid; +faststart just relocates the moov atom for playback startup without re-encoding.
  if (isNativeCapture && !needsTrim && !needsCrop) {
    args.push('-c', 'copy', '-movflags', '+faststart', outputPath);
    return args;
  }

  if (!isFullCrop) {
    args.push('-vf', `crop=${cropW}:${cropH}:${cropX}:${cropY}`);
  }

  args.push(
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', '18',
  );

  if (hasAudio) {
    if (isNativeCapture && !needsTrim) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', '128k');
    }
  } else {
    args.push('-an');
  }

  args.push(outputPath);

  return args;
}

module.exports = { resolveFFmpegPath, validateFFmpeg, buildFFmpegArgs };
