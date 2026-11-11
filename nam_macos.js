'use strict';

// TONE3000 auditions always use the last User IR; NAM imports and saves stay in 1–127.
const AUDITION_SLOT = 128;

// HX Edit 3.82 arm64. The builder verifies the original Mach-O before patching it.
function installNamMac(profiles, scanFailed) {
  if (Process.arch !== 'arm64' || Process.platform !== 'darwin') {
    throw new Error('Expected the native Apple Silicon HX Edit executable.');
  }
  const base = Process.mainModule.base;
  const at = offset => base.add(offset);
  const native = (offset, result, types = []) => {
    const call = new NativeFunction(at(offset), result, ['pointer', ...types]);
    return types.includes('bool') ? (self, ...args) => call(self, ...args.map(value =>
      typeof value === 'boolean' ? Number(value) : value)) : call;
  };
  const hook = (offset, callbacks) => Interceptor.attach(at(offset), callbacks);
  const id = name => [...name].reduce((value, char) => value * 256 + char.charCodeAt(0), 0);
  const tabIDs = ['prvw', 'irvw', 'fvvw', 'namv'].map(id);
  const actions = ['copy', 'paste', 'import', 'export', 'clear'];
  const buttonIDs = ['ncop', 'npas', 'nimp', 'nexp', 'nclr'].map(id);

  const find = native(0x511fc8, 'pointer', ['uint', 'bool']); // XGWidget::FindChild
  const getID = native(0x511fb0, 'uint');
  const setID = native(0x511fbc, 'void', ['uint']);
  const show = native(0x515168, 'void', ['bool', 'bool']);
  const enable = native(0x514ddc, 'void', ['bool', 'bool']);
  const redraw = native(0x513644, 'void');
  const parent = native(0x512178, 'pointer');
  const visible = native(0x5128d0, 'bool', ['bool']);
  const getValue = native(0x514734, 'int');
  const setValue = native(0x51470c, 'void', ['int', 'bool', 'bool']);
  const setText = native(0x499f04, 'void', ['pointer', 'bool']);
  const getText = native(0x49a13c, 'pointer');
  const getItem = native(0x271ef4, 'pointer', ['uint']); // XGListBoxWidget::GetItemByIndex
  const selected = native(0x272a4c, 'pointer');
  const clearSelection = native(0x2725ec, 'void', ['bool', 'bool']);
  const selectItem = native(0x272cc0, 'bool', ['bool', 'int', 'bool', 'bool']);
  const singleSelection = native(0x2725c4, 'void', ['int', 'bool', 'bool']);
  const clearItems = native(0x272174, 'void', ['bool']);
  const appendItem = native(0x271af8, 'void', ['int', 'pointer', 'pointer', 'uint', 'int', 'pointer', 'uint', 'bool']);
  const setupMenu = native(0x387f68, 'void'); // HXSliderParamView::setupMenu
  const displayType = native(0x5ae3a4, 'pointer');
  const modelNotify = native(0x38b2a4, 'void', ['uint', 'pointer', 'pointer']);
  const selectIR = native(0x775aa4, 'void'); // HXIRViewController::UpdateSelectedItems
  const copyIR = native(0x776950, 'void');
  const pasteIR = native(0x776a5c, 'void', ['pointer', 'int']);
  const chooseIR = native(0x775b20, 'void');
  const exportIR = native(0x775fb4, 'void');
  const clearIR = native(0x7774d0, 'void');
  const assignString = native(0x1baac, 'pointer', ['pointer']); // L6String::operator=(char const*)
  const destroyString = native(0x3610, 'void');
  const importTone = native(0x66421c, 'void', ['uint', 'pointer']); // L6HelixLibrarianWorker::importIRs
  const clearTone = native(0x663080, 'void', ['pointer']);

  const pending = new Map();
  let library = NULL, controller = NULL, list = NULL, namList = NULL, panel = NULL, model = NULL;
  let tab = 0, slots = [], buttons = [], importDialog = false;
  let audition = null;
  const reserved = new Set();
  const string = value => {
    const storage = value.add(8).readPointer();
    return storage.isNull() ? '' : storage.add(0x10).readPointer().readUtf8String();
  };
  const rowSlot = row => row.isNull() ? 0 : row.add(0x100).readS32() + 1;
  const occupied = row => !row.isNull() && !row.add(0x118).readPointer().isNull();
  const irRow = slot => list.isNull() || slot < 1 ? NULL : getItem(list, slot - 1);
  const hasProfile = slot => {
    const row = irRow(slot);
    return occupied(row) && profiles[slot] === row.readUtf8String();
  };

  function firstFree(count) {
    let run = 0;
    for (let slot = 1; slot < AUDITION_SLOT; slot++) {
      const row = irRow(slot);
      run = !row.isNull() && !occupied(row) && !pending.has(slot) && !reserved.has(slot) ? run + 1 : 0;
      if (run === count) return slot - run + 1;
    }
    return 0;
  }

  function copiedSlot() {
    if (controller.isNull()) return 0;
    const begin = controller.add(0xa4).readU32();
    const end = controller.add(0xa8).readU32();
    const items = controller.add(0x98).readPointer();
    if (end - begin !== 1 || items.isNull()) return 0;
    const slot = items.add(begin * 4).readU32() + 1;
    return hasProfile(slot) ? slot : 0;
  }

  function refreshButtons() {
    if (namList.isNull()) return;
    const hasSelection = hasProfile(rowSlot(selected(namList)));
    const free = firstFree(1) > 0;
    const enabled = [hasSelection, free && !!copiedSlot(), free, hasSelection, hasSelection];
    buttons.forEach((button, index) => {
      if (!button.isNull()) enable(button, enabled[index], true);
    });
  }

  function activeModel() {
    return !model.isNull() && !parent(model).isNull() && visible(model, true);
  }

  function setModelSlot(slot) {
    if (!activeModel()) return false;
    const popup = model.add(0x1f0).readPointer();
    if (popup.isNull()) return false;
    if (getValue(model) !== slot - 1) {
      setValue(popup, slot - 1, false, false);
      modelNotify(model, id('!avc'), popup, NULL);
    }
    return true;
  }

  function syncModel() {
    if (namList.isNull()) return;
    const index = activeModel() ? slots.indexOf(getValue(model) + 1) : -1;
    clearSelection(namList, false, false);
    if (index >= 0) selectItem(namList, true, index, false, true);
    refreshButtons();
  }

  function render() {
    if (namList.isNull()) return;
    const previous = rowSlot(selected(namList));
    slots = Object.keys(profiles).map(Number).sort((a, b) => a - b);
    clearItems(namList, false);
    for (const slot of slots) {
      appendItem(namList, -1, Memory.allocUtf8String(profiles[slot]), NULL, 0, slot - 1, ptr(1), 0, false);
    }
    const status = find(panel, id('nmsg'), true);
    if (!status.isNull()) {
      if (scanFailed) {
        setText(status, Memory.allocUtf8String('Connect your Helix and restart to scan profiles.'), false);
      }
      show(status, slots.length === 0, true);
    }
    if (activeModel()) syncModel();
    else if (slots.includes(previous)) selectItem(namList, true, slots.indexOf(previous), false, true);
    redraw(namList);
    refreshButtons();
  }

  function refreshProfiles() {
    if (list.isNull()) return;
    let changed = false;
    for (const [slot, expected] of pending) {
      const row = irRow(slot);
      if (!occupied(row)) continue;
      const name = row.readUtf8String();
      if (name !== expected && !(name.length >= 31 && expected.startsWith(name))) continue;
      pending.delete(slot);
      profiles[slot] = name;
      changed = true;
    }
    for (const slot of Object.keys(profiles)) {
      const row = irRow(Number(slot));
      if (row.isNull() || profiles[slot] === row.readUtf8String()) continue;
      delete profiles[slot];
      changed = true;
    }
    if (changed) {
      render();
      if (activeModel()) setupMenu(model);
    }
    refreshButtons();
  }

  function chooseSlot(slot) {
    clearSelection(list, false, false);
    selectItem(list, true, slot - 1, false, false);
    selectIR(controller);
  }

  function runAction(action) {
    if (list.isNull()) return;
    if (action === 'import' || action === 'paste') {
      const slot = firstFree(1);
      if (!slot) return;
      if (action === 'import') {
        chooseSlot(slot);
        chooseIR(controller);
      } else {
        const source = copiedSlot();
        if (!source) return;
        pending.set(slot, profiles[source]);
        pasteIR(controller, controller.add(0x88), slot - 1);
      }
    } else {
      const slot = rowSlot(selected(namList));
      if (!hasProfile(slot)) return;
      chooseSlot(slot);
      ({copy: copyIR, export: exportIR, clear: clearIR})[action](controller);
    }
    refreshButtons();
  }

  hook(0x7a4928, { // HXWidgetFactory::CreateXGListBoxWidget
    onEnter(args) {
      this.nam = args[1].toUInt32() === id('nlst');
      if (this.nam) args[1] = ptr(id('ilst'));
    },
    onLeave(widget) {
      if (this.nam && !widget.isNull()) setID(widget, id('nlst'));
    },
  });
  hook(0x51474c, { // Three controllers are passed by the stock librarian constructor.
    onEnter() { this.binding = this.returnAddress.equals(at(0x419328)) && getID(this.context.x0) === id('lbtb'); },
    onLeave(result) { if (this.binding && result.toInt32() === 3) result.replace(2); },
  });

  function applyTab(index) {
    tab = index;
    for (const [i, widgetID] of tabIDs.entries()) {
      const view = find(library, widgetID, true);
      if (!view.isNull()) show(view, i === tab, true);
    }
    if (tab === 3) syncModel();
  }

  hook(0x6a0fa4, { // HXLibrarianViewController constructor
    onEnter(args) { this.instance = args[0]; this.view = args[2]; },
    onLeave() {
      if (this.view.isNull()) return;
      library = this.view;
      controller = this.instance.add(0xa8).readPointer();
      list = controller.isNull() ? NULL : controller.add(0x70).readPointer();
      panel = find(library, id('namv'), true);
      namList = panel.isNull() ? NULL : find(panel, id('nlst'), true);
      if (!namList.isNull()) {
        singleSelection(namList, 1, false, false);
        buttons = buttonIDs.map(button => find(panel, button, true));
        render();
      }
      applyTab(0);
    },
  });
  hook(0x646db8, {
    onEnter(args) { if (args[0].equals(namList)) { namList = NULL; library = NULL; } },
  });
  hook(0x774b54, {
    onEnter(args) {
      if (!args[0].equals(controller)) return;
      controller = NULL;
      list = NULL;
      pending.clear();
      reserved.clear();
      audition = null;
    },
  });
  hook(0x64722c, { // HXLibrarianListBox::DrawItem uses the visible index for IR numbering.
    onEnter(args) {
      if (args[0].equals(namList) && !args[3].isNull()) args[4] = ptr(rowSlot(args[3]) - 1);
    },
  });
  hook(0x4195bc, { // L6TabViewController::setActiveTab, also called by inlined subclass handlers.
    onEnter(args) {
      if (library.isNull() || !args[0].add(0x20).readPointer().equals(library)) return;
      this.index = args[1].toInt32();
    },
    onLeave() {
      if (this.index >= 0 && this.index < tabIDs.length && !library.isNull()) applyTab(this.index);
    },
  });

  hook(0x518834, { // XGWidget::SignalWidgetNotification
    onEnter(args) {
      this.action = args[1].toUInt32() === id('!bp_') ? buttons.findIndex(b => b.equals(args[0])) : -1;
      this.selection = args[1].toUInt32() === id('!lbs') && args[0].equals(namList);
    },
    onLeave() {
      if (this.action >= 0 && tab === 3) runAction(actions[this.action]);
      if (!this.selection) return;
      const slot = rowSlot(selected(namList));
      if (hasProfile(slot)) setModelSlot(slot);
    },
  });
  hook(0x77c1e4, { // HXIRViewController::HandleEdLibNotification
    onEnter(args) { this.ours = args[0].equals(controller); },
    onLeave() { if (this.ours) refreshProfiles(); },
  });
  hook(0x77867c, { // HXIRViewController::handleIrImportResults
    onEnter(args) { this.ours = args[0].equals(controller); },
    onLeave() {
      if (!this.ours) return;
      refreshProfiles();
      pending.clear();
      refreshButtons();
    },
  });
  hook(0x7748d0, { onLeave() { refreshButtons(); } });

  const menuSetup = new Map();
  const insertMenu = native(0x557010, 'pointer', ['int', 'pointer', 'int', 'pointer', 'uint']);
  hook(0x387f68, {
    onEnter(args) {
      const slider = args[0], label = slider.add(0xa0).readPointer();
      if (label.isNull() || getText(label).readUtf8String() !== 'Model'
          || string(displayType(slider)) !== 'ir_select') return;
      this.slider = slider;
      menuSetup.set(this.threadId, {menu: slider.add(0x1f0).readPointer(), count: 0});
    },
    onLeave() {
      if (!this.slider) return;
      menuSetup.delete(this.threadId);
      model = this.slider;
      syncModel();
    },
  });
  const empty = Memory.allocUtf8String('No NAM profiles. Import one from NAM.');
  Interceptor.replace(at(0x557010), new NativeCallback(function (menu, index, text, item, data, flags) {
    const state = menuSetup.get(this.threadId);
    if (!state || !menu.equals(state.menu) || text.isNull()) return insertMenu(menu, index, text, item, data, flags);
    const match = text.readUtf8String().match(/^(\d+): (.+)$/);
    if (!match) return insertMenu(menu, index, text, item, data, flags);
    if (profiles[match[1]] === match[2]) return insertMenu(menu, index, text, item, data, flags);
    if (audition && audition.slider.equals(model) && Number(match[1]) === audition.slot &&
        match[2] === audition.name) return insertMenu(menu, index, text, item, data, flags);
    if (!Object.keys(profiles).length && state.count++ === 0) return insertMenu(menu, index, empty, item, data, 1);
    return NULL;
  }, 'pointer', ['pointer', 'int', 'pointer', 'int', 'pointer', 'uint']));
  hook(0x38729c, {
    onEnter(args) { if (args[0].equals(model)) model = NULL; },
  });
  hook(0x38b570, {
    onEnter(args) { this.model = args[0].equals(model); },
    onLeave() { if (this.model) syncModel(); },
  });

  function request(payload) {
    let result;
    send(payload);
    recv('converted', message => { result = message.payload; }).wait();
    if (result.error) throw new Error(result.error);
    return result;
  }

  const namExtensions = Memory.allocUtf8String('nam|wav');
  const irExtensions = Memory.allocUtf8String('wav|hir|nam');
  hook(0x276dec, { // L6ViewController::doFileDialog
    onEnter(args) {
      if (!this.returnAddress.equals(at(0x775dec))) return;
      const filter = args[1].add(0x20);
      this.filter = filter;
      this.previous = filter.readPointer();
      filter.writePointer(tab === 3 ? namExtensions : irExtensions);
    },
    onLeave() { if (this.filter) this.filter.writePointer(this.previous); },
  });
  hook(0x780148, { // HXIRViewController::fileDialogEnded_UIThread
    onEnter(args) { importDialog = args[1].toInt32() === 0 && tab === 3; },
    onLeave() { importDialog = false; },
  });

  const importIR = native(0x77dc4c, 'void', ['pointer', 'int']);
  Interceptor.replace(at(0x77dc4c), new NativeCallback(function (instance, batch, first) {
    try {
      const data = batch.add(0x10).readPointer();
      const begin = batch.add(0x1c).readU32(), end = batch.add(0x20).readU32();
      const count = end - begin;
      if (!count) return;
      if (data.isNull() || count < 0 || count > 128 || !instance.equals(controller)) {
        throw new Error('Could not read the file selection or the User IR slots.');
      }
      if (importDialog) first = firstFree(count) - 1;
      if (first < 0 || first + count > 128) throw new Error('Select enough consecutive free User IR slots.');
      const entries = Array.from({length: count}, (_, i) => data.add((begin + i) * 16));
      const occupiedSlots = [];
      for (let i = 0; i < count; i++) {
        const row = irRow(first + i + 1);
        if (row.isNull()) throw new Error('Could not read the destination User IR slot.');
        if (occupied(row) || pending.has(first + i + 1) || reserved.has(first + i + 1)) {
          occupiedSlots.push(first + i + 1);
        }
      }
      let files = entries.map(string);
      if (files.some(file => /\.nam$/i.test(file))) files = request({type: 'convert', files}).files;
      const result = request({type: 'validateImport', files, firstSlot: first + 1, occupied: occupiedSlots,
        namOnly: importDialog});
      files.forEach((file, index) => assignString(entries[index], Memory.allocUtf8String(file)));
      for (const [slot, name] of Object.entries(result.profiles)) pending.set(Number(slot), name);
    } catch (error) {
      send({type: 'importError', message: String(error.message)});
      return;
    }
    importIR(instance, batch, first);
  }, 'void', ['pointer', 'pointer', 'int']));

  function worker() {
    return controller.isNull() ? NULL : controller.add(0x4c8).readPointer();
  }

  function slotEmpty(slot) {
    const row = irRow(slot);
    return !row.isNull() && !occupied(row) && !pending.has(slot);
  }

  function previewName(transfer) {
    if (!worker().equals(transfer.worker) || !controller.equals(transfer.controller)) return '';
    const row = irRow(transfer.slot);
    return occupied(row) && row.readUtf8String() === transfer.name ? transfer.name : '';
  }

  function singleItemArray(vtable, item) {
    const array = Memory.alloc(40);
    array.writePointer(at(vtable));
    array.add(8).writeU32(1);
    array.add(0x10).writePointer(item);
    array.add(0x18).writeU32(1);
    array.add(0x20).writeU32(1);
    return array;
  }

  return {
    modelSlot: () => activeModel() ? getValue(model) + 1 : null,
    freeSlots: () => Array.from({length: AUDITION_SLOT - 1}, (_, index) => index + 1)
      .filter(slot => slotEmpty(slot) && !reserved.has(slot)),
    auditionSlotEmpty: () => slotEmpty(AUDITION_SLOT) && !reserved.has(AUDITION_SLOT),
    importPreview(file, slot, audition) {
      const librarian = worker();
      if (librarian.isNull() || !slotEmpty(slot) || reserved.has(slot)) {
        throw new Error('Choose an empty User IR slot on the connected Helix.');
      }
      // The native importer deletes files in the temporary directory after reading them.
      const staged = request({type: 'stageTone', file, audition}).file;
      const name = staged.split('/').at(-1).replace(/\.wav$/, '');
      if (!/^[\x20-\x7e]{1,31}$/.test(name)) throw new Error('Invalid TONE3000 profile name.');
      const transfer = {controller, worker: librarian, file, slot, name};
      const string = Memory.alloc(16);
      string.writePointer(at(0xa7c650)); // L6String vtable
      assignString(string, Memory.allocUtf8String(staged));
      reserved.add(slot);
      try {
        importTone(librarian, slot - 1, singleItemArray(0xa7c8d8, string));
      } catch (error) {
        reserved.delete(slot);
        throw error;
      } finally {
        destroyString(string);
      }
      return transfer;
    },
    previewName,
    release(transfer) { reserved.delete(transfer.slot); },
    previewSlotEmpty: transfer => worker().equals(transfer.worker) && controller.equals(transfer.controller) &&
      slotEmpty(transfer.slot),
    clearPreview(transfer) {
      if (!previewName(transfer)) return false;
      const index = Memory.alloc(4);
      index.writeU32(transfer.slot - 1);
      clearTone(transfer.worker, singleItemArray(0xa82310, index));
      return true;
    },
    playPreview(transfer) {
      if (!previewName(transfer) || !activeModel()) return false;
      audition = {slider: model, slot: transfer.slot, name: transfer.name};
      setupMenu(model);
      return setModelSlot(transfer.slot);
    },
    stopPreview() {
      if (!audition) return;
      audition = null;
      if (activeModel()) setupMenu(model);
    },
    registerProfile(transfer) {
      if (!previewName(transfer)) return false;
      profiles[transfer.slot] = transfer.name;
      render();
      if (activeModel()) setupMenu(model);
      return true;
    },
    selectProfile: transfer => !!previewName(transfer) && setModelSlot(transfer.slot),
  };
}
