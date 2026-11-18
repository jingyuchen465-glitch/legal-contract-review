"""Bounded local PDF rendering and editable OOXML construction. No model credentials here."""
import base64
import io
import json
import math
import tempfile
import zipfile
from contextlib import closing
from pathlib import Path

MAX_BYTES = 50 * 1024 * 1024
MAX_PAGES = 100
MAX_PIXELS = 16000000


def dependencies():
    import pypdfium2 as pdfium
    from docx import Document
    from PIL import Image
    return pdfium, Document, Image


def open_pdf(data):
    pdfium, _, _ = dependencies()
    try: return pdfium.PdfDocument(data)
    except pdfium.PdfiumError as exc:
        raise ValueError('ENCRYPTED_FILE' if getattr(exc, 'err_code', None) == pdfium.raw.FPDF_ERR_PASSWORD else 'INVALID_PDF') from None


def page_image(page):
    width, height = page.get_size()
    scale = min(200 / 72, math.sqrt(MAX_PIXELS / max(width * height, 1)))
    bitmap = page.render(scale=scale)
    try:
        return bitmap.to_pil().copy()
    finally:
        bitmap.close()


def render_page(data, number):
    with closing(open_pdf(data)) as pdf:
        if not 0 < len(pdf) <= MAX_PAGES:
            raise ValueError('PDF_PAGE_LIMIT')
        if not 1 <= number <= len(pdf):
            raise ValueError('PDF_PAGE_INVALID')
        with closing(pdf[number - 1]) as page:
            width, height = page.get_size()
            items, images, rules = [], [], []
            from pypdfium2 import raw
            with closing(page.get_textpage()) as textpage:
                for index in range(textpage.count_rects()):
                    left, bottom, right, top = textpage.get_rect(index)
                    text = textpage.get_text_bounded(left, bottom, right, top).strip()
                    if text:
                        char_index = textpage.get_index(left + min(2, (right-left)/2), (top+bottom)/2, 5, 5)
                        size = raw.FPDFText_GetFontSize(textpage, char_index) if char_index is not None and char_index >= 0 else max(5, top-bottom)
                        items.append({'id': f'n{len(items) + 1}', 'text': text,
                                      'fontSize': float(size),
                                      'bbox': [left / width * 1000, (height - top) / height * 1000,
                                               (right - left) / width * 1000, (top - bottom) / height * 1000]})
            for obj in page.get_objects():
                if obj.type == raw.FPDF_PAGEOBJ_IMAGE:
                    left, bottom, right, top = obj.get_pos()
                    images.append([left / width * 1000, (height - top) / height * 1000,
                                   (right - left) / width * 1000, (top - bottom) / height * 1000])
                elif obj.type == raw.FPDF_PAGEOBJ_PATH:
                    left, bottom, right, top = obj.get_pos()
                    if right-left < 2 or top-bottom < 2:
                        rules.append([left/width*1000,(height-top)/height*1000,(right-left)/width*1000,(top-bottom)/height*1000])
            image = page_image(page)
            try:
                output = io.BytesIO(); image.save(output, format='PNG')
                return {'pageCount': len(pdf), 'width': width, 'height': height,
                        'nativeItems': items, 'imageRegions': images,
                        'rules': rules, 'imageWidth': image.width, 'imageHeight': image.height,
                        'image': base64.b64encode(output.getvalue()).decode('ascii')}
            finally:
                image.close()


def content_text(pages):
    parts = []
    for page in pages:
        for block in page['blocks']:
            if block['kind'] == 'paragraph':
                parts.append(block['text'])
            elif block['kind'] == 'table':
                parts.extend(cell['text'] for cell in block['cells'])
    return parts


def create_word(data, pages):
    _, Document, _ = dependencies()
    from docx.shared import Pt
    from docx.enum.section import WD_SECTION_START
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_ROW_HEIGHT_RULE, WD_CELL_VERTICAL_ALIGNMENT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    document = Document()
    style = document.styles['Normal']
    style.font.name = 'Noto Serif CJK SC'; style.font.size = Pt(10.5)
    style.element.rPr.rFonts.set(qn('w:eastAsia'), 'Noto Serif CJK SC')
    style.paragraph_format.space_after = Pt(0)
    issues = []
    with closing(open_pdf(data)) as pdf:
        if len(pdf) != len(pages) or len(pdf) > MAX_PAGES:
            raise ValueError('PDF_PAGE_MISMATCH')
        for index, layout in enumerate(pages):
            section = document.sections[0] if index == 0 else document.add_section(WD_SECTION_START.NEW_PAGE)
            width, height = layout['width'], layout['height']
            section.page_width, section.page_height = Pt(width), Pt(height)
            section.top_margin = section.bottom_margin = Pt(18)
            section.left_margin = section.right_margin = Pt(18)
            section.header_distance = section.footer_distance = Pt(0)
            cols = section._sectPr.find(qn('w:cols'))
            if cols is not None:
                cols.set(qn('w:num'), '1')
            previous_bottom = 18
            # The model establishes reading order; positions determine spacing and indentation.
            with closing(pdf[index]) as source:
                bitmap = None
                try:
                    for block in layout['blocks']:
                        x, y, w, h = block['bbox']
                        column_origin = 18
                        positioned = layout.get('columns', 1) == 2
                        gap = 0 if positioned else max(0, min(height - 36, y * height / 1000 - previous_bottom))
                        if block['kind'] == 'paragraph':
                            p = document.add_paragraph()
                            p.paragraph_format.space_before = Pt(gap)
                            p.paragraph_format.left_indent = Pt(max(0, x * width / 1000 - column_origin))
                            if positioned:
                                # Editable native Word frames avoid converter-dependent column
                                # break line height while keeping source reading order in XML.
                                p.paragraph_format.left_indent = Pt(0)
                                frame = OxmlElement('w:framePr')
                                right = width - 18 if x >= 500 or w > 500 else (width - 36) / 2
                                frame_width = max(24, right - x * width / 1000)
                                for key, value in {'x':str(int(x * width / 1000 * 20)), 'y':str(int(y * height / 1000 * 20)),
                                                   'w':str(int(frame_width * 20)), 'hAnchor':'page', 'vAnchor':'page', 'wrap':'none'}.items():
                                    frame.set(qn('w:' + key), value)
                                p._p.get_or_add_pPr().append(frame)
                            # PDF glyph bounds are tight ink bounds, not Word text-box widths.
                            # Allow normal single-column flow so font substitution cannot split dates/names.
                            p.paragraph_format.right_indent = Pt(0)
                            p.paragraph_format.line_spacing = Pt(block.get('fontSize', 10.5) * 1.05)
                            p.paragraph_format.keep_together = True
                            p.alignment = {'left': WD_ALIGN_PARAGRAPH.LEFT, 'center': WD_ALIGN_PARAGRAPH.CENTER,
                                           'right': WD_ALIGN_PARAGRAPH.RIGHT, 'justify': WD_ALIGN_PARAGRAPH.JUSTIFY}.get(block.get('align'), WD_ALIGN_PARAGRAPH.LEFT)
                            run = p.add_run(block['text']); run.bold = block.get('bold', False)
                            run.font.size = Pt(block.get('fontSize', 10.5))
                        elif block['kind'] == 'table':
                            spacer = document.add_paragraph()
                            spacer.paragraph_format.space_before = Pt(gap)
                            spacer.paragraph_format.space_after = Pt(0)
                            spacer.paragraph_format.line_spacing = Pt(1)
                            table = document.add_table(rows=block['rows'], cols=block['columns'])
                            table.style = 'Table Grid'; table.autofit = False
                            if positioned:
                                placement = OxmlElement('w:tblpPr')
                                for key, value in {'horzAnchor':'page','vertAnchor':'page',
                                                   'tblpX':str(int(x * width / 1000 * 20)),
                                                   'tblpY':str(int(y * height / 1000 * 20))}.items():
                                    placement.set(qn('w:' + key), value)
                                table._tbl.tblPr.append(placement)
                            indent = OxmlElement('w:tblInd'); indent.set(qn('w:w'), str(int(max(0, x * width / 1000 - 18) * 20)))
                            indent.set(qn('w:type'), 'dxa'); table._tbl.tblPr.append(indent)
                            widths = block.get('columnWidths') or [1000/block['columns']]*block['columns']
                            heights = block.get('rowHeights') or [1000/block['rows']]*block['rows']
                            for col_index,col in enumerate(table.columns): col.width = Pt(w * width / 1000 * widths[col_index]/sum(widths))
                            for row_index,row in enumerate(table.rows):
                                row.height = Pt(h * height / 1000 * heights[row_index]/sum(heights)); row.height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
                                for col_index,cell in enumerate(row.cells): cell.width = table.columns[col_index].width
                            for cell in block['cells']:
                                target = table.cell(cell['row'], cell['column'])
                                if cell.get('rowSpan', 1) > 1 or cell.get('colSpan', 1) > 1:
                                    target = target.merge(table.cell(cell['row'] + cell.get('rowSpan', 1) - 1,
                                                                    cell['column'] + cell.get('colSpan', 1) - 1))
                                target.text = cell['text']
                                target.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                                for paragraph in target.paragraphs:
                                    for run in paragraph.runs:
                                        run.font.size = Pt(cell.get('fontSize',10.5)); run.font.name = 'Liberation Sans'
                        else:
                            bitmap = bitmap or page_image(source)
                            box = (max(0, int(x / 1000 * bitmap.width)), max(0, int(y / 1000 * bitmap.height)),
                                   min(bitmap.width, int((x + w) / 1000 * bitmap.width)),
                                   min(bitmap.height, int((y + h) / 1000 * bitmap.height)))
                            crop = bitmap.crop(box)
                            image_data = io.BytesIO(); crop.save(image_data, format='PNG'); crop.close(); image_data.seek(0)
                            p = document.add_paragraph()
                            picture = p.add_run().add_picture(image_data, width=Pt(min(width - 36, w * width / 1000)))
                            # Absolute page anchors retain overlapping stamps/signatures without
                            # moving the following body text down as an inline image would.
                            inline = picture._inline
                            anchor = OxmlElement('wp:anchor')
                            for key, value in {'distT':'0','distB':'0','distL':'0','distR':'0','simplePos':'0','relativeHeight':'1','behindDoc':'0','locked':'0','layoutInCell':'1','allowOverlap':'1'}.items():
                                anchor.set(key, value)
                            simple = OxmlElement('wp:simplePos'); simple.set('x','0'); simple.set('y','0'); anchor.append(simple)
                            for tag, value in [('H', x * width / 1000), ('V', y * height / 1000)]:
                                pos = OxmlElement('wp:position' + tag); pos.set('relativeFrom','page')
                                offset = OxmlElement('wp:posOffset'); offset.text = str(int(value * 12700)); pos.append(offset); anchor.append(pos)
                            anchor.append(inline.find(qn('wp:extent')))
                            anchor.append(OxmlElement('wp:wrapNone'))
                            for tag in ['wp:docPr','wp:cNvGraphicFramePr','a:graphic']:
                                child = inline.find(qn(tag))
                                if child is not None: anchor.append(child)
                            inline.getparent().replace(inline, anchor)
                            issues.append({'page': index + 1, 'reason': '图像区域保留为原图，不能直接编辑；请核对位置及内容。'})
                        if block['kind'] != 'image': previous_bottom = (y + h) * height / 1000
                finally:
                    if bitmap: bitmap.close()
    output = io.BytesIO(); document.save(output)
    # Check actual paragraph/cell XML order, including nested tables, before returning an artifact.
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(io.BytesIO(output.getvalue())) as package:
        root = ET.fromstring(package.read('word/document.xml'))
        written = ''.join(node.text or '' for node in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'))
    normalize = lambda value: ''.join(value.split())
    expected = normalize(''.join(content_text(pages)))
    if normalize(written) != expected:
        raise ValueError('WORD_CONTENT_MISMATCH')
    if not expected:
        raise ValueError('WORD_NOT_EDITABLE')
    return output.getvalue(), issues


def assemble(data, pages, binary, export):
    docx, issues = create_word(data, pages)
    with tempfile.TemporaryDirectory(prefix='pdf-word-') as directory:
        root = Path(directory); source = root / 'document.docx'; source.write_bytes(docx)
        preview = export(binary, source, 'pdf:writer_pdf_Export', root / 'preview', root / 'profile').read_bytes()
        with closing(open_pdf(preview)) as result:
            page_count = len(result)
            if page_count != len(pages):
                issues.append({'page': None, 'reason': f'分页发生变化：原件 {len(pages)} 页，Word 排版 {page_count} 页。'})
        # Visual fidelity is deliberately never inferred from a matching page count.
        issues.append({'page': None, 'reason': '请对照原 PDF 核验字体、表格、遮挡和分页，关键字段须人工确认。'})
        report = {'editable': True, 'contentRoundTrip': True, 'sourcePages': len(pages),
                  'renderedPages': page_count, 'visualVerified': False, 'issues': issues}
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as package:
            package.writestr('document.docx', docx); package.writestr('preview.pdf', preview)
            package.writestr('quality.json', json.dumps(report, ensure_ascii=False))
        return output.getvalue()


def mount_pdf_routes(app, semaphore, error_type, binary, export):
    import asyncio
    import hmac
    import os
    from fastapi import Request, Header
    from fastapi.responses import Response

    async def read(request, auth, limit):
        token = os.environ.get('CONVERTER_TOKEN', '')
        if len(token) < 32 or not hmac.compare_digest(auth, 'Bearer ' + token):
            raise error_type('CONVERTER_AUTH', '转换服务鉴权失败', 401)
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > limit: raise error_type('FILE_TOO_LARGE', '文件超过转换大小限制', 413)
        return bytes(data)

    def error(exc):
        code = str(exc)
        if code not in {'PDF_PAGE_LIMIT', 'PDF_PAGE_INVALID', 'PDF_PAGE_MISMATCH', 'WORD_CONTENT_MISMATCH', 'WORD_NOT_EDITABLE', 'ENCRYPTED_FILE', 'INVALID_PDF'}:
            code = 'ENCRYPTED_FILE' if 'password' in code.lower() else 'PDF_RENDER_FAILED'
        return error_type(code, {'PDF_PAGE_LIMIT': 'PDF 转换最多支持 100 页，请拆分文件',
                                'WORD_CONTENT_MISMATCH': 'Word 写入前后内容不一致，未发布转换结果',
                                'WORD_NOT_EDITABLE': '没有生成可编辑正文，未将图片稿作为成功结果',
                                'INVALID_PDF': 'PDF 结构损坏或无法打开，请补充原始文件',
                                'ENCRYPTED_FILE': 'PDF 已加密，请补充可打开的文件'}.get(code, 'PDF 渲染或排版失败，请核对源文件'), 422)

    @app.get('/pdf/health')
    async def pdf_health():
        try:
            pdfium, Document, _ = dependencies()
            probe = pdfium.PdfDocument.new(); page = probe.new_page(30, 30)
            image = page_image(page); image.close(); page.close(); probe.close()
            Document().save(io.BytesIO())
            return {'ok': bool(binary()), 'engine': 'pdfium-python-docx', 'maxPages': MAX_PAGES}
        except Exception:
            return Response(status_code=503)

    @app.post('/pdf/page')
    async def pdf_page(request: Request, authorization: str = Header(default=''), x_page: int = Header(default=1)):
        data = await read(request, authorization, MAX_BYTES)
        if semaphore.locked(): raise error_type('CONVERTER_BUSY', '转换服务繁忙，请稍后重试', 503)
        async with semaphore:
            try: return await asyncio.to_thread(render_page, data, x_page)
            except Exception as exc: raise error(exc) from None

    @app.post('/pdf/word')
    async def pdf_word(request: Request, authorization: str = Header(default='')):
        data = await read(request, authorization, 90 * 1024 * 1024)
        if semaphore.locked(): raise error_type('CONVERTER_BUSY', '转换服务繁忙，请稍后重试', 503)
        async with semaphore:
            try:
                payload = json.loads(data); source = base64.b64decode(payload['pdf'], validate=True)
                if len(source) > MAX_BYTES: raise ValueError('PDF_PAGE_LIMIT')
                result = await asyncio.to_thread(assemble, source, payload['pages'], binary(), export)
                return Response(result, media_type='application/zip', headers={'Cache-Control': 'no-store'})
            except Exception as exc: raise error(exc) from None
