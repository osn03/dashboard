// Preparing screenshots and photos for the assistant, entirely in the browser.
import { IMAGE_TYPES, type ChatImage } from '../../shared/types';

export interface Attachment extends ChatImage {
  /** Object URL for the thumbnail. */
  url: string;
  name: string;
}

const MAX_EDGE = 1568; // larger images are scaled down by the model providers anyway
const KEEP_BYTES = 1_500_000;

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Turns a pasted, dropped, chosen or captured image into an attachment. Large images are
 * scaled down and re-encoded as JPEG so they stay small; small PNG/JPEG/WebP/GIF go as they are.
 */
export async function prepareImage(blob: Blob, name = 'image'): Promise<Attachment> {
  if (!blob.type.startsWith('image/')) throw new Error('That file is not an image.');
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (!bitmap) throw new Error('That image could not be read.');
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  let out = blob;
  if (scale < 1 || blob.size > KEEP_BYTES || !(IMAGE_TYPES as readonly string[]).includes(blob.type)) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; // transparent screenshots would otherwise turn black as JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    out = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('That image could not be converted.'))), 'image/jpeg', 0.9));
  }
  bitmap.close();
  return { mediaType: out.type as ChatImage['mediaType'], data: await toBase64(out), url: URL.createObjectURL(out), name };
}

export const canCaptureScreen = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

/**
 * Takes one still picture of a window, tab or screen. The browser shows its own chooser and
 * nothing is captured unless you pick something there; sharing stops right after the picture.
 */
export async function captureScreen(): Promise<Attachment | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    return null; // cancelled in the browser's chooser
  }
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 350)); // let the first full frame arrive
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob || !canvas.width) throw new Error('The screen capture came back empty.');
    return await prepareImage(blob, 'Screen capture');
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
