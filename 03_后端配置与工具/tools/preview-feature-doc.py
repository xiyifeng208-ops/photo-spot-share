"""Render the feature DOCX with Word on Windows and inspectable page images.

Requires pywin32 and Pillow. Uses an isolated hidden Word instance, never an
existing user document. All generated previews are written under .local.
"""
from pathlib import Path
from io import BytesIO
import json
import win32com.client
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PREVIEW = ROOT / '.local' / 'doc-preview'


def main():
    PREVIEW.mkdir(parents=True, exist_ok=True)
    app = win32com.client.DispatchEx('Word.Application')
    doc = None
    try:
        app.Visible = False
        app.DisplayAlerts = 0
        doc = app.Documents.Open(str(ROOT / '项目功能介绍.docx'), ReadOnly=True, AddToRecentFiles=False)
        doc.ActiveWindow.View.Type = 3
        doc.Repaginate()
        count = doc.ComputeStatistics(2)
        doc.ExportAsFixedFormat(str(PREVIEW / 'feature-review.pdf'), 17)
        texts = []
        for index in range(1, count + 1):
            start = doc.GoTo(What=1, Which=1, Count=index).Start
            end = doc.GoTo(What=1, Which=1, Count=index+1).Start if index < count else doc.Content.End
            texts.append({'page': index, 'text': doc.Range(start, end).Text})
            metafile = bytes(doc.ActiveWindow.Panes(1).Pages(index).EnhMetaFileBits)
            img = Image.open(BytesIO(metafile))
            img.load()
            img.convert('RGB').save(PREVIEW / f'page-{index}.png')
        (PREVIEW / 'pages.json').write_text(json.dumps(texts, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'Rendered {count} pages in {PREVIEW}')
    finally:
        if doc is not None:
            doc.Close(SaveChanges=False)
        app.Quit(SaveChanges=False)


if __name__ == '__main__':
    main()
