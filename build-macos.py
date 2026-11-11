"""Build HX Edit NAM for Apple Silicon and package it for release."""

import argparse
from pathlib import Path
import lzma
import platform
import plistlib
import re
import shutil
import subprocess
import tempfile
from urllib.request import urlopen

from prepare_editor_macos import digest, run


ROOT = Path(__file__).resolve().parent
BUILD = ROOT / 'build'
GADGET_HASH = '2b01bde3363912641641933eda2aadaa9f1f7e3d7cc5db8260ce4d6990365e84'
GADGET_URL = ('https://github.com/frida/frida/releases/download/17.5.2/'
              'frida-gadget-17.5.2-macos-universal.dylib.xz')
PYTHON_VERSION = '3.13.7'
FIRMWARE_URL = 'https://github.com/andreidevs/helix-lt-nam.git'
FIRMWARE_REV = 'c94834768546393420692794fdbb27c9cc31d718'
FIRMWARE_FILES = (
    'LICENSE', 'tools/nam2ir.py', 'tools/hx_ctl.py', 'tools/hx_dfu_reboot.py',
    'tools/sharc/nam_lite.py', 'tools/sharc/nam_pack.py', 'tools/sharc/sasm.py',
    'tools/sharc/ssim.py', 'tools/sharc/recips_table.json',
)
APP_FILES = ('start-hx-edit-nam-macos.py', 'prepare_editor_macos.py', 'nam_catalog.py',
             'nam_inventory_macos.py', 'nam_inventory.py', 'nam_convert.py', 'nam_library.py', 'nam_macos.js',
             'tone3000.py', 'tone_browser.py',
             'tone_browser_macos.py', 'tone_card.html', 'tone_macos.js', 'tone_preview.py')


def add_runtime(resources):
    cache = BUILD / 'python-install'
    run('uv', 'python', 'install', PYTHON_VERSION, '--install-dir', cache)
    source = cache / f'cpython-{PYTHON_VERSION}-macos-aarch64-none'
    destination = resources / 'runtime'
    (destination / 'bin').mkdir(parents=True)
    shutil.copy2(source / 'bin' / 'python3.13', destination / 'bin')
    shutil.copytree(source / 'lib', destination / 'lib', symlinks=True)
    python = destination / 'bin' / 'python3.13'
    run(python, '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--retries', '0',
        '--no-compile', '--no-deps', '--break-system-packages', 'frida==17.5.2', 'msgpack==1.2.4', 'pyusb==1.3.1')
    return python


def add_gadget(destination, work):
    archive = BUILD / 'frida-gadget.dylib.xz'
    if not archive.is_file():
        partial = work / archive.name
        with urlopen(GADGET_URL, timeout=60) as response, partial.open('wb') as handle:
            shutil.copyfileobj(response, handle)
        if digest(partial) != GADGET_HASH:
            raise ValueError('Frida Gadget archive checksum mismatch.')
        partial.replace(archive)
    if digest(archive) != GADGET_HASH:
        raise ValueError(f'Frida Gadget archive checksum mismatch. Remove {archive} and build again.')
    universal = work / 'gadget-universal.dylib'
    with lzma.open(archive) as source, universal.open('wb') as target:
        shutil.copyfileobj(source, target)
    run('/usr/bin/lipo', universal, '-thin', 'arm64', '-output', destination)
    run('/usr/bin/codesign', '--force', '--sign', '-', destination)


def add_converter(destination, checkout):
    if checkout is None:
        checkout = BUILD / 'helix-lt-nam'
        if not (checkout / '.git').exists():
            run('git', 'init', '--quiet', checkout)
        available = subprocess.run(['git', '-C', checkout, 'cat-file', '-e', f'{FIRMWARE_REV}^{{commit}}'],
                                   stderr=subprocess.DEVNULL).returncode == 0
        if not available:
            run('git', '-C', checkout, 'fetch', '--quiet', '--depth=1', FIRMWARE_URL, FIRMWARE_REV)
    for name in FIRMWARE_FILES:
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subprocess.check_output(['git', '-C', checkout, 'show', f'{FIRMWARE_REV}:{name}']))
    (destination / 'UPSTREAM.txt').write_text(
        f'https://github.com/andreidevs/helix-lt-nam/tree/{FIRMWARE_REV}\n', encoding='ascii')


def package(source, checkout, release_version):
    BUILD.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='macos-', dir=BUILD) as folder:
        work = Path(folder)
        app = work / 'HX Edit NAM.app'
        resources = app / 'Contents' / 'Resources'
        resources.mkdir(parents=True)
        python = add_runtime(resources)
        if source:
            run(python, '-B', '-c',
                'import sys; from pathlib import Path; from prepare_editor_macos import prepare_editor; '
                'prepare_editor(*map(Path, sys.argv[1:]))',
                source, resources / 'HX Edit.app', work, cwd=ROOT)
        add_gadget(resources / 'gadget.dylib', work)
        add_converter(resources / 'helix-lt-nam', checkout)
        for name in APP_FILES:
            shutil.copyfile(ROOT / name, resources / name)
        browser = resources / 'tone-browser-macos.dylib'
        run('/usr/bin/clang', '-arch', 'arm64', '-mmacosx-version-min=11.0', '-fobjc-arc',
            '-framework', 'Cocoa', '-framework', 'WebKit', '-dynamiclib',
            ROOT / 'tone_browser_macos.m', '-o', browser)
        run('/usr/bin/codesign', '--force', '--sign', '-', browser)
        plist = {}
        if source:
            icon = resources / 'HX Edit.app' / 'Contents' / 'Resources' / 'AppIcon.icns'
            shutil.copyfile(icon, resources / icon.name)
            plist['CFBundleIconFile'] = icon.name
        executable = app / 'Contents' / 'MacOS' / 'HX Edit NAM'
        executable.parent.mkdir()
        run('/usr/bin/clang', '-arch', 'arm64', '-mmacosx-version-min=11.0', '-fobjc-arc',
            '-framework', 'Cocoa', ROOT / 'macos-launcher.m', '-o', executable)
        (app / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleExecutable': executable.name, 'CFBundleIdentifier': 'com.andreidevs.hxeditnam',
            **plist, 'CFBundleName': 'HX Edit NAM', 'CFBundlePackageType': 'APPL',
            'CFBundleShortVersionString': release_version[1:] if release_version else '3.82',
            'CFBundleVersion': '1', 'LSMinimumSystemVersion': '11.0',
            'LSUIElement': True,
        }))
        run('/usr/bin/codesign', '--force', '--sign', '-', app)
        run('/usr/bin/codesign', '--verify', '--deep', '--strict', app)
        if release_version:
            archive = work / f'HX-Edit-NAM-{release_version}-macOS-arm64.zip'
            run('/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', app, archive)
            run('/usr/bin/unzip', '-tq', archive)
            return archive.replace(BUILD / archive.name)

        output = BUILD / app.name
        previous = work / 'previous.app'
        if output.exists():
            output.rename(previous)
        try:
            app.rename(output)
        except OSError:
            if previous.exists():
                previous.rename(output)
            raise
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', nargs='?', type=Path, help='Local HX Edit 3.82 app, PKG or DMG')
    parser.add_argument('--release-version', help='Package the launcher without HX Edit for a release, such as v0.2.0')
    parser.add_argument('--firmware-checkout', type=Path, help='Use a local helix-lt-nam git checkout')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        parser.error('Run on an Apple Silicon Mac using native Python.')
    if not shutil.which('uv'):
        parser.error('Install uv to bundle the Python runtime.')
    if bool(args.source) == bool(args.release_version):
        parser.error('Specify either a local HX Edit source or --release-version.')
    if args.release_version and not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', args.release_version):
        parser.error('Specify a release version such as v0.2.0.')
    source = args.source.expanduser().resolve(strict=True) if args.source else None
    print(package(source, args.firmware_checkout, args.release_version))
