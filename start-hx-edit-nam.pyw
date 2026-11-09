"""Start the local HX Edit NAM build and service the IR import converter."""

import argparse
import ctypes
import json
from pathlib import Path
import tempfile
from threading import Event


ROOT = Path(__file__).resolve().parent
CONVERTER = ROOT.parent / 'helix-lt-nam' / 'tools' / 'nam2ir.py'
TITLE = 'HX Edit NAM'


def message(text, flags):
    return ctypes.windll.user32.MessageBoxW(None, str(text), TITLE, flags)


def run_editor(exe, workspace, device, profiles):
    from nam_convert import convert_batch, validate_import
    from tone_preview import TonePreview

    pid = device.spawn([str(exe)], cwd=str(exe.parent))
    try:
        session = device.attach(pid)
        detached = Event()
        ready = Event()
        errors = []
        session.on('detached', lambda *_: detached.set())
        imports = (ROOT / 'nam_import.js').read_text(encoding='utf-8')
        view = (ROOT / 'nam_view.js').read_text(encoding='utf-8')
        tone = (ROOT / 'tone_view.js').read_text(encoding='utf-8')
        script = session.create_script(
            f"{view}\n{imports}\n{tone}\nconst namView = installNamView({json.dumps(profiles)});"
            "\ninstallToneView();\nsend({ type: 'ready' });"
        )
        preview = TonePreview(script, workspace, CONVERTER, detached, message)

        def on_message(event, _data):
            if event['type'] == 'error':
                errors.append(event.get('description', 'IR import hook failed.'))
                ready.set()
                return
            payload = event.get('payload', {})
            if payload.get('type') == 'ready':
                ready.set()
            if payload.get('type') in {'toneStart', 'toneBounds', 'toneReply'}:
                preview.receive(payload)
            if payload.get('type') in {'convert', 'validateImport'}:
                try:
                    if payload['type'] == 'convert':
                        result = {'files': convert_batch(payload['files'], workspace, CONVERTER)}
                    else:
                        imported = validate_import(payload['files'], payload['firstSlot'],
                                                   set(payload['occupied']), payload['namOnly'])
                        result = {'profiles': imported}
                except Exception as error:
                    result = {'error': str(error)}
                if not detached.is_set():
                    script.post({'type': 'converted', 'payload': result})

        script.on('message', on_message)
        script.load()
        if not ready.wait(5) or errors:
            raise RuntimeError(errors[0] if errors else 'HX Edit did not initialize the IR import hook.')
        device.resume(pid)
        detached.wait()
        if preview.thread:
            preview.thread.join(timeout=2)
    except BaseException:
        try:
            device.kill(pid)
        except Exception:
            pass
        raise


def main():
    import frida
    from nam_catalog import prepare_copy
    from nam_inventory import scan_profiles

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lt-nam', action='store_true', help='Confirm the device runs a 3.80.0 NAM build (helix-lt-nam or helix-floor-nam-lite).')
    args = parser.parse_args()

    device = frida.get_local_device()
    if any(p.name.lower() in {'hx edit.exe', 'hx edit nam.exe'} for p in device.enumerate_processes()):
        raise RuntimeError('Close the open HX Edit window, then start HX Edit NAM again.')
    if not CONVERTER.is_file():
        raise FileNotFoundError('Keep the helix-lt-nam checkout next to hx-edit-nam for the built-in converter.')

    if not args.lt_nam:
        choice = message('This editor is for Helix LT or Floor with a 3.80.0 NAM firmware build.\n\n'
                         'Is NAM A2 Lite already available under Amp > NAM on your device?', 0x24 | 0x100)
        if choice != 6:
            return

    try:
        profiles = scan_profiles(CONVERTER.parent)
        scan_error = False
    except Exception as error:
        print(f'Could not scan Helix NAM profiles: {error}')
        profiles, scan_error = {}, True

    (ROOT / 'build').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='nam-', dir=ROOT / 'build', ignore_cleanup_errors=True) as workspace:
        exe = prepare_copy(workspace, scan_error)
        run_editor(exe, workspace, device, profiles)


if __name__ == '__main__':
    try:
        main()
    except ModuleNotFoundError as error:
        message(f'{error}\n\nInstall the launcher dependencies with: python -m pip install frida msgpack', 0x10)
    except Exception as error:
        message(error, 0x10)
