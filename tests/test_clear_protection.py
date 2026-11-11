"""presetIrSlots from nam_view.js on synthetic preset trees; needs Node.js, no device."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / 'nam_view.js').read_text(encoding='utf-8')
FUNCTION = re.search(r'^function presetIrSlots.*?^}$', SOURCE, re.S | re.M).group(0)
CATALOG = {'HD2_ImpulseResponse1024': ['Index'], 'HD2_AmpNAMLite': ['Index'], 'HD2_Comp': []}


def run(tree):
    script = (f'{FUNCTION}\nconst r = presetIrSlots({json.dumps(tree)}, {json.dumps(CATALOG)});'
              'console.log(JSON.stringify(r.slots ? {slots: [...r.slots].sort((a, b) => a - b)} : r));')
    return json.loads(subprocess.run(['node', '-e', script], capture_output=True, text=True, check=True).stdout)


def preset(**blocks):
    return {'global': {'@topology0': 'A'}, 'dsp0': blocks, 'dsp1': {},
            'globalNodes': {'snapshot0': {'@name': 'A', 'blocks': {'dsp0': {'b0': True}}}, 'global': {}}}


@unittest.skipUnless(shutil.which('node'), 'Node.js is not installed')
class ClearProtectionTests(unittest.TestCase):
    def test_collects_slots_from_ir_and_nam_blocks(self):
        tree = preset(b0={'@model': 'HD2_ImpulseResponse1024Mono', 'Index': 5},
                      b1={'@model': 'HD2_AmpNAMLite', 'Index': 12}, b2={'@model': 'HD2_Comp', 'Level': 0.5})
        self.assertEqual(run(tree), {'slots': [5, 12]})

    def test_unknown_models_and_snapshot_values_fail_closed(self):
        self.assertEqual(run(preset(b0={'@model': 'HD2_Mystery'}))['reason'], 'unknown-model')
        self.assertEqual(run(preset(b0={'@model': 'HelixPlugin_AppDSPFlow1Input'}))['reason'], 'unknown-block')
        tree = preset(b0={'@model': 'HD2_Comp'})
        tree['globalNodes']['snapshot0']['controllers'] = {'dsp0': {}}
        self.assertEqual(run(tree)['reason'], 'unsupported-snapshot-values')
        self.assertEqual(run(preset())['reason'], 'empty-signal-flow')


if __name__ == '__main__':
    unittest.main()
