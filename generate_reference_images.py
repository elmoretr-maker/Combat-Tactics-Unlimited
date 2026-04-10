from PIL import Image, ImageDraw
import os

BASE = "reference_images"

categories = {
    "tree": (34, 139, 34),
    "rock": (120, 120, 120),
    "tile": (200, 180, 120),
    "map": (100, 200, 100),
    "projectile": (255, 50, 50),
    "unit": (50, 50, 255),
    "vfx": (255, 150, 0),
}

os.makedirs(BASE, exist_ok=True)

for name, color in categories.items():
    folder = os.path.join(BASE, name)
    os.makedirs(folder, exist_ok=True)

    for i in range(3):
        img = Image.new("RGB", (256, 256), color)
        draw = ImageDraw.Draw(img)
        draw.text((10, 10), name, fill=(255, 255, 255))

        path = os.path.join(folder, f"{name}_{i}.png")
        img.save(path)

print(f"Reference images created in: {BASE}")
