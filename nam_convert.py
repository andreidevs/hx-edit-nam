"""Convert a selection of NAM captures and WAVs into one HX Edit import batch."""

import os
from pathlib import Path
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile

from nam_inventory import is_nam_profile


LAST_SLOT = 128
IR_NAME_LIMIT = 31


def is_nam_wav(path):
    # Converter output is mono 48 kHz float WAV. Walk the RIFF chunks so
    # metadata before the samples does not affect profile detection.
    with path.open('rb') as wav:
        header = wav.read(12)
        if header[:4] != b'RIFF' or header[8:] != b'WAVE':
            return False
        format_ok = False
        profile = False
        while len(chunk := wav.read(8)) == 8:
            kind, size = struct.unpack('<4sI', chunk)
            end = wav.tell() + size + (size & 1)
            if kind == b'fmt ' and size >= 16:
                format_ok = struct.unpack('<HHIIHH', wav.read(16)) == (3, 1, 48000, 192000, 4, 32)
            elif kind == b'data' and size == 8192:
                profile = is_nam_profile(wav.read(size))
            if format_ok and profile:
                return True
            wav.seek(end)
        return False


def validate_import(files, first_slot, occupied, nam_only=False):
    last_slot = first_slot + len(files) - 1
    if not files or not 1 <= first_slot <= last_slot <= LAST_SLOT:
        raise ValueError('Select enough consecutive slots within User IR 1–128.')
    profiles = {}
    for slot, filename in enumerate(files, first_slot):
        path = Path(filename)
        suffix = path.suffix.lower()
        if suffix not in {'.wav', '.hir'}:
            raise ValueError('Use IRs → Import to convert a .nam capture.')
        profile = suffix == '.wav' and is_nam_wav(path)
        if nam_only and not profile:
            raise ValueError(f'{path.name} is a cabinet IR. Import it from the IRs tab.')
        if slot in occupied:
            raise ValueError(f'Slot {slot} is already occupied. Select consecutive free slots.')
        if profile:
            profiles[slot] = path.stem
    return profiles


def stage_tone_import(file, workspace, *, audition=False):
    """Give HX Edit a disposable copy for each upload, including Save to Helix."""
    source = Path(file).resolve(strict=True)
    workspace = Path(workspace).resolve()
    if not source.is_relative_to(workspace) or source.suffix != '.wav' or not is_nam_wav(source):
        raise ValueError('Could not read the converted TONE3000 profile.')
    name = source.name
    if audition:
        # The editor matches this name before clearing the audition slot.
        tag = ' ' + secrets.token_hex(3)
        name = source.stem[:IR_NAME_LIMIT - len(tag)].rstrip(' .') + tag + '.wav'
    folder = Path(tempfile.mkdtemp(prefix='tone-import-', dir=workspace))
    return shutil.copyfile(source, folder / name)


def import_name(source):
    """The file name handed to HX Edit's import. Square brackets became round ones after a
    batch of '[10 layers]' captures failed with -401 (unconfirmed cause, harmless change)."""
    stem = source.stem.translate(str.maketrans('[]{}', '()()'))
    return stem + ('.wav' if source.suffix.lower() == '.nam' else source.suffix)


def convert_batch(files, workspace, converter):
    sources = [Path(file).resolve(strict=True) for file in files]
    names = set()
    for source in sources:
        suffix = source.suffix.lower()
        if not source.is_file() or suffix not in {'.wav', '.hir', '.nam'}:
            raise ValueError(f'Choose a .nam, .wav or .hir file: {source.name}')
        name = import_name(source).casefold()
        if name in names:
            raise ValueError(f'Two selected files have the same IR name: {source.stem}')
        names.add(name)

    if not converter.is_file():
        raise FileNotFoundError('The neighboring helix-lt-nam checkout is missing tools/nam2ir.py.')

    folder = Path(tempfile.mkdtemp(prefix='profiles-', dir=workspace))
    result = []
    for source in sources:
        if source.suffix.lower() != '.nam':
            destination = folder / import_name(source)
            shutil.copyfile(source, destination)
        else:
            destination = folder / import_name(source)
            # Use the same case-sensitive extension and UTF-8 mode as the firmware tools expect.
            capture = destination.with_suffix('.nam')
            shutil.copyfile(source, capture)
            completed = subprocess.run(
                [sys.executable, '-B', '-X', 'utf8', str(converter), str(capture), '-o', str(destination)],
                capture_output=True, encoding='utf-8', errors='replace', timeout=30,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
            )
            capture.unlink()
            if completed.returncode:
                errors = completed.stderr.strip().splitlines()
                detail = errors[-1].replace(str(capture), source.name) if errors else 'Unsupported capture.'
                raise ValueError(f'{source.name}\n\n{detail}')
        result.append(str(destination))
    return result
