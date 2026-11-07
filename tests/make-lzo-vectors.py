"""Generate real LZO1X test vectors with the system liblzo2 (via ctypes) for tests/test-mdict.js."""
import base64, ctypes, json, os, random, sys

lzo = ctypes.CDLL("liblzo2.so.2")
size_t = ctypes.c_size_t
WORK = ctypes.create_string_buffer(2 * 1024 * 1024)


def setup(name):
    fn = getattr(lzo, name)
    fn.argtypes = [ctypes.c_char_p, size_t, ctypes.c_void_p, ctypes.POINTER(size_t), ctypes.c_void_p]
    fn.restype = ctypes.c_int
    return fn


compressors = {"lzo1x_1": setup("lzo1x_1_compress")}
try:
    compressors["lzo1x_999"] = setup("lzo1x_999_compress")
except AttributeError:
    pass

dec = lzo.lzo1x_decompress_safe
dec.argtypes = [ctypes.c_char_p, size_t, ctypes.c_void_p, ctypes.POINTER(size_t), ctypes.c_void_p]
dec.restype = ctypes.c_int


def compress(fn, data):
    out = ctypes.create_string_buffer(len(data) + len(data) // 16 + 64 + 3)
    n = size_t(len(out))
    rc = fn(data, len(data), out, ctypes.byref(n), WORK)
    assert rc == 0, rc
    return out.raw[: n.value]


def check(comp, data):
    out = ctypes.create_string_buffer(len(data) + 64)
    n = size_t(len(out))
    rc = dec(comp, len(comp), out, ctypes.byref(n), None)
    assert rc == 0 and out.raw[: n.value] == data, "reference round trip failed"


random.seed(7)
words = ("the quick brown fox jumps over the lazy dog dictionary headword definition "
         "pronunciation noun verb adjective example sentence ").split()
text = " ".join(random.choice(words) + str(random.randint(0, 40)) for _ in range(30000)).encode()

samples = {
    "one_byte": b"x",
    "short_text": b"hello hello hello hello world",
    "text_100k": text[:100000],
    "text_300k": text[:300000],
    "zeros_50k": bytes(50000),
    "random_5k": bytes(random.getrandbits(8) for _ in range(5000)),
    "mixed": b"ab" * 3000 + bytes(random.getrandbits(8) for _ in range(300)) + b"cd" * 5000 + text[:20000],
    "html": ("<div class=\"entry\"><span class=\"hw\">word</span> <span class=\"ph\">/wɝːd/</span> "
             "<ol><li>a unit of language</li><li>a promise</li></ol></div>" * 400).encode("utf-8"),
}

cases = []
for cname, fn in compressors.items():
    for sname, data in samples.items():
        comp = compress(fn, data)
        check(comp, data)
        cases.append({
            "name": cname + ":" + sname,
            "plain": base64.b64encode(data).decode(),
            "comp": base64.b64encode(comp).decode(),
        })

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lzo-vectors.json")
with open(path, "w") as f:
    json.dump(cases, f)
print("wrote", len(cases), "vectors ->", path, "(compressors:", ", ".join(compressors), ")")
