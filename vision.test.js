const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const {
  MAX_VISION_IMAGE_BYTES,
  VisionInputError,
  prepareVisionAttachments,
} = require('./vision');

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);

test('returns an empty vision input when a message has no images', async () => {
  const prepared = await prepareVisionAttachments(new Map());
  assert.deepEqual(prepared.images, []);
  assert.equal(prepared.tempDirectory, null);
  await prepared.cleanup();
});

test('downloads a Discord image to tmp, builds an input_image, then cleans up', async () => {
  const attachments = new Map([
    ['123', {
      id: '123',
      name: 'rat.png',
      contentType: 'image/png',
      size: PNG_BYTES.length,
      url: 'https://cdn.discordapp.com/attachments/channel/rat.png',
    }],
  ]);

  const prepared = await prepareVisionAttachments(attachments, {
    fetchImpl: async () => new Response(PNG_BYTES, {
      headers: {
        'content-length': String(PNG_BYTES.length),
        'content-type': 'image/png',
      },
    }),
  });

  assert.equal(prepared.images.length, 1);
  assert.equal(prepared.images[0].attachmentId, '123');
  assert.match(prepared.images[0].input.image_url, /^data:image\/png;base64,/);
  await fs.access(prepared.images[0].filePath);

  const tempDirectory = prepared.tempDirectory;
  await prepared.cleanup();
  await assert.rejects(fs.access(tempDirectory), { code: 'ENOENT' });
});

test('rejects an oversized image before downloading it', async () => {
  const attachments = new Map([
    ['123', {
      id: '123',
      name: 'huge.png',
      contentType: 'image/png',
      size: MAX_VISION_IMAGE_BYTES + 1,
      url: 'https://cdn.discordapp.com/attachments/channel/huge.png',
    }],
  ]);

  await assert.rejects(
    prepareVisionAttachments(attachments),
    error => error instanceof VisionInputError && /under 8 MB/.test(error.message),
  );
});
