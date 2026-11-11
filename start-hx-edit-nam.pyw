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
    from nam_catalog import ir_parameters, save_setting, sidebar_width
    from nam_convert import convert_batch, stage_tone_import, validate_import
    from nam_library import Library
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
            f"{view}\n{imports}\n{tone}\nconst namView = installNamView({json.dumps(profiles)}, {sidebar_width()}, {json.dumps(ir_parameters(exe.parent / 'res'))});"
            "\ninstallToneView();\nsend({ type: 'ready' });"
        )
        library = Library()
        preview = TonePreview(script, workspace, CONVERTER, detached, message, library=library)

        def on_message(event, _data):
            if event['type'] == 'error':
                errors.append(event.get('description', 'IR import hook failed.'))
                ready.set()
                return
            payload = event.get('payload', {})
            if payload.get('type') == 'ready':
                ready.set()
            if payload.get('type') == 'sidebarWidth':
                try:
                    save_setting('sidebarWidth', int(payload['width']))
                except (OSError, TypeError, ValueError, KeyError) as error:
                    print(f'Could not save the sidebar width: {error}')
            if payload.get('type') in {'toneStart', 'toneBounds', 'toneReply'}:
                preview.receive(payload)
            if payload.get('type') in {'convert', 'validateImport', 'stageTone'}:
                try:
                    if payload['type'] == 'convert':
                        result = {'files': convert_batch(payload['files'], workspace, CONVERTER)}
                        for file in payload['files']:
                            if file.lower().endswith('.nam'):
                                try:
                                    library.add(file)
                                except OSError as error:
                                    print(f'Could not add {file} to the NAM library: {error}')
                    elif payload['type'] == 'stageTone':
                        staged = stage_tone_import(payload['file'], workspace, audition=payload['audition'])
                        result = {'file': str(staged)}
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
    from nam_inventory import HX_NAM_DEVICES, scan_profiles

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lt-nam', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--hx-nam', choices=HX_NAM_DEVICES, help='Confirm the device runs NAM A2 Lite on preset ID 555.')
    args = parser.parse_args()

    device = frida.get_local_device()
    if any(p.name.lower() in {'hx edit.exe', 'hx edit nam.exe'} for p in device.enumerate_processes()):
        raise RuntimeError('Close the open HX Edit window, then start HX Edit NAM again.')
    if not CONVERTER.is_file():
        raise FileNotFoundError('Keep the helix-lt-nam checkout next to hx-edit-nam for the built-in converter.')

    try:
        profiles = scan_profiles(CONVERTER.parent, args.hx_nam)
        scan_error = False
    except Exception as error:
        if args.hx_nam:
            raise
        print(f'Could not scan Helix NAM profiles: {error}')
        profiles, scan_error = {}, True

    (ROOT / 'build').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='nam-', dir=ROOT / 'build', ignore_cleanup_errors=True) as workspace:
        exe = prepare_copy(workspace, scan_error, hx_nam=args.hx_nam)
        run_editor(exe, workspace, device, profiles)


if __name__ == '__main__':
    try:
        main()
    except ModuleNotFoundError as error:
        message(f'{error}\n\nInstall the launcher dependencies with: python -m pip install frida msgpack', 0x10)
    except Exception as error:
        message(error, 0x10)
