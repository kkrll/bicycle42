import { S } from "../state.js";
import { refs, textarea } from "./mount.js";
import { kick } from "../render.js";

// ── pasted pictures ─────────────────────────────────────────────────────────────────────────
// A reference to go with the words ("like this"). They are scaled down here, so a full-screen
// screenshot costs the agent no more than the note's own crops, and they are not part of the
// saved draft: a page reload drops them.
const MAX_IMAGES = 4;
const IMAGE_SIDE = 1600;

export function setImages(list) {
  S.images = list;
  if (!refs) return;
  refs.replaceChildren(
    ...list.map((im, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ref";
      b.title = "Remove this picture";
      const img = document.createElement("img");
      img.src = im.uri;
      img.alt = `Picture ${i + 1}`;
      b.append(img);
      b.addEventListener("click", () => {
        setImages(S.images.filter((x) => x !== im));
        textarea.focus({ preventScroll: true });
      });
      return b;
    }),
  );
  refs.hidden = !list.length;
  kick();
}

async function addImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, IMAGE_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; // JPEG has no transparency
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const uri = c.toDataURL("image/jpeg", 0.85);
    if (S.card && S.images.length < MAX_IMAGES) setImages([...S.images, { name: "reference.jpg", uri }]);
  } catch {
    // Not a picture the browser can read: nothing is added.
  }
}

export function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return; // plain text pastes as usual
  e.preventDefault();
  for (const f of files.slice(0, MAX_IMAGES)) void addImage(f);
}
