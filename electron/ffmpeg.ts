import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface FFmpegError {
  code: 'ffmpeg_missing' | 'ffmpeg_invalid';
  message: string;
  recoverable: boolean;
}

export interface FFmpegValidation {
  valid: boolean;
  error?: FFmpegError;
}

export interface FFmpegExportOptions {
  inputPath: string;
  outputPath: string;
  trim: { startMs: number; endMs: number };
  crop: { left: number; top: number; width: number; height: number };
  hasAudio: boolean;
}

export function resolveFFmpegPath(isPackaged: boolean, resourcesPath?: string, platform?: string): string {
  if (isPackaged && resourcesPath) {
    const bin = (platform ?? process.platform) === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    return path.join(resourcesPath, bin);
  }
  return require('ffmpeg-static') as string;
}

export function validateFFmpeg(ffmpegPath: string): Promise<FFmpegValidation> {
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

function roundEven(n: number): number {
  return Math.floor(n / 2) * 2;
}

export function buildFFmpegArgs(options: FFmpegExportOptions): string[] {
  const { inputPath, outputPath, trim, crop, hasAudio } = options;

  const startSec = (trim.startMs / 1000).toString();
  const endSec = (trim.endMs / 1000).toString();

  const cropW = roundEven(crop.width);
  const cropH = roundEven(crop.height);
  const cropX = roundEven(crop.left);
  const cropY = roundEven(crop.top);

  const args: string[] = [
    '-y',
    '-ss', startSec,
    '-to', endSec,
    '-i', inputPath,
    '-vf', `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'fast',
    '-crf', '23',
  ];

  if (hasAudio) {
    args.push('-c:a', 'aac');
  } else {
    args.push('-an');
  }

  args.push(outputPath);

  return args;
}
