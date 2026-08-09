// Regenerates the PWA icon set from the club's source artwork. sharp isn't a
// project dependency — it's a heavy native binary needed only for this
// occasional task — so install it ad hoc first:
//   npm install --no-save sharp && node scripts/gen-icons.mjs && npm uninstall sharp
import sharp from 'sharp';
import { mkdirSync } from 'fs';

const SRC = 'design/club-icon-source.png';
const OUT = 'public';

async function flattenCorners() {
  const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  // Only the baked-in rounded-corner mask is true black (0,0,0). The navy
  // background and the ball's dark panels both sit well above this — the
  // darkest sampled navy was (0,18,64) — so a tight near-zero threshold
  // replaces just the corners, leaving the artwork untouched.
  const navy = [10, 27, 82];
  for (let i = 0; i < data.length; i += channels) {
    if (data[i] < 8 && data[i + 1] < 8 && data[i + 2] < 8) {
      data[i] = navy[0];
      data[i + 1] = navy[1];
      data[i + 2] = navy[2];
    }
  }
  return sharp(data, { raw: { width, height, channels } });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const full = await flattenCorners();
  const fullBuf = await full.png().toBuffer();

  // Full-bleed square, no baked-in rounding — the OS applies its own.
  await Promise.all([
    sharp(fullBuf).resize(512, 512).png().toFile(`${OUT}/icon-512.png`),
    sharp(fullBuf).resize(192, 192).png().toFile(`${OUT}/icon-192.png`),
    sharp(fullBuf).resize(180, 180).flatten({ background: '#0a1b52' }).png().toFile(`${OUT}/apple-touch-icon.png`),
    sharp(fullBuf).resize(48, 48).png().toFile(`${OUT}/favicon.png`),
  ]);

  // Maskable: shrink the whole (still-seamless-navy) square onto a same-size
  // navy canvas so the artwork sits inside the ~80% safe-zone circle and
  // survives a circular Android crop without losing the horns or arrow tips.
  const maskableArt = await sharp(fullBuf).resize(384, 384).toBuffer();
  await sharp({
    create: { width: 512, height: 512, channels: 3, background: '#0a1b52' },
  })
    .composite([{ input: maskableArt, left: 64, top: 64 }])
    .png()
    .toFile(`${OUT}/icon-512-maskable.png`);

  console.log('done');
}

main();
