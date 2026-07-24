const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MAX_VISION_IMAGES = 4;
const MAX_VISION_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VISION_TOTAL_BYTES = 20 * 1024 * 1024;
const VISION_DOWNLOAD_TIMEOUT_MS = 15_000;

const MIME_TYPES = new Map([
  ['image/gif', { extension: 'gif', signature: isGif }],
  ['image/jpeg', { extension: 'jpg', signature: isJpeg }],
  ['image/png', { extension: 'png', signature: isPng }],
  ['image/webp', { extension: 'webp', signature: isWebp }],
]);

const EXTENSION_MIME_TYPES = new Map([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

class VisionInputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'VisionInputError';
  }
}

function isJpeg(buffer) {
  return buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;
}

function isPng(buffer) {
  return buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isGif(buffer) {
  if (buffer.length < 6) return false;
  const header = buffer.subarray(0, 6).toString('ascii');
  return header === 'GIF87a' || header === 'GIF89a';
}

function isWebp(buffer) {
  return buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

function normalizeMimeType(contentType) {
  return (contentType || '').split(';', 1)[0].trim().toLowerCase();
}

function mimeTypeFromAttachment(attachment) {
  const declared = normalizeMimeType(attachment.contentType);
  if (declared.startsWith('image/')) return declared;

  const nameMimeType = EXTENSION_MIME_TYPES.get(
    path.extname(attachment.name || '').toLowerCase(),
  );
  if (nameMimeType) return nameMimeType;

  try {
    return EXTENSION_MIME_TYPES.get(path.extname(new URL(attachment.url).pathname).toLowerCase()) || '';
  } catch (_) {
    return '';
  }
}

function looksLikeImage(attachment) {
  const mimeType = mimeTypeFromAttachment(attachment);
  return mimeType.startsWith('image/') || EXTENSION_MIME_TYPES.has(
    path.extname(attachment.name || '').toLowerCase(),
  );
}

function isDiscordCdnUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (
      hostname === 'discord.com' ||
      hostname.endsWith('.discord.com') ||
      hostname === 'discordapp.com' ||
      hostname.endsWith('.discordapp.com') ||
      hostname === 'discordapp.net' ||
      hostname.endsWith('.discordapp.net')
    );
  } catch (_) {
    return false;
  }
}

function attachmentList(attachments) {
  if (!attachments) return [];
  if (typeof attachments.values === 'function') return [...attachments.values()];
  return [...attachments];
}

async function downloadImage(attachment, destination, fetchImpl) {
  if (!isDiscordCdnUrl(attachment.url)) {
    throw new VisionInputError('that image URL is not from Discord, so i left it outside the walls.');
  }

  let response;
  try {
    response = await fetchImpl(attachment.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(VISION_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new VisionInputError('i couldn’t download that image from Discord. try attaching it again.', {
      cause,
    });
  }

  if (!response.ok || !response.body) {
    throw new VisionInputError('Discord wouldn’t give me that image. try attaching it again.');
  }

  if (response.url && !isDiscordCdnUrl(response.url)) {
    throw new VisionInputError('that image download wandered off Discord, so i stopped it.');
  }

  const declaredMimeType = mimeTypeFromAttachment(attachment);
  const responseMimeType = normalizeMimeType(response.headers.get('content-type'));
  const mimeType = MIME_TYPES.has(responseMimeType) ? responseMimeType : declaredMimeType;
  const typeInfo = MIME_TYPES.get(mimeType);

  if (!typeInfo) {
    throw new VisionInputError('i can only inspect PNG, JPEG, WEBP, or GIF images right now.');
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_VISION_IMAGE_BYTES) {
    throw new VisionInputError('that image is too chunky. keep each one under 8 MB.');
  }

  const handle = await fs.open(destination, 'wx');
  let bytesWritten = 0;

  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytesWritten += buffer.length;
      if (bytesWritten > MAX_VISION_IMAGE_BYTES) {
        throw new VisionInputError('that image is too chunky. keep each one under 8 MB.');
      }
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }

  const data = await fs.readFile(destination);
  if (!typeInfo.signature(data)) {
    throw new VisionInputError('that attachment says it is an image, but the file does not look like one.');
  }

  return { bytes: bytesWritten, data, extension: typeInfo.extension, mimeType };
}

async function prepareVisionAttachments(attachments, { fetchImpl = fetch } = {}) {
  const candidates = attachmentList(attachments).filter(looksLikeImage);

  if (candidates.length === 0) {
    return {
      images: [],
      tempDirectory: null,
      cleanup: async () => {},
    };
  }

  if (candidates.length > MAX_VISION_IMAGES) {
    throw new VisionInputError(`my tiny rat eyes can handle up to ${MAX_VISION_IMAGES} images at once.`);
  }

  for (const attachment of candidates) {
    const mimeType = mimeTypeFromAttachment(attachment);
    if (!MIME_TYPES.has(mimeType)) {
      throw new VisionInputError('i can only inspect PNG, JPEG, WEBP, or GIF images right now.');
    }
    if (attachment.size > MAX_VISION_IMAGE_BYTES) {
      throw new VisionInputError('that image is too chunky. keep each one under 8 MB.');
    }
  }

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rat-bot-vision-'));

  try {
    const images = [];
    let totalBytes = 0;

    for (const [index, attachment] of candidates.entries()) {
      const provisionalPath = path.join(tempDirectory, `${index}.download`);
      const downloaded = await downloadImage(attachment, provisionalPath, fetchImpl);
      totalBytes += downloaded.bytes;

      if (totalBytes > MAX_VISION_TOTAL_BYTES) {
        throw new VisionInputError('those images are too chunky together. keep the batch under 20 MB.');
      }

      const finalPath = path.join(tempDirectory, `${index}.${downloaded.extension}`);
      await fs.rename(provisionalPath, finalPath);

      images.push({
        attachmentId: attachment.id,
        filePath: finalPath,
        input: {
          type: 'input_image',
          image_url: `data:${downloaded.mimeType};base64,${downloaded.data.toString('base64')}`,
          detail: 'auto',
        },
      });
    }

    return {
      images,
      tempDirectory,
      cleanup: () => fs.rm(tempDirectory, { force: true, recursive: true }),
    };
  } catch (error) {
    await fs.rm(tempDirectory, { force: true, recursive: true });
    if (error instanceof VisionInputError) throw error;
    throw new VisionInputError('i couldn’t prepare that image for my tiny rat eyes. try it again.', {
      cause: error,
    });
  }
}

module.exports = {
  MAX_VISION_IMAGE_BYTES,
  MAX_VISION_IMAGES,
  VisionInputError,
  prepareVisionAttachments,
};
