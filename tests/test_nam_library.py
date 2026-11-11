"""Local NAM library: storage, de-duplication and the library page; no device required."""
import json
from pathlib import Path
import tempfile
import unittest

from nam_library import Library, render_library


class LibraryTests(unittest.TestCase):
    def test_keeps_one_entry_per_capture_and_escapes_the_page(self):
        with tempfile.TemporaryDirectory() as folder:
            capture = Path(folder, 'Plexi Crunch 42.nam')
            capture.write_text(json.dumps({'metadata': {'gear_type': 'pedal_amp'}}), encoding='utf-8')
            library = Library(Path(folder, 'library'))
            first = library.add(capture, name='Plexi </script><b>', source='https://www.tone3000.com/tones/42')
            self.assertEqual(library.add(capture), first)
            entry = library.entries()[first]
            self.assertEqual((entry['gear'], entry['irName'], entry['name']), ('pedal', 'Plexi Crunch 42', 'Plexi </script><b>'))

            library.update(first, gear='amp')
            with self.assertRaises(ValueError):
                library.update(first, gear='synth')
            exported = library.export(first, Path(folder, 'export'))
            self.assertEqual((exported.name, exported.read_bytes()), ('Plexi Crunch 42.nam', capture.read_bytes()))

            page = render_library(library.entries())
            self.assertNotIn('</script><b>', page)
            self.assertIn('"gear": "amp"', page)

            library.remove(first)
            self.assertEqual(library.entries(), {})
            self.assertFalse(Path(folder, 'library', f'{first}.nam').exists())


if __name__ == '__main__':
    unittest.main()
