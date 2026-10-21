"""One-off asset prep. Reads brand/, writes src/assets/.
Resizes the transparent mark with premultiplied alpha (its transparent
regions are pure black, which fringes dark under naive bilinear/lanczos).
Traces favicon.svg from the real pixel grid of the opaque icon."""
import numpy as np
from PIL import Image
from skimage import measure

B = "brand/"
OUT = "src/assets/"
ICON = B + "LOGO ACCUMOUT PNG.png"       # RGBA, fully opaque (colortype 6, alpha all 255)
MARK = B + "LOGO ACCUMOUT PNG...png"     # RGBA, transparent bg, black under alpha 0


def premult_resize(img, size):
    a = np.asarray(img.convert("RGBA")).astype(np.float64) / 255.0
    pm = np.dstack([a[..., :3] * a[..., 3:4], a[..., 3:4]])
    chans = [Image.fromarray(pm[..., i].astype(np.float32), mode="F").resize(size, Image.LANCZOS) for i in range(4)]
    r = np.dstack([np.asarray(c) for c in chans])
    alpha = np.clip(r[..., 3:4], 0, 1)
    rgb = np.where(alpha > 1e-6, r[..., :3] / np.maximum(alpha, 1e-6), 0)
    out = np.dstack([np.clip(rgb, 0, 1), alpha])
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")


mark = Image.open(MARK)
alpha = np.asarray(mark)[..., 3]
ys, xs = np.where(alpha > 8)
x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
pad = 40
box = (max(0, x0 - pad), max(0, y0 - pad), min(2000, x1 + pad), min(2000, y1 + pad))
crop = mark.crop(box)
print("mark bbox", (x0, y0, x1, y1), "crop", box)
for w in (1000, 500, 250):
    h = round(crop.height * w / crop.width)
    premult_resize(crop, (w, h)).save(OUT + f"mark-{w}.png", optimize=True)

icon = Image.open(ICON).convert("RGB")
for s in (512, 192, 180, 96):
    icon.resize((s, s), Image.LANCZOS).save(OUT + f"icon-{s}.png", optimize=True)

# favicon trace
a = np.asarray(icon).astype(int)
r, g, b = a[..., 0], a[..., 1], a[..., 2]
white = (r > 200) & (g > 200) & (b > 200)
shard = (r < 90) & (g > 108) & (b > 200)
ys, xs = np.where(white | shard)
bx0, bx1, by0, by1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
print("icon mark bbox", bx0, by0, bx1, by1)
span = max(bx1 - bx0, by1 - by0)
scale = 20.0 / span
cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2


def path_for(mask):
    m = np.pad(mask.astype(float), 1)
    cs = measure.find_contours(m, 0.5)
    c = max(cs, key=len) - 1
    c = measure.approximate_polygon(c, 1.6)
    pts = [(16 + (p[1] - cx) * scale, 16 + (p[0] - cy) * scale) for p in c[:-1]]
    return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + "Z"


svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
    '<rect width="32" height="32" rx="7" fill="#0356f0"/>'
    f'<path d="{path_for(white)}" fill="#fefefe"/>'
    f'<path d="{path_for(shard)}" fill="#0284f1"/>'
    "</svg>\n"
)
open(OUT + "favicon.svg", "w").write(svg)
print("favicon bytes", len(svg))
