"""Build the Helix LT/Floor NAM catalog from the local HX Edit 3.82 resources."""

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
from xml.etree import ElementTree as ET

import msgpack


ROOT = Path(__file__).resolve().parent
EXE_HASH = 'f7faac4996164f9039c9ae3ca8d85cd135c5bceae8a511c8921a1244046cab66'
NAM_SYMBOL = 'HD2_AmpNAMLite'
NAM_ID = 380
# Devices whose 3.80.0 NAM builds use model 380: Helix LT (helix-lt-nam) and Helix Floor
# (savedadodo/helix-floor-nam-lite).
DEVICE_IDS = (0x00210004, 0x00210001)


def nul(value):
    return value + '\0'


def patch_catalog(resources):
    symbols_path = resources / 'Helix.sym'
    definitions_path = resources / 'HelixModelDefs.bin'
    catalog_path = resources / 'HX_ModelCatalog.bin'

    symbols = json.loads(symbols_path.read_bytes())
    if symbols[NAM_ID]['symbol'] != 'HelixPlugin_AppDSPFlow1Input':
        raise ValueError('Unexpected HX Edit symbol table at model ID 380.')

    definitions = msgpack.unpackb(definitions_path.read_bytes())
    by_symbol = {model['symbolicID\0']: model for model in definitions}
    model = copy.deepcopy(by_symbol['HD2_AmpLine6Clarity\0'])
    amp_params = {p['symbolicID\0']: p for p in model['params\0']}
    slot = dict(by_symbol['HD2_ImpulseResponse1024\0']['params\0'][0])
    slot['name\0'] = 'Model\0'
    polarity = next(p for p in by_symbol['HD2_PreampVintagePre\0']['params\0']
                    if p['symbolicID\0'] == 'Polarity\0')
    parameters = [slot]
    for name in ('Drive', 'Bass', 'Mid', 'Treble', 'Presence', 'ChVol'):
        parameter = amp_params[nul(name)]
        parameter['default\0'] = 0.5
        if name == 'Drive':
            parameter['name\0'] = 'Input\0'
        parameters.append(parameter)
    parameters.append(polarity)
    symbols[NAM_ID] = {
        'symbol': NAM_SYMBOL,
        'parameters': [p['symbolicID\0'].rstrip('\0') for p in parameters],
    }
    model['name\0'] = 'NAM A2 Lite\0'
    model['symbolicID\0'] = nul(NAM_SYMBOL)
    model['load\0'] = 36.0
    model['devices\0'] = [{'id\0': device, 'version\0': '0x03800000\0'} for device in DEVICE_IDS]
    model['params\0'] = parameters + [amp_params['@enabled\0'], amp_params['@bypassvolume\0']]
    del model['cablink\0'], model['ircablink\0']
    definitions.append(model)

    catalog = msgpack.unpackb(catalog_path.read_bytes())
    amp = next(c for c in catalog['categories\0'] if c['name\0'] == 'Amp\0')
    folders = amp['subcategories\0']
    guitar = next(c for c in folders if c['name\0'] == 'Guitar\0')
    tile = next(m for m in guitar['models\0'] if m['id\0'] == 'HD2_AmpLine6Clarity\0')
    folders.append({'id\0': max(c['id\0'] for c in folders) + 1, 'name\0': 'NAM\0', 'models\0': [{
        'id\0': nul(NAM_SYMBOL),
        'name\0': model['name\0'],
        'image\0': tile['image\0'],
        'params\0': [{p['symbolicID\0']: p['name\0']} for p in parameters],
    }]})

    symbols_path.write_text(json.dumps(symbols, indent=2) + '\n', encoding='utf-8')
    definitions_path.write_bytes(msgpack.packb(definitions, use_single_float=True))
    catalog_path.write_bytes(msgpack.packb(catalog, use_single_float=True))


def patch_library(resources, scan_error):
    path = resources / 'librarian.xml'
    tree = ET.parse(path)
    library = tree.getroot().find("panel_widget[@id='livw']")
    tabs = library.find("radio_widget[@id='lbtb']")
    button = copy.deepcopy(tabs.find("radio_button_widget[@id='2']"))
    button.set('id', '4')
    button.set('name', 'NAM Profiles Button')
    button.find('text/label').text = 'NAM'
    tabs.find("radio_button_widget[@id='3']/corner_radius").set('tr', 'no')
    button.find('corner_radius').set('tr', 'yes')
    tabs.append(button)
    for tab in tabs.findall('radio_button_widget'):
        tab.find('text/font').set('size', '11')
        tab.find('icon_placement').set('spacing', '2')

    view = copy.deepcopy(library.find("panel_widget[@id='irvw']"))
    view.attrib.update(id='namv', name='NAM Profiles')
    view.remove(view.find("panel_widget[@id='^ipr']"))
    group = view.find("panel_widget[@id='irgp']")
    group.attrib.update(id='nmgp', name='NAM Group')
    frame = group.find('panel_widget')
    toolbar = frame.find("panel_widget[@id='ibar']")
    toolbar.set('id', 'nbar')
    for action, left in zip(toolbar.findall('pushbutton_widget'), (12, 48, 86, 128, 170)):
        action.set('id', 'n' + action.get('id')[1:])
        action.set('left', str(left))
    for left in (47, 85, 127, 169):
        divider = ET.SubElement(toolbar, 'panel_widget', left=str(left), top='9', width='1', height='11')
        ET.SubElement(divider, 'bg_color').text = '0xFF393939'
    rows = frame.find("listbox_widget[@id='ilst']")
    rows.attrib.update(id='nlst', name='NAM Listbox')
    message = ET.fromstring('''
        <text_widget height="1" id="nmsg" left="8" top="34" width="1">
            <anchor_pos left="8" right="8" top="34" bottom="8"/>
            <visible>no</visible>
            <text><label/><font name="Roboto" size="12"/><align horz="left" vert="top"/>
                <multiline>yes</multiline><text_color>0xFFC4C4C4</text_color></text>
        </text_widget>
    ''')
    status = ('Connect your Helix and restart to scan profiles.' if scan_error
              else 'No NAM profiles on this Helix.')
    message.find('text/label').text = status + '\nUse Import to add a profile to a free slot.'
    frame.append(message)
    library.append(view)
    tree.write(path, encoding='utf-8')


def prepare_copy(working_directory, scan_error=False):
    baseline = ROOT / 'build' / 'HX Edit'
    if not (baseline / 'HX Edit.exe').is_file():
        program_files = Path(os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)'))
        installed = program_files / 'Line6' / 'HX Edit'
        baseline = Path(os.environ.get('HX_EDIT_SOURCE_DIRECTORY') or installed)
    source_exe = baseline / 'HX Edit.exe'
    if not source_exe.is_file():
        raise FileNotFoundError('Install Line 6 HX Edit 3.82. If it is installed outside the default folder, '
                                'set HX_EDIT_SOURCE_DIRECTORY to its installation directory.')
    if hashlib.sha256(source_exe.read_bytes()).hexdigest() != EXE_HASH:
        raise ValueError('The baseline executable does not match HX Edit 3.82.')
    destination = Path(working_directory) / 'HX Edit NAM'
    shutil.copytree(baseline, destination, ignore=shutil.ignore_patterns('HX Edit Uninstaller.exe'))
    exe = destination / 'HX Edit NAM.exe'
    (destination / source_exe.name).rename(exe)
    patch_catalog(destination / 'res')
    patch_library(destination / 'res', scan_error)
    return exe
