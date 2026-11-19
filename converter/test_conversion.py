"""Real LibreOffice smoke tests: python -m unittest discover -s converter -p 'test_*.py'."""
import io
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
import zipfile
from datetime import datetime

from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.text import MSO_AUTO_SIZE
from pypdf import PdfReader
from app import convert, ConversionError, office_binary, profile_directory, export, spreadsheet_document


def workbook_bytes():
    book = Workbook()
    sheet = book.active
    sheet.title = '采购报价'
    sheet.append(['设备', '数量', '金额'])
    sheet.append(['测试设备', 2, 12500.5])
    sheet['C2'].number_format = '#,##0.00'
    sheet['C3'] = '=SUM(C2:C2)'
    sheet['A4'] = datetime(2026, 11, 3)
    sheet['A4'].number_format = 'yyyy-mm-dd'
    sheet.row_dimensions[2].hidden = True
    sheet.print_area = 'A1:C1'
    hidden = book.create_sheet('隐藏补充约定')
    hidden.sheet_state = 'hidden'
    hidden['B2'] = '付款后交货'
    buffer = io.BytesIO()
    book.save(buffer)
    book.close()
    return buffer.getvalue()


def save_pptx(presentation, path):
    """Save a test deck without the stock blank thumbnail (PPTX skill convention)."""
    presentation.save(path)
    cleaned = path.with_suffix('.tmp')
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(cleaned, 'w', zipfile.ZIP_DEFLATED) as target:
        for item in source.infolist():
            if item.filename.lower().startswith('docprops/thumbnail'):
                continue
            data = source.read(item.filename)
            if item.filename in {'[Content_Types].xml', '_rels/.rels'}:
                text = data.decode('utf-8')
                text = re.sub(r'<Override[^>]*PartName="/docProps/thumbnail[^\"]*"[^>]*/?>', '', text, flags=re.I)
                text = re.sub(r'<Relationship[^>]*Target="docProps/thumbnail[^\"]*"[^>]*/?>', '', text, flags=re.I)
                data = text.encode('utf-8')
            target.writestr(item, data)
    os.replace(cleaned, path)


def unpack(data, name):
    package = zipfile.ZipFile(io.BytesIO(data))
    manifest = json.loads(package.read('manifest.json'))
    pdf = package.read('preview.pdf')
    assert pdf.startswith(b'%PDF-')
    output = os.environ.get('CONVERSION_QA_DIR')
    if output:
        root = Path(output)
        root.mkdir(parents=True, exist_ok=True)
        (root / f'{name}.pdf').write_bytes(pdf)
        (root / f'{name}.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return package, manifest, PdfReader(io.BytesIO(pdf))


@unittest.skipUnless(office_binary(), 'LibreOffice is required for real conversion smoke tests')
class RealConversionTests(unittest.TestCase):
    def test_xlsx_hidden_cells_formulas_and_dates_survive_print_area(self):
        _, manifest, pdf = unpack(convert(workbook_bytes(), '.xlsx'), 'xlsx')
        cells = manifest['document']['blocks']
        hidden = next(b for b in cells if b['sheet'] == '隐藏补充约定')
        self.assertEqual(hidden['address'], 'B2')
        self.assertEqual(hidden['sheetState'], 'hidden')
        formula = next(b for b in cells if b['address'] == 'C3')
        self.assertEqual(formula['formula'], '=SUM(C2:C2)')
        self.assertEqual(formula['value'], '无缓存结果')
        self.assertTrue(any('2026-11-03' in b['text'] for b in cells))
        self.assertTrue(any(b['value'] == '测试设备' for b in cells))
        self.assertGreaterEqual(len(pdf.pages), 1)

    def test_csv_chinese_encoding_and_formula_looking_strings(self):
        content = '项目,约定\r\n仓储费,100\r\n备注,=1+1\r\n'.encode('gb18030')
        _, manifest, _ = unpack(convert(content, '.csv'), 'csv')
        cells = manifest['document']['blocks']
        self.assertTrue(any(b['value'] == '仓储费' for b in cells))
        self.assertTrue(any(b['value'] == '=1+1' and b['formula'] is None for b in cells))

    def test_doc_is_a_real_binary_word_file_and_generates_docx_and_pdf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'contract.rtf'
            source.write_text(r'{\rtf1\ansi Purchase Agreement\par Payment amount: 12500.50\par Delivery date: 2026-11-03}', encoding='ascii')
            legacy = export(office_binary(), source, 'doc:MS Word 97', root / 'legacy', profile_directory(root))
            self.assertTrue(legacy.read_bytes().startswith(bytes.fromhex('d0cf11e0a1b11ae1')))
            package, manifest, pdf = unpack(convert(legacy.read_bytes(), '.doc'), 'doc')
            self.assertIsNone(manifest['document'])
            self.assertIn('word/document.xml', zipfile.ZipFile(io.BytesIO(package.read('document.docx'))).namelist())
            self.assertIn('12500.50', ''.join(page.extract_text() for page in pdf.pages))
            odt = export(office_binary(), source, 'odt:writer8', root / 'odt', root / 'profile')
            _, _, odt_pdf = unpack(convert(odt.read_bytes(), '.odt'), 'odt')
            self.assertIn('12500.50', ''.join(page.extract_text() for page in odt_pdf.pages))

    def test_legacy_xls_and_open_document_spreadsheet(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'quotation.xlsx'
            source.write_bytes(workbook_bytes())
            profile = profile_directory(root)
            for extension, filter_name in [('.xls', 'xls:MS Excel 97'), ('.ods', 'ods:calc8')]:
                converted = export(office_binary(), source, filter_name, root / extension[1:], profile)
                _, manifest, _ = unpack(convert(converted.read_bytes(), extension), extension[1:])
                self.assertTrue(any(b['value'] == '付款后交货' for b in manifest['document']['blocks']))

    def test_pptx_and_ppt_include_hidden_slides_and_speaker_notes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            presentation = Presentation()
            for number in (1, 2):
                slide = presentation.slides.add_slide(presentation.slide_layouts[6])
                shape = slide.shapes.add_textbox(Inches(0.6), Inches(1), Inches(8), Inches(1))
                frame = shape.text_frame
                frame.word_wrap = True
                frame.auto_size = MSO_AUTO_SIZE.NONE
                paragraph = frame.paragraphs[0]
                run = paragraph.add_run()
                run.text = f'采购合同测试 Contract slide {number}'
                run.font.name = 'Microsoft YaHei'
                run.font.size = Pt(24)
                from pptx.oxml.xmlchemy import OxmlElement
                ea = OxmlElement('a:ea')
                ea.set('typeface', 'Microsoft YaHei')
                run._r.get_or_add_rPr().append(ea)
                if number == 2:
                    slide._element.set('show', '0')
                    slide.notes_slide.notes_text_frame.text = '隐藏页备注：付款条件需另行核实'
            source = root / 'contract.pptx'
            save_pptx(presentation, source)
            legacy = export(office_binary(), source, 'ppt:MS PowerPoint 97', root / 'legacy', profile_directory(root))
            odp = export(office_binary(), source, 'odp:impress8', root / 'odp', root / 'profile')
            for extension, path in [('.pptx', source), ('.ppt', legacy), ('.odp', odp)]:
                _, manifest, pdf = unpack(convert(path.read_bytes(), extension), extension[1:])
                self.assertEqual(len(pdf.pages), 2)
                self.assertTrue(any('付款条件需另行核实' in b['text'] and b['page'] == 2 for b in manifest['notes']))

    def test_invalid_and_sparse_files_fail_with_readable_errors(self):
        with self.assertRaises(ConversionError) as error:
            convert(b'not a spreadsheet', '.xlsx')
        self.assertEqual(error.exception.code, 'INVALID_DOCUMENT')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'sparse.xlsx'
            book = Workbook()
            book.active['A100001'] = 'too sparse'
            book.save(path)
            book.close()
            with self.assertRaises(ConversionError) as error:
                spreadsheet_document(path)
            self.assertEqual(error.exception.code, 'SPREADSHEET_TOO_LARGE')

    def test_understated_dimensions_do_not_hide_rows(self):
        source = io.BytesIO(workbook_bytes())
        target = io.BytesIO()
        with zipfile.ZipFile(source) as package, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as output:
            for item in package.infolist():
                data = package.read(item.filename)
                if item.filename.startswith('xl/worksheets/sheet'):
                    data = re.sub(rb'<dimension ref="[^"]+"\s*/>', b'<dimension ref="A1"/>', data)
                output.writestr(item, data)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'understated.xlsx'
            path.write_bytes(target.getvalue())
            document = spreadsheet_document(path)
            self.assertTrue(any(b['value'] == '测试设备' for b in document['blocks']))
            self.assertTrue(any(b['value'] == '付款后交货' for b in document['blocks']))


if __name__ == '__main__':
    unittest.main()
