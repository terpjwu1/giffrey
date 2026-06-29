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
  const { inputPath, outputPath, trim, crop, hasAudio, webcamOverlay } = options;

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

  // No modifications and no webcam: codec copy (instant remux)
  if (isNativeCapture && !needsTrim && !needsCrop && !webcamOverlay) {
    args.push('-c', 'copy', '-movflags', '+faststart', outputPath);
    return args;
  }

  // Add webcam overlay as second input
  if (webcamOverlay) {
    args.push('-i', webcamOverlay.path);
    // Circular mask overlay using filter_complex
    const size = webcamOverlay.size || 300;
    const x = Math.round(webcamOverlay.x * crop.width - size / 2);
    const y = Math.round(webcamOverlay.y * crop.height - size / 2);
    const filterParts = [];
    // Scale and mask the webcam (input 1)
    filterParts.push(`[1:v]scale=${size}:${size},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(W/2)*(W/2)),255,0)'[cam]`);
    // Apply crop to main video if needed, then overlay
    if (!isFullCrop) {
      filterParts.push(`[0:v]crop=${cropW}:${cropH}:${cropX}:${cropY}[main]`);
      filterParts.push(`[main][cam]overlay=${x}:${y}:format=auto[out]`);
    } else {
      filterParts.push(`[0:v][cam]overlay=${x}:${y}:format=auto[out]`);
    }
    args.push('-filter_complex', filterParts.join(';'));
    args.push('-map', '[out]');
    if (hasAudio) args.push('-map', '0:a');
  } else {
    if (!isFullCrop) {
      args.push('-vf', `crop=${cropW}:${cropH}:${cropX}:${cropY}`);
    }
  }

  args.push(
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', '18',
  );

  if (hasAudio) {
    if (isNativeCapture && !needsTrim && !webcamOverlay) {
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
