"""Generate fictional native, scan and mixed-page acceptance inputs (no customer data)."""
import io
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'converter'))
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw
from pdf_word import render_page

root=Path(sys.argv[1] if len(sys.argv)>1 else '.local/pdf-word/fixtures');root.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
stamp=Image.new('RGB',(300,160),'white');draw=ImageDraw.Draw(stamp);draw.rectangle((5,5,295,155),outline='red',width=5);draw.text((25,65),'SYNTHETIC TEST IMAGE',fill='red')
stamp_bytes=io.BytesIO();stamp.save(stamp_bytes,format='PNG');stamp_bytes.seek(0)
out=io.BytesIO();pdf=canvas.Canvas(out,pagesize=(600,800));pdf.setFont('STSong-Light',16)
for index,line in enumerate(['虚构采购合同 / TEST CONTRACT','甲方：虚构甲公司  乙方：虚构乙公司','合同金额：12345.67 元','日期：2026-11-05']): pdf.drawString(35,750-index*40,line)
pdf.setFont('Helvetica',12)
for y in (480,530,580):pdf.line(35,y,565,y)
for x in (35,300,420,565):pdf.line(x,480,x,580)
for x,y,value in [(45,548,'Item'),(310,548,'Qty'),(430,548,'Unit price'),(45,498,'Service A'),(310,498,'3'),(430,498,'400.25')]:pdf.drawString(x,y,value)
pdf.drawImage(ImageReader(stamp),350,340,width=150,height=80);pdf.showPage();pdf.save()
native=out.getvalue();(root/'native-bilingual-table.pdf').write_bytes(native)
page=render_page(native,1)
import base64
png=base64.b64decode(page['image'])
out=io.BytesIO();pdf=canvas.Canvas(out,pagesize=(600,800));pdf.drawImage(ImageReader(io.BytesIO(png)),0,0,width=600,height=800);pdf.showPage();pdf.save();(root/'scan-bilingual-table.pdf').write_bytes(out.getvalue())
out=io.BytesIO();pdf=canvas.Canvas(out,pagesize=(600,800));pdf.setFont('Helvetica',16);pdf.drawString(35,760,'Mixed native heading / test only');pdf.drawImage(ImageReader(io.BytesIO(png)),0,0,width=540,height=720);pdf.showPage();pdf.save();(root/'mixed.pdf').write_bytes(out.getvalue())
(root/'damaged.pdf').write_bytes(b'%PDF-1.4\ninvalid structure')
out=io.BytesIO();pdf=canvas.Canvas(out,pagesize=(600,800));pdf.setFont('STSong-Light',14)
for index,line in enumerate(['虚构甲公司与虚构乙公司分期服务合同','合同金额：12345.67 元；日期：2026-11-05']):pdf.drawString(35,750-index*40,line)
pdf.setFont('Helvetica',12)
for y in (450,500,550,600):pdf.line(35,y,565,y)
for x in (35,300,565):pdf.line(x,450,x,600)
pdf.setFillColorRGB(1,1,1);pdf.rect(36,499,263,2,fill=1,stroke=0);pdf.setFillColorRGB(0,0,0)
for x,y,value in [(45,570,'Service'),(310,570,'Fee'),(45,515,'Service A'),(310,520,'400.25'),(310,470,'700.50')]:pdf.drawString(x,y,value)
pdf.showPage();pdf.setPageSize((800,600));pdf.setFont('STSong-Light',13)
pdf.drawString(35,550,'第二页左栏：交付后验收。');pdf.drawString(430,550,'第二页右栏：按期支付服务费。')
pdf.setFont('Helvetica',12);pdf.drawString(35,500,'Additional terms: inspect delivery.');pdf.drawString(430,500,'Payment is subject to acceptance.')
pdf.showPage();pdf.save();(root/'multipage-merged-landscape.pdf').write_bytes(out.getvalue())
print('Created fictional native / scanned / mixed PDF fixtures')
