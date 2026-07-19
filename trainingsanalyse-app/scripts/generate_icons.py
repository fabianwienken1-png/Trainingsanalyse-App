"""Erzeugt die App-Icons (PWA + iOS Home-Bildschirm) einmalig.
Nutzt Pillow, das lokal bereits verfügbar war - keine npm-Abhängigkeit.
"""
from PIL import Image, ImageDraw
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(OUT_DIR, exist_ok=True)

BLUE = (42, 120, 214, 255)  # --series-1 aus der Palette
WHITE = (255, 255, 255, 255)


def draw_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = size * 0.22
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BLUE)

    # Stilisierte Herzfrequenz-/EKG-Linie als Symbol für Trainingsanalyse
    w = size
    h = size
    mid = h * 0.52
    points = [
        (w * 0.10, mid),
        (w * 0.30, mid),
        (w * 0.40, mid - h * 0.18),
        (w * 0.48, mid + h * 0.26),
        (w * 0.56, mid - h * 0.30),
        (w * 0.64, mid),
        (w * 0.90, mid),
    ]
    stroke = max(2, int(size * 0.045))
    d.line(points, fill=WHITE, width=stroke, joint="curve")
    r = stroke * 0.9
    for p in (points[0], points[-1]):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=WHITE)

    return img


sizes = {
    "icon-192.png": 192,
    "icon-512.png": 512,
    "apple-touch-icon.png": 180,
}

for filename, size in sizes.items():
    icon = draw_icon(size)
    icon.save(os.path.join(OUT_DIR, filename))
    print(f"geschrieben: {filename} ({size}x{size})")
