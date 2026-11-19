import asyncio
import hmac
import os
from functools import lru_cache
import fitz
import numpy as np
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

app = FastAPI(docs_url=None, redoc_url=None)
semaphore = asyncio.Semaphore(1)

@lru_cache(maxsize=1)
def engine():
    from paddleocr import PaddleOCR
    return PaddleOCR(use_angle_cls=True, lang='ch', use_gpu=False, show_log=False)

def recognize(data, number):
    with fitz.open(stream=data, filetype='pdf') as document:
        if document.needs_pass or number < 1 or number > len(document):
            raise ValueError('invalid PDF or page')
        page = document[number - 1]
        # Bound rendered pixel count before allocating the bitmap.
        scale = min(2.0, (16000000 / max(page.rect.width * page.rect.height, 1)) ** 0.5)
        image = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        pixels = np.frombuffer(image.samples, dtype=np.uint8).reshape(image.height, image.width, image.n)
        result = engine().ocr(pixels, cls=True)
        blocks = []
        for line in (result[0] if result else []) or []:
            polygon, (text, score) = line
            xs, ys = [p[0] for p in polygon], [p[1] for p in polygon]
            blocks.append({'text': text, 'confidence': float(score), 'bbox': [min(xs), min(ys), max(xs)-min(xs), max(ys)-min(ys)]})
        return {'width': image.width, 'height': image.height, 'blocks': blocks}

@app.get('/health')
def health():
    return {'ok': True, 'engine': 'PaddleOCR', 'concurrency': 1}

@app.post('/parse-page')
async def parse_page(file: UploadFile = File(...), page: int = Form(...), authorization: str = Header(default='')):
    token = os.environ.get('OCR_TOKEN', '')
    if len(token) < 32 or not hmac.compare_digest(authorization, f'Bearer {token}'):
        raise HTTPException(401, 'invalid internal service credential')
    data = await file.read(50 * 1024 * 1024 + 1)
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(413, 'file too large')
    async with semaphore:
        try:
            return await asyncio.to_thread(recognize, data, page)
        except Exception:
            raise HTTPException(422, 'PDF page could not be recognized') from None
