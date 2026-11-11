"""Build the NAM catalog from the local HX Edit 3.82 resources."""

import copy
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
from xml.etree import ElementTree as ET

import msgpack

from nam_inventory import HX_NAM_DEVICES


ROOT = Path(__file__).resolve().parent
EXE_HASH = 'f7faac4996164f9039c9ae3ca8d85cd135c5bceae8a511c8921a1244046cab66'
NAM_SYMBOL = 'HD2_AmpNAMLite'
NAM_ID = 380
HX_NAM_ID = 555
HX_NAM_SYMBOL = 'HD2_DistNAMLite'
DEVICE_IDS = (0x00210004, 0x00210001)  # Helix LT and Helix Floor
SETTINGS = Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'HX Edit NAM' / 'settings.json'
SIDEBAR_WIDTHS = (220, 600)  # Stock width to the widest nam_view.js allows


def nul(value):
    return value + '\0'


def read_custom_names(default_path):
    path = Path(os.environ.get('HX_EDIT_NAM_NAMES') or default_path).expanduser()
    if not path.is_file():
        return {}
    names = {}
    with path.open(newline='', encoding='utf-8-sig') as rows:
        reader = csv.DictReader(rows)
        if not {'internal', 'real_name'}.issubset(reader.fieldnames or ()):
            raise ValueError(f'{path} must have internal and real_name columns.')
        for row in reader:
            symbol = (row['internal'] or '').strip()
            name = (row['real_name'] or '').strip()
            if not symbol or not name:
                continue
            if '\0' in symbol or '\0' in name:
                raise ValueError(f'{path} contains a NUL character on line {reader.line_num}.')
            names[nul(symbol)] = nul(name)
            # HX Edit can share one entry between Mono and Stereo variants.
            for suffix in ('Mono', 'Stereo'):
                if symbol.endswith(suffix):
                    names.setdefault(nul(symbol.removesuffix(suffix)), nul(name))
    names.pop(nul(NAM_SYMBOL), None)
    names.pop(nul(HX_NAM_SYMBOL), None)
    return names


def rename_stock_models(resources, names):
    definitions_path = resources / 'HelixModelDefs.bin'
    catalog_path = resources / 'HX_ModelCatalog.bin'
    definitions = msgpack.unpackb(definitions_path.read_bytes())
    catalog = msgpack.unpackb(catalog_path.read_bytes())
    for model in definitions:
        symbol = model['symbolicID\0']
        if symbol in names:
            model['name\0'] = names[symbol]
    for category in catalog['categories\0']:
        for folder in [category, *category.get('subcategories\0', [])]:
            for model in folder.get('models\0', []):
                if 'name\0' in model and model['id\0'] in names:
                    model['name\0'] = names[model['id\0']]
    definitions_path.write_bytes(msgpack.packb(definitions, use_single_float=True))
    catalog_path.write_bytes(msgpack.packb(catalog, use_single_float=True))


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


def patch_hx_catalog(resources, hx_nam):
    symbols_path = resources / 'Helix.sym'
    definitions_path = resources / 'HelixModelDefs.bin'
    catalog_path = resources / 'HX_ModelCatalog.bin'
    controls_path = resources / 'HelixControls.json'
    symbols = json.loads(symbols_path.read_bytes())
    donor = symbols[HX_NAM_ID]
    if donor['symbol'] != 'HD2_DistXenomorphFuzzMono':
        raise ValueError('Unexpected HX Edit symbol table at model ID 555.')

    definitions = msgpack.unpackb(definitions_path.read_bytes())
    stock_id = 'HD2_DistXenomorphFuzz\0'
    model = copy.deepcopy(next(model for model in definitions if model['symbolicID\0'] == stock_id))
    params = model['params\0'][:10]
    labels = ('Input', 'Treble', 'Output', 'Polarity', 'Bass', 'Mid', 'Model', 'Mid Freq', 'Q', 'High Cut')
    defaults = (0.5, 0.5, 0.5, 0, 0.5, 0.5, 1.0, 650.0, 0, 1.0)
    for param, label, default in zip(params, labels, defaults):
        param['name\0'] = nul(label)
        param['default\0'] = default
    # ID 555 still uses the donor's parameter positions and types on the wire.
    params[3]['displayType\0'] = 'polarity\0'
    params[6].update({'displayType\0': 'ir_select\0', 'min\0': 1.0, 'max\0': 128.0})
    params[7].update({'min\0': 150.0, 'max\0': 3000.0})
    params[8]['displayType\0'] = 'nam_hx_q\0'
    symbols[HX_NAM_ID] = {**donor, 'symbol': HX_NAM_SYMBOL}
    model.update({
        'name\0': 'NAM A2 Lite\0', 'symbolicID\0': nul(HX_NAM_SYMBOL), 'stereo\0': False,
        'load\0': 22.75, 'devices\0': [{'id\0': HX_NAM_DEVICES[hx_nam][1], 'version\0': '0x03800000\0'}],
        'params\0': params + [param for param in model['params\0'] if param['symbolicID\0'] == '@enabled\0'],
    })
    del model['load_stereo\0']
    definitions.append(model)

    catalog = msgpack.unpackb(catalog_path.read_bytes())
    categories = {category['name\0']: category for category in catalog['categories\0']}
    mono, stereo = (next(folder['models\0'] for folder in categories['Distortion\0']['subcategories\0']
                         if folder['name\0'] == name) for name in ('Mono\0', 'Stereo\0'))
    mono_index = next(index for index, tile in enumerate(mono) if tile['id\0'] == stock_id)
    stereo_index = next(index for index, tile in enumerate(stereo) if tile['id\0'] == stock_id)
    stock_tile = mono[mono_index]
    # The stock stereo tile inherits the mono tile, which now has to stand on its own.
    stereo[stereo_index] = stock_tile
    nam_tile = {**stock_tile, 'id\0': nul(HX_NAM_SYMBOL), 'name\0': model['name\0'],
                'params\0': [{p['symbolicID\0']: p['name\0']} for p in params]}
    if hx_nam == 'stomp':
        del mono[mono_index]
        folder = next(folder for folder in categories['Amp\0']['subcategories\0'] if folder['name\0'] == 'NAM\0')
        folder['models\0'] = [nam_tile]
    else:
        mono[mono_index] = nam_tile

    controls = json.loads(controls_path.read_bytes())
    controls['nam_hx_q'] = {'isDiscrete': True, 'controlType': 'segmented', 'format': ['0.7', '1.4', '2.8']}
    controls_path.write_text(json.dumps(controls, indent=2) + '\n', encoding='utf-8')
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
    # nam_view.js shows NAM before Favorites, so Favorites keeps the rounded corner.
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


def ir_parameters(resources):
    """Map every model symbol to its IR-slot parameters; Clear protection fails on unknown models."""
    catalog = {}
    for model in msgpack.unpackb((resources / 'HelixModelDefs.bin').read_bytes()):
        symbol = model['symbolicID\0'].rstrip('\0')
        params = [p['symbolicID\0'].rstrip('\0') for p in model.get('params\0', [])
                  if p.get('displayType\0') == 'ir_select\0']
        if catalog.setdefault(symbol, params) != params:
            raise ValueError(f'Conflicting IR parameters for {symbol}.')
    return catalog


def load_settings():
    try:
        settings = json.loads(SETTINGS.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    return settings if isinstance(settings, dict) else {}


def save_setting(key, value):
    settings = load_settings()
    settings[key] = value
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(settings, indent=2) + '\n', encoding='utf-8')


def sidebar_width():
    width = load_settings().get('sidebarWidth')
    return width if type(width) is int and SIDEBAR_WIDTHS[0] <= width <= SIDEBAR_WIDTHS[1] else 0


def patch_sidebar(resources, width):
    if not width:
        return
    main = resources / 'main.xml'
    tree = ET.parse(main)
    root = tree.getroot()
    placeholder = root.find(".//panel_widget[@id='livw']")
    editor = root.find(".//panel_widget[@id='edvw']/anchor_pos")
    if placeholder is None or editor is None or editor.get('left') != '228':
        raise ValueError('Unexpected HX Edit sidebar layout.')
    placeholder.set('width', str(width))
    editor.set('left', str(width + 8))
    tree.write(main, encoding='utf-8')
    librarian = resources / 'librarian.xml'
    tree = ET.parse(librarian)
    tree.getroot().find("panel_widget[@id='livw']").set('width', str(width))
    tree.write(librarian, encoding='utf-8')


def prepare_copy(working_directory, scan_error=False, *, hx_nam=None):
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
    resources = destination / 'res'
    patch_catalog(resources)
    if hx_nam:
        patch_hx_catalog(resources, hx_nam)
    if names := read_custom_names(ROOT / 'custom-names.csv'):
        rename_stock_models(resources, names)
    patch_library(resources, scan_error)
    patch_sidebar(resources, sidebar_width())
    return exe
