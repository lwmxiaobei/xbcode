/**
 * read_file 的图片支持：类型嗅探 + 尺寸解析 + 体积门槛。
 *
 * 和 pi 的差别：pi 用 photon(WASM) 在 worker 线程里真正做缩放，
 * 这里不引入图像编解码依赖（原生模块会显著拖慢全局安装，WASM 包体积也不小），
 * 所以超限的图片是「拒绝并说明原因」而不是「缩放后发送」。
 * `ReadOperations.resizeImage` 留了注入点，接入真正的缩放实现即可无缝升级。
 */

import fs from "node:fs/promises";

// 按文件头嗅探而不是看扩展名：模型经常拿到的是 .png 结尾的 jpeg，
// 发错 mimeType 会被 API 直接拒绝。
const SNIFF_BYTES = 4100;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type ImageDimensions = {
  width: number;
  height: number;
};

function startsWith(buffer: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => buffer[offset + i] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
  return startsWith(
    buffer,
    [...text].map((ch) => ch.charCodeAt(0)),
    offset,
  );
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0
  );
}

function isPng(buffer: Uint8Array): boolean {
  // PNG 的第一个 chunk 必须是长度为 13 的 IHDR。
  return (
    buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
  );
}

// APNG（动画 PNG）会带 acTL chunk。多数模型只接受静态图，动图整体拒绝更安全。
function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = readUint32BE(buffer, offset);
    if (startsWithAscii(buffer, offset + 4, "acTL")) return true;
    if (startsWithAscii(buffer, offset + 4, "IDAT")) return false;
    // 4 字节长度 + 4 字节类型 + 数据 + 4 字节 CRC
    offset += 12 + length;
  }
  return false;
}

export function detectSupportedImageMimeType(buffer: Uint8Array): SupportedImageMimeType | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    // 0xFF D8 FF F7 是 JPEG-LS，主流模型不支持。
    return buffer[3] === 0xf7 ? null : "image/jpeg";
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  }
  if (startsWithAscii(buffer, 0, "GIF")) {
    return "image/gif";
  }
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
    return "image/webp";
  }
  return null;
}

export async function detectSupportedImageMimeTypeFromFile(
  filePath: string,
): Promise<SupportedImageMimeType | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

// --- 尺寸解析 ---------------------------------------------------------------
// 只读文件头，不解码像素。拿不到就返回 undefined，调用方据此省略尺寸说明。

function readPngDimensions(buffer: Uint8Array): ImageDimensions | undefined {
  if (buffer.length < 24) return undefined;
  return { width: readUint32BE(buffer, 16), height: readUint32BE(buffer, 20) };
}

function readGifDimensions(buffer: Uint8Array): ImageDimensions | undefined {
  if (buffer.length < 10) return undefined;
  // GIF 是小端序
  return { width: buffer[6] | (buffer[7] << 8), height: buffer[8] | (buffer[9] << 8) };
}

function readJpegDimensions(buffer: Uint8Array): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF0..SOF15，跳过 DHT(C4)/JPGA(C8)/DAC(CC) 这三个非 SOF 标记
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: (buffer[offset + 5] << 8) | buffer[offset + 6], width: (buffer[offset + 7] << 8) | buffer[offset + 8] };
    }
    const segmentLength = (buffer[offset + 2] << 8) | buffer[offset + 3];
    if (segmentLength <= 0) return undefined;
    offset += 2 + segmentLength;
  }
  return undefined;
}

function readWebpDimensions(buffer: Uint8Array): ImageDimensions | undefined {
  if (buffer.length < 30) return undefined;
  if (startsWithAscii(buffer, 12, "VP8X")) {
    // 24 位小端，存的是「宽度 - 1」
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { width, height };
  }
  if (startsWithAscii(buffer, 12, "VP8 ")) {
    return { width: (buffer[26] | (buffer[27] << 8)) & 0x3fff, height: (buffer[28] | (buffer[29] << 8)) & 0x3fff };
  }
  if (startsWithAscii(buffer, 12, "VP8L")) {
    const bits = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return undefined;
}

export function readImageDimensions(buffer: Uint8Array, mimeType: SupportedImageMimeType): ImageDimensions | undefined {
  const dimensions =
    mimeType === "image/png"
      ? readPngDimensions(buffer)
      : mimeType === "image/gif"
        ? readGifDimensions(buffer)
        : mimeType === "image/jpeg"
          ? readJpegDimensions(buffer)
          : readWebpDimensions(buffer);

  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return undefined;
  return dimensions;
}

// --- 体积门槛 ---------------------------------------------------------------

// base64 后 4.5MB，给各家 5MB 上限留出余量。
export const MAX_IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024;

export function base64ByteLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

export function formatDimensionNote(dimensions: ImageDimensions | undefined): string | undefined {
  if (!dimensions) return undefined;
  return `[Image dimensions: ${dimensions.width}x${dimensions.height}]`;
}
