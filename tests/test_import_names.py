"""Files handed to HX Edit's import get names it can open; no device or converter required."""
from pathlib import Path
import tempfile
import unittest

from nam_convert import convert_batch, import_name


class ImportNameTests(unittest.TestCase):
    def test_brackets_become_round(self):
        self.assertEqual(import_name(Path('Vox AC30 Top Boost 421 [10 layers].nam')), 'Vox AC30 Top Boost 421 (10 layers).wav')
        self.assertEqual(import_name(Path('Чистый {тон}.HIR')), 'Чистый (тон).HIR')

    def test_copied_wavs_use_the_safe_name(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder, 'Cab [V30].wav')
            source.write_bytes(b'RIFF')
            converted = Path(convert_batch([source], folder, Path(__file__))[0])
            self.assertEqual((converted.name, converted.read_bytes()), ('Cab (V30).wav', b'RIFF'))


if __name__ == '__main__':
    unittest.main()
