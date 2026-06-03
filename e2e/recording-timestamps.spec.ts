import { test, expect, _electron as electron } from '@playwright/test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const RECORDING_DURATION_MS = Number(process.env.GIFFREY_TIMESTAMP_E2E_MS || 30_000);

test.describe('Recording timestamp integrity', () => {
  test('exports an app-recorded audio/video capture without FFmpeg timestamp errors', async () => {
    test.setTimeout(RECORDING_DURATION_MS + 90_000);

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giffrey-timestamp-e2e-'));
    const outputPath = path.join(outputDir, 'capture.mp4');
    const ffmpegPath = require('ffmpeg-static') as string;

    const electronApp = await electron.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        path.join(__dirname, '..', 'electron', 'main.js'),
      ],
    });

    try {
      await electronApp.evaluate(async ({ dialog }, savePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: savePath });
      }, outputPath);

      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');

      await window.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        canvas.dataset.giffreyTimestampFixture = 'video';
        document.body.appendChild(canvas);

        const ctx = canvas.getContext('2d')!;
        let frame = 0;
        const paint = () => {
          ctx.fillStyle = `hsl(${frame % 360}, 70%, 45%)`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#fff';
          ctx.font = '32px sans-serif';
          ctx.fillText(`frame ${frame}`, 32, 72);
          frame += 1;
        };
        paint();
        const paintTimer = window.setInterval(paint, 1000 / 30);

        let audioContext: AudioContext | null = null;
        let oscillator: OscillatorNode | null = null;
        let audioStream: MediaStream | null = null;

        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
          configurable: true,
          value: async () => canvas.captureStream(30),
        });

        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
          configurable: true,
          value: async () => {
            audioContext = new AudioContext();
            await audioContext.resume();
            oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            const destination = audioContext.createMediaStreamDestination();
            oscillator.frequency.value = 440;
            gain.gain.value = 0.03;
            oscillator.connect(gain);
            gain.connect(destination);
            oscillator.start();
            audioStream = destination.stream;
            return audioStream;
          },
        });

        (window as any).__giffreyCleanupTimestampFixture = async () => {
          window.clearInterval(paintTimer);
          oscillator?.stop();
          audioStream?.getTracks().forEach(track => track.stop());
          await audioContext?.close();
          canvas.captureStream().getTracks().forEach(track => track.stop());
          canvas.remove();
        };
      });

      await window.locator('.mic-toggle input[type="checkbox"]').check();
      await window.getByRole('button', { name: /Start Recording/ }).click();
      await expect(window.getByRole('button', { name: /Stop Recording/ })).toBeVisible();
      await window.waitForTimeout(RECORDING_DURATION_MS);
      await window.getByRole('button', { name: /Stop Recording/ }).click();
      await expect(window.getByRole('button', { name: /Export MP4/ })).toBeVisible({ timeout: 30_000 });
      await window.getByRole('button', { name: /Export MP4/ }).click();
      await expect.poll(() => fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0, {
        timeout: 60_000,
      }).toBeGreaterThan(0);

      const ffmpegCheck = spawnSync(ffmpegPath, ['-v', 'warning', '-i', outputPath, '-f', 'null', '-'], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const ffmpegStderr = ffmpegCheck.stderr || '';

      expect(ffmpegCheck.status).toBe(0);
      expect(ffmpegStderr).not.toMatch(/non monotonically increasing dts|Invalid data found/i);
    } finally {
      try {
        const openWindows = electronApp.windows();
        if (openWindows.length > 0) {
          await openWindows[0].evaluate(async () => {
            await (window as any).__giffreyCleanupTimestampFixture?.();
          });
        }
      } catch {}
      await electronApp.close();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

// This regression runs for 30 real seconds by default so it is practical in CI.
// Set GIFFREY_TIMESTAMP_E2E_MS=600000 to turn it into a true 10-minute soak test.
