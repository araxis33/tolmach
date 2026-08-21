# Иконка Толмача: два встречных стрелки — универсальный знак обмена.
# Рисуем в восемь раз крупнее и ужимаем, чтобы края были гладкими.
from PIL import Image, ImageDraw

INK = (27, 27, 31, 255)
CREAM = (245, 243, 239, 255)
ACCENT = (201, 100, 66, 255)
SCALE = 8


def arrow(draw, x_from, x_to, y, thickness, head_len, head_half, color):
    pointing_right = x_to > x_from
    shaft_end = x_to - head_len if pointing_right else x_to + head_len
    draw.line([(x_from, y), (shaft_end, y)], fill=color, width=thickness)
    draw.polygon(
        [
            (x_to, y),
            (shaft_end, y - head_half),
            (shaft_end, y + head_half),
        ],
        fill=color,
    )


def render(size):
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=INK)

    pad = s * 0.21
    thickness = max(1, int(s * 0.085))
    head_len = s * 0.15
    head_half = s * 0.115

    arrow(d, pad, s - pad, s * 0.37, thickness, head_len, head_half, CREAM)
    arrow(d, s - pad, pad, s * 0.63, thickness, head_len, head_half, ACCENT)

    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    path = f"icons/icon{size}.png"
    render(size).save(path)
    print(f"нарисовал {path}")
