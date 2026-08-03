import { availableParallelism, totalmem } from "node:os";
import sharp from "sharp";

export const IMAGE_VARIANTS = Object.freeze({
  thumbnail: Object.freeze({
    width: 1024,
    quality: 82,
    suffix: "thumbnail",
  }),
  preview: Object.freeze({
    width: 2048,
    quality: 86,
    suffix: "preview",
  }),
});

const DEFAULT_MAX_PIXELS = 40_000_000;
const detectedCpus = Math.max(1, availableParallelism());
const detectedMemory = totalmem();
const smallServer = detectedCpus <= 2 || detectedMemory <= 3 * 1024 ** 3;
const DEFAULT_JOB_CONCURRENCY = smallServer ? 1 : 2;
const DEFAULT_SHARP_THREADS = Math.max(1, Math.min(smallServer ? 2 : 4, detectedCpus));
const DEFAULT_SHARP_CACHE_MB = smallServer ? 32 : 128;
const DEFAULT_SHARP_CACHE_ITEMS = smallServer ? 32 : 100;

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

const maxInputPixels = boundedInteger(
  process.env.IMAGE_MAX_PIXELS,
  DEFAULT_MAX_PIXELS,
  1_000_000,
  100_000_000,
);
const maxConcurrentJobs = boundedInteger(
  process.env.IMAGE_PROCESS_CONCURRENCY,
  DEFAULT_JOB_CONCURRENCY,
  1,
  8,
);

const sharpThreads = boundedInteger(
  process.env.IMAGE_PROCESS_THREADS,
  DEFAULT_SHARP_THREADS,
  1,
  16,
);
const sharpCacheMb = boundedInteger(
  process.env.IMAGE_PROCESS_CACHE_MB,
  DEFAULT_SHARP_CACHE_MB,
  0,
  512,
);

sharp.concurrency(sharpThreads);
sharp.cache({ memory: sharpCacheMb, files: 0, items: DEFAULT_SHARP_CACHE_ITEMS });

export const IMAGE_PROCESSING = Object.freeze({
  detectedCpus,
  detectedMemory,
  profile: smallServer ? "small" : "standard",
  maxConcurrentJobs,
  sharpThreads,
  sharpCacheMb,
});

let activeJobs = 0;
const waitingJobs = [];

async function withImageJobSlot(task) {
  if (activeJobs >= maxConcurrentJobs) {
    await new Promise((resolve) => waitingJobs.push(resolve));
  }
  activeJobs += 1;
  try {
    return await task();
  } finally {
    activeJobs -= 1;
    waitingJobs.shift()?.();
  }
}

export function variantObjectKey(originalKey, variant) {
  const settings = IMAGE_VARIANTS[variant];
  if (!settings) throw new Error(`Unsupported image variant: ${variant}`);
  const key = String(originalKey || "");
  const separator = Math.max(key.lastIndexOf("/"), key.lastIndexOf("\\"));
  const extension = key.lastIndexOf(".");
  const base = extension > separator ? key.slice(0, extension) : key;
  return `${base}.${settings.suffix}.webp`;
}

function webpPipeline(input, settings) {
  return sharp(input, {
    failOn: "warning",
    limitInputPixels: maxInputPixels,
  })
    .autoOrient()
    .resize({
      width: settings.width,
      withoutEnlargement: true,
      fit: "inside",
      kernel: sharp.kernel.lanczos3,
    })
    .webp({
      quality: settings.quality,
      effort: 4,
      smartSubsample: true,
    })
    .toBuffer({ resolveWithObject: true });
}

export async function createImageVariants(value) {
  const input = Buffer.from(value);
  return withImageJobSlot(async () => {
    const metadata = await sharp(input, {
      failOn: "warning",
      limitInputPixels: maxInputPixels,
    }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("无法读取图片尺寸");
    }

    // Generate the two outputs sequentially. This keeps one image job within
    // its configured libvips thread budget instead of running two pipelines
    // per upload and oversubscribing small VPS instances.
    const thumbnail = await webpPipeline(input, IMAGE_VARIANTS.thumbnail);
    const preview = await webpPipeline(input, IMAGE_VARIANTS.preview);

    return {
      source: {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format || "unknown",
      },
      thumbnail: {
        buffer: thumbnail.data,
        width: thumbnail.info.width,
        height: thumbnail.info.height,
        size: thumbnail.info.size,
      },
      preview: {
        buffer: preview.data,
        width: preview.info.width,
        height: preview.info.height,
        size: preview.info.size,
      },
    };
  });
}
