"""Package HX Edit NAM with the Windows x64 embeddable Python and WebView2 helper."""

import argparse
from hashlib import sha256
from io import BytesIO
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from zipfile import ZipFile

from tone_browser import ROOT, SDK_ASSETS, browser_sdk, prepare_browser


PYTHON_VERSION = '3.13.17'
PYTHON_SHA256 = '9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38'
FIRMWARE_REV = 'c94834768546393420692794fdbb27c9cc31d718'
APP_FILES = (
    'start-hx-edit-nam.pyw', 'nam_catalog.py', 'nam_convert.py', 'nam_import.js', 'nam_inventory.py',
    'nam_view.js', 'nam_library.py', 'library_card.html', 'tone3000.py', 'tone_browser.py', 'tone_card.html',
    'tone_preview.py', 'tone_view.js',
)
FIRMWARE_FILES = (
    'LICENSE', 'tools/nam2ir.py', 'tools/hx_ctl.py', 'tools/hx_dfu_reboot.py',
    'tools/sharc/nam_lite.py', 'tools/sharc/nam_pack.py', 'tools/sharc/sasm.py',
    'tools/sharc/ssim.py', 'tools/sharc/recips_table.json',
)


def add_runtime(destination):
    url = f'https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip'
    with urlopen(url, timeout=30) as response:
        archive = response.read(16 * 1024 * 1024 + 1)
    if sha256(archive).hexdigest() != PYTHON_SHA256:
        raise RuntimeError('The embeddable Python archive does not match the published checksum.')
    with ZipFile(BytesIO(archive)) as package:
        package.extractall(destination)
    (destination / 'python313._pth').write_text('python313.zip\n.\nLib/site-packages\n../app\n', encoding='ascii')
    subprocess.run(
        [sys.executable, '-m', 'pip', 'install', '--only-binary=:all:', '--no-compile', '--no-deps',
         '--platform', 'win_amd64', '--python-version', '3.13', '--target', str(destination / 'Lib/site-packages'),
         'frida==17.5.2', 'msgpack==1.2.4'],
        check=True,
    )


def package_windows(version):
    build = ROOT / 'build'
    helper = prepare_browser()
    package_name = f'HX-Edit-NAM-{version}-Windows-x64'
    with TemporaryDirectory(prefix='release-', dir=build) as folder:
        stage = Path(folder) / package_name
        app = stage / 'app'
        app.mkdir(parents=True)
        for name in APP_FILES:
            shutil.copyfile(ROOT / name, app / name)
        shutil.copyfile(ROOT / 'README.md', stage / 'README.md')
        browser = app / 'build' / helper.parent.name
        browser.mkdir(parents=True)
        for name in (helper.name, *(Path(asset).name for asset in SDK_ASSETS)):
            shutil.copyfile(helper.parent / name, browser / name)
        with browser_sdk() as sdk:
            for name in ('LICENSE.txt', 'NOTICE.txt'):
                (browser / name).write_bytes(sdk.read(name))

        firmware = ROOT.parent / 'helix-lt-nam'
        for name in FIRMWARE_FILES:
            destination = stage / 'helix-lt-nam' / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(subprocess.check_output(
                ['git', '-C', str(firmware), 'show', f'{FIRMWARE_REV}:{name}']))
        (stage / 'helix-lt-nam' / 'UPSTREAM.txt').write_text(
            f'https://github.com/andreidevs/helix-lt-nam/tree/{FIRMWARE_REV}\n', encoding='ascii')

        add_runtime(stage / 'runtime')
        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
        subprocess.run(
            [str(compiler), '/nologo', '/target:winexe', '/platform:x64', '/reference:System.Windows.Forms.dll',
             f'/out:{stage / "HX Edit NAM.exe"}', str(ROOT / 'windows-launcher.cs')],
            check=True,
        )
        archive = Path(shutil.make_archive(str(Path(folder) / package_name), 'zip', folder, package_name))
        output = build / archive.name
        archive.replace(output)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', help='Release version such as v0.1.0')
    args = parser.parse_args()
    if os.name != 'nt' or not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', args.version):
        parser.error('Run on Windows and specify a version such as v0.1.0.')
    print(package_windows(args.version))
