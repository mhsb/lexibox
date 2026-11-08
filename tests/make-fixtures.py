"""Writes sample books for the reader e2e test:  python3 tests/make-fixtures.py <outdir>"""
import sys, os, zipfile
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
FILL = " ".join("Filler sentence number %d goes on for a while to take up room." % i for i in range(1, 60))

# --- EPUB
ch1 = ('<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c1</title></head><body>'
       '<h1>The First Chapter</h1><p>A <i>zebra</i> runs fast, today. Dr. Smith saw it. Then it left.</p>'
       '<ul><li>first item</li><li>second item</li></ul><p>%s</p></body></html>' % FILL)
ch2 = ('<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c2</title></head><body>'
       '<h1>The Second Chapter</h1><p>Second chapter text with <b>bold</b> words.</p><p>%s</p></body></html>' % FILL)
nav = ('<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body>'
       '<nav epub:type="toc"><ol><li><a href="c1.xhtml">The First Chapter</a></li><li><a href="c2.xhtml">The Second Chapter</a></li></ol></nav></body></html>')
opf = ('<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
       '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x</dc:identifier><dc:title>Sample Book</dc:title><dc:creator>Test Author</dc:creator></metadata>'
       '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
       '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>'
       '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>')
cont = ('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
        '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
with zipfile.ZipFile(os.path.join(out, 'sample.epub'), 'w') as z:
    z.writestr('mimetype', 'application/epub+zip', zipfile.ZIP_STORED)
    z.writestr('META-INF/container.xml', cont, zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/content.opf', opf, zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/nav.xhtml', nav, zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/c1.xhtml', ch1, zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/c2.xhtml', ch2, zipfile.ZIP_DEFLATED)

# --- DOCX
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
def p(text, style=None, b=False, i=False):
    ppr = '<w:pPr><w:pStyle w:val="%s"/></w:pPr>' % style if style else ''
    rpr = '<w:rPr>%s%s</w:rPr>' % ('<w:b/>' if b else '', '<w:i/>' if i else '')
    return '<w:p>%s<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r></w:p>' % (ppr, rpr, text)
body = (p('Word Heading', 'Heading1') + p('A zebra runs fast, today. Next sentence here.') +
        p('bold words', b=True) + p('italic words', i=True) +
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>list item</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc>%s</w:tc><w:tc>%s</w:tc></w:tr></w:tbl>' % (p('cell one'), p('cell two')))
doc = '<?xml version="1.0" encoding="UTF-8"?><w:document %s><w:body>%s</w:body></w:document>' % (W, body)
styles = ('<?xml version="1.0" encoding="UTF-8"?><w:styles %s><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>' % W)
with zipfile.ZipFile(os.path.join(out, 'sample.docx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    z.writestr('word/document.xml', doc)
    z.writestr('word/styles.xml', styles)

# --- Markdown / text / binary
open(os.path.join(out, 'sample.md'), 'w').write('# Markdown Title\n\nA **zebra** runs fast, today. Another one.\n\n## Sub heading\n\n- apple\n- pear\n\n> quoted words\n\n' + FILL + '\n')
lines = ['CHAPTER I', '', 'A zebra runs fast, today. And more.', '']
txt = 'CHAPTER I\n\n' + '\n'.join(['A zebra runs fast, today. And the hard-wrapped line'] + ['continues here on the next line of the paragraph.']*3) + '\n\nCHAPTER II\n\n' + FILL + '\n'
open(os.path.join(out, 'sample.txt'), 'w').write(txt)
open(os.path.join(out, 'binary.bin'), 'wb').write(bytes(range(256)) * 40)
