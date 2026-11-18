"""Internal Office conversion service. Originals never leave the deployment."""
import asyncio
import csv
import hmac
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import zipfile

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import Response, JSONResponse
from openpyxl import load_workbook
from pptx import Presentation

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
semaphore = asyncio.Semaphore(1)
LIMIT = 50 * 1024 * 1024
EXPANSION_LIMIT = 150 * 1024 * 1024
CELL_LIMIT = 100000
TEXT_LIMIT = 5 * 1024 * 1024
FORMATS = {'.doc', '.xls', '.xlsx', '.csv', '.ppt', '.pptx', '.odt', '.ods', '.odp'}


class ConversionError(Exception):
    def __init__(self, code, message, status=422):
        self.code, self.message, self.status = code, message, status


@app.exception_handler(ConversionError)
async def conversion_error(_request, error):
    return JSONResponse({'code': error.code, 'message': error.message}, status_code=error.status)


def office_binary():
    configured = os.environ.get('SOFFICE_PATH')
    candidates = [configured] if configured else [shutil.which('soffice'), r'C:\Program Files\LibreOffice\program\soffice.com']
    return next((str(p) for p in candidates if p and Path(p).is_file()), None)


def check_package(data, extension):
    if extension not in {'.xlsx', '.pptx', '.odt', '.ods', '.odp'}:
        return
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            infos = package.infolist()
            if len(infos) > 20000 or sum(item.file_size for item in infos) > EXPANSION_LIMIT:
                raise ConversionError('DOCUMENT_TOO_LARGE', '文档解压内容过大，请拆分后上传')
            if any('vbaproject' in item.filename.lower() or item.filename.lower().endswith('/encryptedpackage') for item in infos):
                raise ConversionError('MACRO_FILE', '含宏或加密的文件需要先另存为普通文档')
            required = {'.xlsx': 'xl/workbook.xml', '.pptx': 'ppt/presentation.xml'}.get(extension)
            if required and required not in package.namelist():
                raise ConversionError('INVALID_DOCUMENT', '文件内容与扩展名不符或已损坏')
    except (zipfile.BadZipFile, RuntimeError):
        raise ConversionError('INVALID_DOCUMENT', '文件已损坏或加密，请补充可打开的文件') from None


def profile_directory(root):
    profile = root / 'profile'
    (profile / 'user').mkdir(parents=True)
    # Disable macros and automatic external-link updates for every isolated job.
    (profile / 'user' / 'registrymodifications.xcu').write_text('''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
</oor:items>''', encoding='utf-8')
    return profile


def export(binary, source, target_format, output, profile):
    output.mkdir(exist_ok=True)
    args = [binary, f'-env:UserInstallation={profile.as_uri()}', '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--convert-to', target_format, '--outdir', str(output), str(source)]
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                               start_new_session=os.name != 'nt')
    try:
        process.communicate(timeout=90)
    except subprocess.TimeoutExpired:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise ConversionError('CONVERSION_TIMEOUT', '文档转换超时，请拆分文件或改传 PDF') from None
    extension = target_format.split(':')[0]
    path = output / f'{source.stem}.{extension}'
    if process.returncode or not path.is_file() or not path.stat().st_size:
        raise ConversionError('CONVERSION_FAILED', '文档无法转换，可能已加密、损坏或格式不兼容，请改传 PDF')
    if path.stat().st_size > LIMIT:
        raise ConversionError('CONVERSION_TOO_LARGE', '转换后的文件超过 50MB，请拆分后上传')
    return path


def spreadsheet_document(path):
    """Read every populated cell, including hidden sheets/rows and cached formulas."""
    formulas = load_workbook(path, read_only=True, data_only=False, keep_links=False)
    cached = load_workbook(path, read_only=True, data_only=True, keep_links=False)
    blocks, sheets, total, text_size, range_size = [], [], 0, 0, 0
    missing_cache = False
    try:
        for sheet, values in zip(formulas.worksheets, cached.worksheets):
            sheets.append({'name': sheet.title, 'state': sheet.sheet_state})
            # Some producers omit dimensions or declare A1 even when later rows exist.
            # Derive actual extents before iterating so cells cannot be silently omitted.
            for source_sheet in (sheet, values):
                source_sheet.reset_dimensions()
                source_sheet.calculate_dimension(force=True)
            # Do not trust sparse/forged dimensions to allocate unbounded rows/columns.
            range_size += (sheet.max_row or 0) * (sheet.max_column or 0)
            if range_size > CELL_LIMIT:
                raise ConversionError('SPREADSHEET_TOO_LARGE', '表格范围过大或过于稀疏，请拆分并清理空白格式后上传')
            for row, cached_row in zip(sheet.iter_rows(), values.iter_rows()):
                for cell, cached_cell in zip(row, cached_row):
                    if cell.value is None:
                        continue
                    total += 1
                    if total > CELL_LIMIT:
                        raise ConversionError('SPREADSHEET_TOO_LARGE', '表格非空单元格过多，请拆分后上传')
                    formula = str(cell.value) if cell.data_type == 'f' else None
                    value = cached_cell.value if formula else cell.value
                    if formula and value is None:
                        missing_cache = True
                    display = value.isoformat() if hasattr(value, 'isoformat') else str(value) if value is not None else '无缓存结果'
                    hidden = '（隐藏工作表）' if sheet.sheet_state != 'visible' else ''
                    text = f'工作表「{sheet.title}」{hidden} / {cell.coordinate}：{display}'
                    if formula:
                        text += f'；公式：{formula}'
                    if cell.number_format != 'General':
                        text += f'；显示格式：{cell.number_format}'
                    text_size += len(text)
                    if text_size > TEXT_LIMIT:
                        raise ConversionError('DOCUMENT_TOO_LARGE', '表格文本过多，请拆分后上传')
                    blocks.append({'id': f'b{len(blocks)+1}', 'text': text, 'kind': 'table_cell', 'source': 'spreadsheet',
                                   'sheet': sheet.title, 'address': cell.coordinate, 'sheetState': sheet.sheet_state,
                                   'row': cell.row, 'cell': cell.column, 'page': None, 'formula': formula, 'value': display, 'numberFormat': cell.number_format})
    finally:
        formulas.close()
        cached.close()
    if not blocks:
        raise ConversionError('EMPTY_TEXT', '表格未提取到非空单元格，请补充文字材料')
    warnings = ['表格按工作表及单元格定位，包含隐藏工作表及隐藏行列。PDF 预览受原文件打印区域影响，审查以全部单元格文本为准；图表、图片和嵌入对象请结合原件核对。',
                '公式使用文件中的缓存结果，不执行宏、不刷新外部链接；金额、日期和公式结果需结合原件核实。']
    if missing_cache:
        warnings.append('存在没有缓存结果的公式，未推算结果，请在 Excel 中核算并保存后补充。')
    return {'parserVersion': 'office-converter-1.0', 'format': 'spreadsheet', 'blocks': blocks, 'sheets': sheets,
            'requiresHumanVerification': True, 'warnings': warnings}


def csv_workbook(source, output):
    from openpyxl import Workbook
    raw = source.read_bytes()
    for encoding in ['utf-8-sig', 'gb18030']:
        try:
            content = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ConversionError('CSV_ENCODING', 'CSV 编码无法识别，请另存为 UTF-8 CSV 或 XLSX')
    if '\x00' in content:
        raise ConversionError('INVALID_DOCUMENT', 'CSV 包含二进制内容，请核对文件格式')
    try:
        dialect = csv.Sniffer().sniff(content[:8192], delimiters=',;\t')
    except csv.Error:
        dialect = csv.excel
    book = Workbook()
    sheet = book.active
    sheet.title = 'CSV'
    count = 0
    for number, row in enumerate(csv.reader(io.StringIO(content), dialect), 1):
        if number > CELL_LIMIT or len(row) > 16384:
            raise ConversionError('SPREADSHEET_TOO_LARGE', 'CSV 行列范围过大，请拆分后上传')
        count += len(row)
        if count > CELL_LIMIT:
            raise ConversionError('SPREADSHEET_TOO_LARGE', 'CSV 单元格过多，请拆分后上传')
        sheet.append(row)
        # Preserve formula-looking source strings as literal data, never evaluate them.
        for cell in sheet[sheet.max_row] if row else []:
            if cell.data_type == 'f':
                cell.data_type = 's'
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    book.save(output)
    book.close()
    return output


def presentation_notes(path):
    presentation = Presentation(path)
    blocks = []
    for number, slide in enumerate(presentation.slides, 1):
        if not slide.has_notes_slide:
            continue
        frame = slide.notes_slide.notes_text_frame
        if frame and frame.text.strip():
            blocks.append({'id': f'n{len(blocks)+1}', 'text': f'第 {number} 页演讲者备注：{frame.text.strip()}',
                           'page': number, 'source': 'presentation_notes', 'kind': 'paragraph'})
    return blocks


def convert(data, extension):
    if extension not in FORMATS:
        raise ConversionError('UNSUPPORTED_FILE_TYPE', '该格式暂不支持自动转换')
    if not data or len(data) > LIMIT:
        raise ConversionError('FILE_TOO_LARGE', '请选择不超过 50MB 的非空文件')
    check_package(data, extension)
    binary = office_binary()
    if not binary:
        raise ConversionError('CONVERTER_NOT_READY', '转换引擎未安装，请联系管理员配置 LibreOffice', 503)
    with tempfile.TemporaryDirectory(prefix='legal-convert-') as directory:
        root = Path(directory)
        profile = profile_directory(root)
        source = root / f'source{extension}'
        source.write_bytes(data)
        document, docx, notes = None, None, []
        if extension in {'.doc', '.odt'}:
            docx = export(binary, source, 'docx:Office Open XML Text', root / 'word', profile)
            preview_source = docx
        elif extension in {'.xls', '.xlsx', '.csv', '.ods'}:
            normalized = source if extension == '.xlsx' else csv_workbook(source, root / 'source.xlsx') if extension == '.csv' else export(binary, source, 'xlsx:Calc MS Excel 2007 XML', root / 'sheets', profile)
            check_package(normalized.read_bytes(), '.xlsx')
            document = spreadsheet_document(normalized)
            if extension in {'.xls', '.ods'}:
                document['warnings'].append('旧版或 ODF 表格先转换为 XLSX，转换可能重算公式；请结合原件核实计算结果。')
            preview_source = normalized
        else:
            normalized = source if extension == '.pptx' else export(binary, source, 'pptx:Impress MS PowerPoint 2007 XML', root / 'slides', profile)
            check_package(normalized.read_bytes(), '.pptx')
            notes = presentation_notes(normalized)
            preview_source = normalized
        pdf_filter = 'pdf:calc_pdf_Export' if extension in {'.xls', '.xlsx', '.csv', '.ods'} else 'pdf:impress_pdf_Export' if extension in {'.ppt', '.pptx', '.odp'} else 'pdf:writer_pdf_Export'
        # Export hidden slides too, so extracted page positions stay aligned.
        if extension in {'.ppt', '.pptx', '.odp'}:
            pdf_filter += ':{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'
        preview = export(binary, preview_source, pdf_filter, root / 'pdf', profile).read_bytes()
        if not preview.startswith(b'%PDF-'):
            raise ConversionError('CONVERSION_FAILED', '转换未生成有效的 PDF 预览')
        manifest = {'version': 1, 'sourceExtension': extension, 'document': document, 'notes': notes,
                    'warnings': ['自动转换可能改变排版，请核对原件中的金额、日期、图片及嵌入对象。']}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as package:
            package.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False))
            package.writestr('preview.pdf', preview)
            if docx:
                package.writestr('document.docx', docx.read_bytes())
        if buffer.tell() > EXPANSION_LIMIT:
            raise ConversionError('CONVERSION_TOO_LARGE', '转换结果过大，请拆分后上传')
        return buffer.getvalue()


@app.get('/health')
def health():
    return {'ok': bool(office_binary()), 'service': 'office-converter'}


@app.post('/convert')
async def convert_file(request: Request, authorization: str = Header(default=''), x_file_extension: str = Header(default='')):
    token = os.environ.get('CONVERTER_TOKEN', '')
    if len(token) < 32 or not hmac.compare_digest(authorization, f'Bearer {token}'):
        raise HTTPException(401, 'invalid internal service credential')
    if x_file_extension not in FORMATS:
        raise ConversionError('UNSUPPORTED_FILE_TYPE', '该格式暂不支持自动转换')
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > LIMIT:
            raise ConversionError('FILE_TOO_LARGE', '文件超过 50MB', 413)
    # Reject excess jobs instead of accumulating large documents in memory.
    if semaphore.locked():
        raise ConversionError('CONVERTER_BUSY', '转换服务繁忙，请稍后重试', 503)
    async with semaphore:
        try:
            result = await asyncio.to_thread(convert, bytes(data), x_file_extension)
        except ConversionError:
            raise
        except Exception:
            raise ConversionError('CONVERSION_FAILED', '文件无法读取，可能已加密、损坏或格式不兼容，请改传 PDF') from None
    return Response(result, media_type='application/zip', headers={'Cache-Control': 'no-store'})


from pdf_word import mount_pdf_routes
mount_pdf_routes(app, semaphore, ConversionError, office_binary, export)
