import { spawn, ChildProcess } from 'child_process';
import { statSync } from 'fs';
import { buildFFmpegArgs, resolveFFmpegPath } from './ffmpeg';

export type Mp4ExportResult =
  | { ok: true; filePath: string; sizeBytes: number }
  | { ok: false; error: { code: 'cancelled' | 'ffmpeg_missing' | 'transcode_failed' | 'disk_full' | 'write_failed'; message: string; recoverable: boolean } };

export interface ExportJobOptions {
  inputPath: string;
  outputPath: string;
  trim: { startMs: number; endMs: number };
  crop: { left: number; top: number; width: number; height: number };
  hasAudio: boolean;
  durationMs: number;
  ffmpegPath?: string;
  onProgress?: (ratio: number) => void;
}

export interface ExportJob {
  status: 'pending' | 'running' | 'done' | 'cancelled';
  run(): Promise<Mp4ExportResult>;
  cancel(): void;
}

export function parseProgress(line: string, durationMs: number): number | null {
  const match = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseFloat(match[3]);
  const timeMs = (hours * 3600 + minutes * 60 + seconds) * 1000;

  if (durationMs <= 0) return 0;
  return Math.min(timeMs / durationMs, 1);
}

export function createExportJob(options: ExportJobOptions): ExportJob {
  const { inputPath, outputPath, trim, crop, hasAudio, durationMs, ffmpegPath, onProgress } = options;

  let status: ExportJob['status'] = 'pending';
  let childProcess: ChildProcess | null = null;
  let cancelled = false;

  const resolvedPath = ffmpegPath ?? resolveFFmpegPath(false);

  const job: ExportJob = {
    get status() { return status; },

    async run(): Promise<Mp4ExportResult> {
      status = 'running';

      const args = buildFFmpegArgs({ inputPath, outputPath, trim, crop, hasAudio });

      return new Promise<Mp4ExportResult>((resolve) => {
        try {
          childProcess = spawn(resolvedPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err: any) {
          status = 'done';
          resolve({ ok: false, error: { code: 'ffmpeg_missing', message: `Failed to spawn ffmpeg: ${err.message}`, recoverable: false } });
          return;
        }

        let stderr = '';
        let stderrBuffer = '';

        childProcess.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          stderr += text;

          if (onProgress) {
            stderrBuffer += text;
            const lines = stderrBuffer.split(/[\r\n]+/);
            stderrBuffer = lines.pop() || '';
            for (const line of lines) {
              const ratio = parseProgress(line, durationMs);
              if (ratio !== null) {
                onProgress(ratio);
              }
            }
          }
        });

        childProcess.on('close', (code) => {
          childProcess = null;

          if (cancelled) {
            status = 'cancelled';
            resolve({
              ok: false,
              error: { code: 'cancelled', message: 'Export cancelled by user', recoverable: true },
            });
            return;
          }

          if (code !== 0) {
            status = 'done';
            const isDiskFull = stderr.includes('No space left on device') || stderr.includes('ENOSPC');
            resolve({
              ok: false,
              error: {
                code: isDiskFull ? 'disk_full' : 'transcode_failed',
                message: isDiskFull
                  ? 'Not enough disk space to save the MP4'
                  : `FFmpeg exited with code ${code}`,
                recoverable: true,
              },
            });
            return;
          }

          try {
            const stat = statSync(outputPath);
            status = 'done';
            resolve({ ok: true, filePath: outputPath, sizeBytes: stat.size });
          } catch (err: any) {
            status = 'done';
            resolve({
              ok: false,
              error: { code: 'write_failed', message: `Output file not found: ${err.message}`, recoverable: true },
            });
          }
        });

        childProcess.on('error', (err) => {
          childProcess = null;
          status = 'done';
          resolve({
            ok: false,
            error: { code: 'ffmpeg_missing', message: `Failed to spawn ffmpeg: ${err.message}`, recoverable: false },
          });
        });
      });
    },

    cancel() {
      cancelled = true;
      if (childProcess) {
        childProcess.kill('SIGTERM');
      }
    },
  };

  return job;
}
