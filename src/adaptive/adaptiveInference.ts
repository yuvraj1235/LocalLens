/**
 * Phase 11 — Adaptive Inference
 *
 * Avoids re-running expensive CV models when nothing meaningfully changed
 * on screen. Cheap checks (DOM mutation count, pixel-diff sampling) run
 * first; only trigger the full pipeline when they indicate real change.
 */

export interface ChangeDetectorState {
  lastImageHash: string | null;
  lastDomMutationCount: number;
}

export function createChangeDetectorState(): ChangeDetectorState {
  return { lastImageHash: null, lastDomMutationCount: 0 };
}

/**
 * Cheap perceptual hash via downsampled average brightness per grid cell.
 * Good enough to detect "did the page visually change" without running CV.
 */
export function cheapImageHash(image: ImageData, gridSize = 8): string {
  const { data, width, height } = image;
  const cellW = Math.floor(width / gridSize);
  const cellH = Math.floor(height / gridSize);
  const buckets: number[] = [];

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      let sum = 0;
      let count = 0;
      for (let y = gy * cellH; y < (gy + 1) * cellH; y += 4) {
        for (let x = gx * cellW; x < (gx + 1) * cellW; x += 4) {
          const idx = (y * width + x) * 4;
          sum += data[idx] + data[idx + 1] + data[idx + 2];
          count += 1;
        }
      }
      buckets.push(count === 0 ? 0 : Math.round(sum / count));
    }
  }

  return buckets.join(",");
}

/**
 * Decides whether the full CV pipeline should run for this frame.
 * domMutationCount should come from a MutationObserver in the extension shell.
 */
export function shouldRunFullPipeline(
  image: ImageData,
  domMutationCount: number,
  state: ChangeDetectorState
): boolean {
  const domChanged = domMutationCount !== state.lastDomMutationCount;
  state.lastDomMutationCount = domMutationCount;

  if (!domChanged && state.lastImageHash !== null) {
    // Even without DOM changes, do a cheap visual check (covers canvas/video)
    const hash = cheapImageHash(image);
    const visuallyChanged = hash !== state.lastImageHash;
    state.lastImageHash = hash;
    return visuallyChanged;
  }

  state.lastImageHash = cheapImageHash(image);
  return true;
}