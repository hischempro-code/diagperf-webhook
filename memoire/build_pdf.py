#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Convertit Soutenance_prep.md -> Soutenance_prep.pdf (markdown -> HTML -> PDF)."""
import re, os, sys, markdown
from xhtml2pdf import pisa
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping

SRC = sys.argv[1] if len(sys.argv) > 1 else "Soutenance_prep.md"
OUT = SRC[:-3] + ".pdf" if SRC.endswith(".md") else SRC + ".pdf"

md = open(SRC, encoding="utf-8").read()
# retirer les emoji (non rendus par le moteur PDF) ; on garde flèches, guillemets, accents
md = re.sub(r"[\U0001F000-\U0001FAFF☀-➿⬀-⯿︀-️‍]", "", md)
body = markdown.markdown(md, extensions=["tables", "fenced_code", "sane_lists"])

# police : Calibri si présente, sinon Arial — enregistrée directement dans reportlab
font = "C:/Windows/Fonts/calibri.ttf"
fb = "C:/Windows/Fonts/calibrib.ttf"
fi = "C:/Windows/Fonts/calibrii.ttf"
if not os.path.exists(font):
    font, fb, fi = "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/ariali.ttf"
pdfmetrics.registerFont(TTFont("Cal", font))
pdfmetrics.registerFont(TTFont("Cal-b", fb))
pdfmetrics.registerFont(TTFont("Cal-i", fi))
addMapping("Cal", 0, 0, "Cal"); addMapping("Cal", 1, 0, "Cal-b")
addMapping("Cal", 0, 1, "Cal-i"); addMapping("Cal", 1, 1, "Cal-b")

css = f"""
@page {{ size:a4 portrait; margin:1.5cm; }}
body {{ font-family:"Cal"; font-size:10pt; color:#2c2c2a; line-height:1.35; }}
h1 {{ color:#1F2A44; font-size:18pt; border-bottom:2px solid #1D9E75; padding-bottom:3px; }}
h2 {{ color:#1F2A44; font-size:13.5pt; margin-top:14pt; }}
h3 {{ color:#1D9E75; font-size:11.5pt; margin-top:9pt; }}
strong {{ color:#1F2A44; }}
em {{ color:#444444; }}
blockquote {{ color:#555555; font-style:italic; border-left:3px solid #1D9E75; padding-left:8px; margin-left:0; }}
table {{ width:100%; border:0.5px solid #cccccc; }}
th {{ background-color:#1F2A44; color:#ffffff; font-size:8.5pt; padding:4px; }}
td {{ border:0.5px solid #cccccc; font-size:8.5pt; padding:4px; vertical-align:top; }}
hr {{ border:0; border-top:0.5px solid #cccccc; margin:8pt 0; }}
li {{ margin-bottom:2pt; }}
"""

html = f"<html><head><meta charset='utf-8'><style>{css}</style></head><body>{body}</body></html>"
with open(OUT, "wb") as f:
    res = pisa.CreatePDF(html, dest=f, encoding="utf-8")
print("PDF généré." if not res.err else f"erreurs: {res.err}")
