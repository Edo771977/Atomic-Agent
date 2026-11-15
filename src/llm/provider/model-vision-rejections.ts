/**
 * Models a service has refused an image for, keyed by provider id and
 * model id. Process-wide on purpose: the provider object is rebuilt on
 * every config write, and a switch away and back must not hand the
 * model a fresh chance to fail the same way. A restart clears it; an
 * explicit `supportsVision` in config outranks it (`model-vision.ts`).
 */
const rejectedImages = new Set<string>();

function rejectionKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

export function markModelCannotSee(providerId: string, modelId: string): void {
  rejectedImages.add(rejectionKey(providerId, modelId));
}

export function modelCannotSee(providerId: string, modelId: string): boolean {
  return rejectedImages.has(rejectionKey(providerId, modelId));
}

/** Test seam: forget every recorded rejection. */
export function resetModelVisionRejections(): void {
  rejectedImages.clear();
}

/**
 * Whether a failed describe request is the service saying this model
 * does not take images, as opposed to a transient or account failure.
 * A describe body differs from a text turn only by its `image_url`
 * parts, so a client-error status whose body talks about images,
 * modalities or content shape — or aimlapi's bare
 * `Validation failed`, which is all it says about an image sent to a
 * text-only model — is read as a verdict on the model. Auth (401/403),
 * throttling (429) and server errors (5xx) never are.
 */
export function isImageRejection(
  status: number | null,
  message: string,
): boolean {
  if (status !== 400 && status !== 404 && status !== 415 && status !== 422) {
    return false;
  }
  return IMAGE_REJECTION_PATTERN.test(message);
}

const IMAGE_REJECTION_PATTERN =
  /image|vision|multimodal|modalit|validation failed|content.{0,40}(array|string)|not support|unsupported/i;

/**
 * Whether a failed describe request is the service refusing an image's
 * size (the Messages API's per-image limit: `image exceeds 5 MB
 * maximum`, or a 413 for the whole body). Checked before
 * `isImageRejection`, whose `image` wording it also matches: one
 * oversized image says nothing about whether the model can see.
 */
export function isImageSizeRejection(
  status: number | null,
  message: string,
): boolean {
  if (status === 413) return true;
  if (status !== 400 && status !== 422) return false;
  return IMAGE_SIZE_REJECTION_PATTERN.test(message);
}

const IMAGE_SIZE_REJECTION_PATTERN =
  /image.{0,80}(exceeds|too large|too big|maximum (size|allowed))|(exceeds|too large).{0,40}image/i;

/**
 * A describe call the service refused because an image was too large.
 * The message says what to change, keeping the service's own words
 * (which name its limit) after it.
 */
export class ImageRejectedAsTooLargeError extends Error {
  constructor(
    readonly providerId: string,
    readonly serviceMessage: string,
  ) {
    super(
      `the image is too large for provider "${providerId}": lower vision.maxImageBytes ` +
        `or crop/downscale the image before describing it (${serviceMessage})`,
    );
    this.name = "ImageRejectedAsTooLargeError";
  }
}
