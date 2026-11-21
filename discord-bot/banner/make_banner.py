"""Builds banner.svg and banner.png (Discord bot banner, 680x240 at 2x). Run: python3 make_banner.py   (needs rsvg-convert)"""
import math, os, subprocess, pathlib

HERE = pathlib.Path(__file__).parent
W, H, PX = 680, 240, 8  # one "pixel" is 8 units, so the art stays blocky at any size

# the Undertow accent (94,129,244) and friends
BG_TOP, BG_BOT = "#0a0e24", "#1b1f52"
WAVES = [  # (colour, base height in px rows from the bottom, amplitude, wavelength, phase)
    ("#2a3a8f", 9.5, 1.5, 26, 0.0),
    ("#3f56c9", 7, 1.5, 19, 1.7),
    ("#5e81f4", 4.6, 1.3, 14, 3.1),
    ("#8fb0ff", 2.4, 1.0, 10, 4.4),
]
cols, rows = W // PX, H // PX
out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
       f'<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{BG_TOP}"/><stop offset="1" stop-color="{BG_BOT}"/></linearGradient></defs>',
       f'<rect width="{W}" height="{H}" fill="url(#g)"/>']

# stars (fixed positions so it's the same every time)
for i in range(46):
    x = (i * 37 + 11) % cols; y = (i * 53 + 5) % (rows - 13)
    if y < 2 or (22 <= x <= 62 and y <= 22): continue  # keep the text area clear
    a = 0.25 + 0.55 * (((i * 29) % 7) / 6)
    out.append(f'<rect x="{x*PX}" y="{y*PX}" width="{PX//2 if i % 3 else PX}" height="{PX//2 if i % 3 else PX}" fill="#cfe0ff" opacity="{a:.2f}"/>')
# a pixel moon
mx, my = 60, 2
for dy, row in enumerate(["..XXXX.", ".XXXX..", "XXXX...", "XXXX...", "XXXX...", ".XXXX..", "..XXXX."]):
    for dx, c in enumerate(row):
        if c == "X": out.append(f'<rect x="{(mx+dx)*PX}" y="{(my+dy)*PX}" width="{PX}" height="{PX}" fill="#fff4cf" opacity="0.92"/>')

# stepped waves, back to front
for colr, base, amp, wl, ph in WAVES:
    for cx in range(cols):
        top = base + amp * math.sin(cx / wl * 2 * math.pi + ph) + 0.45 * math.sin(cx / (wl * 0.5) + ph * 2)
        h = max(1, round(top))
        out.append(f'<rect x="{cx*PX}" y="{(rows-h)*PX}" width="{PX}" height="{h*PX}" fill="{colr}"/>')
# a lighter crest line on the front wave
cx_prev = None
for cx in range(cols):
    top = WAVES[-1][1] + WAVES[-1][2] * math.sin(cx / WAVES[-1][3] * 2 * math.pi + WAVES[-1][4]) + 0.45 * math.sin(cx / (WAVES[-1][3] * 0.5) + WAVES[-1][4] * 2)
    h = max(1, round(top))
    out.append(f'<rect x="{cx*PX}" y="{(rows-h)*PX}" width="{PX}" height="{PX//2}" fill="#d6e4ff" opacity="0.85"/>')

# equaliser bars on the right, like a level meter
bars = [4, 7, 5, 9, 6, 11, 8, 5, 9, 4]
for i, bh in enumerate(bars):
    x = 575 + i * 10
    for r in range(bh):
        y = 132 - r * 8
        colr = "#7cf0c9" if r < bh * 0.6 else "#ffd66b" if r < bh * 0.85 else "#ff7a8a"
        out.append(f'<rect x="{x}" y="{y}" width="8" height="6" fill="{colr}" opacity="{0.95 - 0.04 * (i % 3)}"/>')

FONT = "Monocraft"
LIG = 'style="font-variant-ligatures:none;font-feature-settings:\'liga\' 0,\'calt\' 0"'
# title and subtitle (kept clear of the avatar that sits at the bottom left of a Discord profile)
out.append(f'<text x="206" y="104" font-family="{FONT}" font-weight="700" font-size="52" fill="#06081a" opacity="0.55">GUMI</text>')
out.append(f'<text x="202" y="100" font-family="{FONT}" font-weight="700" font-size="52" fill="#ffffff">GUMI</text>')
out.append(f'<text x="204" y="132" font-family="{FONT}" font-size="17" fill="#a9c1ff" {LIG}>hifi-api via Undertow</text>')
out.append(f'<rect x="204" y="146" width="148" height="26" fill="#0a0e24" opacity="0.7"/>')
out.append(f'<text x="212" y="165" font-family="{FONT}" font-size="14" fill="#7cf0c9" {LIG}>g+play &lt;song&gt;</text>')
out.append("</svg>")
(HERE / "banner.svg").write_text("\n".join(out))

conf = HERE / "fonts.conf"
conf.write_text(f'<?xml version="1.0"?><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>{HERE / "font/ex/Monocraft-otf"}</dir><dir>{HERE / "font/ex/Monocraft-otf/weights"}</dir></fontconfig>')
subprocess.run(["rsvg-convert", "-z", "2", "-o", str(HERE / "banner.png"), str(HERE / "banner.svg")], check=True, env={**os.environ, "FONTCONFIG_FILE": str(conf)})
print("ok")
