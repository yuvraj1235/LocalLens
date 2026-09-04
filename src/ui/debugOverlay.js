// debugOverlay.ts – renders the UI graph as a transparent canvas overlay
// It creates (or reuses) a full‑screen <canvas> element and draws bounding‑boxes
// for each UIElement in the received UIGraph.
// Singleton canvas reference
let overlayCanvas = null;
let ctx = null;
/** Create the overlay canvas if it does not exist yet */
function ensureCanvas() {
    if (overlayCanvas)
        return;
    overlayCanvas = document.createElement("canvas");
    overlayCanvas.id = "debugOverlayCanvas";
    // make it cover the whole viewport
    Object.assign(overlayCanvas.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        zIndex: "9999",
    });
    document.body.appendChild(overlayCanvas);
    ctx = overlayCanvas.getContext("2d");
    resizeCanvas();
    // Keep canvas size in sync with window resize
    window.addEventListener("resize", resizeCanvas);
}
function resizeCanvas() {
    if (!overlayCanvas)
        return;
    overlayCanvas.width = window.innerWidth;
    overlayCanvas.height = window.innerHeight;
}
/** Clear any existing drawings */
function clearOverlay() {
    if (ctx) {
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
}
/**
 * Render a single UIElement as a rectangle with its ID label.
 * The bounding box is assumed to be in page coordinates (relative to viewport).
 */
function drawElement(el) {
    if (!ctx || !el.bbox)
        return;
    const { x, y, width, height } = el.bbox;
    // Box style – semi‑transparent teal fill + white stroke
    ctx.strokeStyle = "hsla(180, 70%, 60%, 0.9)";
    ctx.lineWidth = 2;
    ctx.fillStyle = "hsla(180, 70%, 40%, 0.2)";
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    // ID label – small white text below the box
    ctx.fillStyle = "white";
    ctx.font = "12px Inter, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(el.element_id, x + 3, y + 3);
}
/**
 * Public API – render the whole UIGraph.
 */
export function renderDebugOverlay(graph) {
    ensureCanvas();
    clearOverlay();
    for (const el of graph) {
        drawElement(el);
    }
}
/**
 * Hide and remove the overlay – useful when the user disables the toggle.
 */
export function hideDebugOverlay() {
    if (overlayCanvas) {
        overlayCanvas.remove();
        overlayCanvas = null;
        ctx = null;
        window.removeEventListener("resize", resizeCanvas);
    }
}
