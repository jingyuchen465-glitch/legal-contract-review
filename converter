import io
import sys
import unittest
import zipfile
import shutil
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from pdf_word import render_page, create_word, assemble
from reportlab.pdfgen import canvas


def fixture(pages=1):
    out = io.BytesIO(); pdf = canvas.Canvas(out, pagesize=(600, 800))
    for _ in range(pages):
        pdf.drawString(30, 750, 'SYNTHETIC CONTRACT'); pdf.showPage()
    pdf.save(); return out.getvalue()


class PdfWordTests(unittest.TestCase):
    def test_render_native_geometry(self):
        result = render_page(fixture(), 1)
        self.assertEqual(result['pageCount'], 1)
        self.assertEqual(result['width'], 600)
        self.assertIn('SYNTHETIC CONTRACT', ''.join(x['text'] for x in result['nativeItems']))
        self.assertGreater(len(result['image']), 100)

    def test_render_preserves_text_when_character_position_is_unavailable(self):
        # PDFium can extract a text rectangle without finding a character at
        # the sampled point. Its helper returns None for this valid case.
        with patch('pypdfium2.PdfTextPage.get_index', return_value=None) as lookup:
            result = render_page(fixture(), 1)
        lookup.assert_called()
        self.assertIn('SYNTHETIC CONTRACT', ''.join(x['text'] for x in result['nativeItems']))
        self.assertGreater(len(result['image']), 100)
        self.assertTrue(all(item['fontSize'] >= 5 for item in result['nativeItems']))

    def test_editable_tables_and_page_sizes(self):
        pages = [{'width':600,'height':800,'blocks':[
            {'kind':'paragraph','bbox':[30,30,900,30],'text':'Amount: 12345.67'},
            {'kind':'table','bbox':[30,100,800,200],'rows':2,'columns':2,'cells':[
                {'row':0,'column':0,'colSpan':2,'text':'Merged title'},
                {'row':1,'column':0,'text':'Qty'}, {'row':1,'column':1,'text':'3'}]}]}]
        data, _ = create_word(fixture(), pages)
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            xml = package.read('word/document.xml').decode()
            self.assertIn('12345.67', xml); self.assertIn('w:tbl', xml); self.assertIn('w:gridSpan', xml)

    def test_image_only_output_rejected(self):
        with self.assertRaisesRegex(ValueError, 'WORD_NOT_EDITABLE'):
            create_word(fixture(), [{'width':600,'height':800,'blocks':[{'kind':'image','bbox':[0,0,1000,1000]}]}])

    def test_page_limit_and_corruption(self):
        with self.assertRaisesRegex(ValueError, 'PDF_PAGE_LIMIT'): render_page(fixture(101), 1)
        with self.assertRaises(Exception): render_page(b'%PDF-damaged', 1)

    @unittest.skipUnless(shutil.which('soffice'), 'Requires actual LibreOffice rendering')
    def test_rendered_columns_align_and_large_table_gap_survives(self):
        from app import export, office_binary
        pages = [{'width':600,'height':800,'columns':2,'blocks':[
            {'kind':'paragraph','bbox':[50,50,400,20],'text':'LEFT FIRST'},
            {'kind':'paragraph','bbox':[50,120,400,20],'text':'LEFT SECOND'},
            {'kind':'paragraph','bbox':[550,50,400,20],'text':'RIGHT FIRST'},
            {'kind':'paragraph','bbox':[550,120,400,20],'text':'RIGHT SECOND'}]},
            {'width':600,'height':800,'columns':1,'blocks':[
            {'kind':'paragraph','bbox':[50,50,900,20],'text':'TABLE GAP'},
            {'kind':'table','bbox':[50,300,800,100],'rows':1,'columns':1,
             'cells':[{'row':0,'column':0,'text':'TABLE CONTENT'}]}]}]
        result = assemble(fixture(2), pages, office_binary(), export)
        with zipfile.ZipFile(io.BytesIO(result)) as package:
            preview = package.read('preview.pdf')
        items = {item['text']:item['bbox'] for item in render_page(preview,1)['nativeItems']}
        self.assertLess(abs(items['LEFT FIRST'][1]-items['RIGHT FIRST'][1]),5)
        self.assertLess(abs(items['LEFT SECOND'][1]-items['RIGHT SECOND'][1]),5)
        table = next(n for n in render_page(preview,2)['nativeItems'] if n['text']=='TABLE CONTENT')
        self.assertGreater(table['bbox'][1],300)


if __name__ == '__main__': unittest.main()
