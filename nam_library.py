"""NAM captures kept on this PC: original .nam files plus a small JSON catalog."""

from datetime import date
from hashlib import sha256
from html import escape
import json
import os
from pathlib import Path
import shutil
from string import Template
from threading import Lock

from nam_convert import IR_NAME_LIMIT


FOLDER = Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'HX Edit NAM' / 'NAM Library'
PAGE = Path(__file__).with_name('library_card.html')
GEARS = {'amp': 'Amp', 'amp-cab': 'Amp + cab', 'pedal': 'Pedal', 'outboard': 'Outboard', '': 'Unsorted'}


def capture_gear(path):
    try:
        gear = json.loads(Path(path).read_text(encoding='utf-8')).get('metadata', {}).get('gear_type')
    except (OSError, ValueError, AttributeError):
        return ''
    # NAM trainer metadata names -> TONE3000 gear names used by the library.
    return {'amp': 'amp', 'preamp': 'amp', 'amp_cab': 'amp-cab', 'amp_pedal_cab': 'amp-cab',
            'pedal': 'pedal', 'pedal_amp': 'pedal', 'studio': 'outboard'}.get(gear, '')


class Library:
    def __init__(self, folder=FOLDER):
        self.folder = Path(folder)
        self.catalog = self.folder / 'catalog.json'
        self.lock = Lock()

    def entries(self):
        try:
            entries = json.loads(self.catalog.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return {}
        return entries if isinstance(entries, dict) else {}

    def _write(self, entries):
        self.folder.mkdir(parents=True, exist_ok=True)
        temporary = self.catalog.with_suffix('.tmp')
        temporary.write_text(json.dumps(entries, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
        temporary.replace(self.catalog)

    def add(self, capture, *, name=None, gear=None, source=''):
        """Keep a .nam file; the same capture added twice stays one entry with its first date."""
        data = Path(capture).read_bytes()
        identity = sha256(data).hexdigest()
        ir_name = Path(capture).stem[:IR_NAME_LIMIT].rstrip(' .') or 'NAM'
        with self.lock:
            entries = self.entries()
            entry = entries.setdefault(identity, {'added': date.today().isoformat()})
            entry.setdefault('name', name or Path(capture).stem)
            entry.setdefault('irName', ir_name)
            entry.setdefault('gear', gear if gear is not None else capture_gear(capture))
            if source:
                entry['source'] = source
            self.folder.mkdir(parents=True, exist_ok=True)
            if not (self.folder / f'{identity}.nam').is_file():
                (self.folder / f'{identity}.nam').write_bytes(data)
            self._write(entries)
        return identity

    def update(self, identity, *, gear=None, name=None):
        with self.lock:
            entries = self.entries()
            if identity not in entries:
                raise KeyError(identity)
            if gear is not None:
                if gear not in GEARS:
                    raise ValueError(f'Unknown type: {gear}')
                entries[identity]['gear'] = gear
            if name is not None and name.strip():
                entries[identity]['name'] = name.strip()[:200]
            self._write(entries)

    def remove(self, identity):
        with self.lock:
            entries = self.entries()
            if entries.pop(identity, None) is not None:
                (self.folder / f'{identity}.nam').unlink(missing_ok=True)
                self._write(entries)

    def export(self, identity, directory):
        """Copy a kept capture under its IR name so HX Edit shows a readable slot name."""
        entry = self.entries()[identity]
        destination = Path(directory) / f'{entry["irName"]}.nam'
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.folder / f'{identity}.nam', destination)
        return destination


def render_library(entries):
    rows = [dict(id=key, name=value.get('name', ''), gear=value.get('gear', ''),
                 added=value.get('added', ''), source=value.get('source', ''))
            for key, value in entries.items()]
    options = ''.join(f'<option value="{escape(key)}">{escape(label)}</option>' for key, label in GEARS.items())
    # JSON inside <script>: escape "<" so a capture name cannot close the element.
    data = json.dumps(rows, ensure_ascii=False).replace('<', '\\u003c')
    return Template(PAGE.read_text(encoding='utf-8')).substitute(rows=data, gears=options)
