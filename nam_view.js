'use strict';

// HX Edit 3.82 x86, verified by the launcher before these offsets are used.
function installNamView(profiles) {
  const base = Process.mainModule.base;
  const address = rva => base.add(rva);
  const method = (rva, type, args) => new NativeFunction(address(rva), type, ['pointer', ...args], 'thiscall');
  const findWidget = method(0x3b7ae0, 'pointer', ['uint', 'int']);
  const setVisible = method(0x3bcff0, 'void', ['int', 'int']);
  const setEnabled = method(0x3b7940, 'void', ['int', 'int']);
  const redraw = method(0x3baa40, 'void', []);
  const getRadioButton = method(0x389f30, 'pointer', ['uint']);
  const isVisible = method(0x3ba100, 'uint8', ['int']);
  const getParent = method(0x3b8790, 'pointer', []);
  const getValue = method(0x3b8f20, 'int', []);
  const setValue = method(0x3bcb20, 'void', ['int', 'int', 'int']);
  const handleModelEvent = method(0x26b690, 'void', ['uint', 'pointer', 'pointer']);
  const appendRow = method(0x380940, 'void', ['int', 'pointer', 'pointer', 'int', 'int', 'int', 'int', 'int']);
  const getSelectedRows = method(0x3808a0, 'uint', ['pointer', 'uint']);
  const selectRow = method(0x3821d0, 'void', ['int', 'int', 'int', 'int']);
  const clearSelection = method(0x37f690, 'void', ['int', 'int']);
  const clearRows = method(0x37f5b0, 'void', ['int']);
  const refreshIrSelection = method(0x20df60, 'void', []);
  const copyIr = method(0x20afb0, 'void', []);
  const pasteIr = method(0x20b7c0, 'void', ['pointer', 'int']);
  const importIr = method(0x20b4b0, 'void', []);
  const exportIr = method(0x20b080, 'void', []);
  const clearIr = method(0x20aef0, 'void', []);
  const clearIrSlots = method(0x3da2b0, 'void', ['pointer']);
  const rebuildModelMenu = method(0x26e680, 'void', []);
  const libraryViews = [0x70727677, 0x69727677, 0x66767677, 0x6e616d76]; // prvw, irvw, fvvw, namv
  const namListId = 0x6e6c7374; // nlst
  const buttonIds = { copy: 0x6e636f70, paste: 0x6e706173, import: 0x6e696d70,
    export: 0x6e657870, clear: 0x6e636c72 };
  const selectedRow = Memory.alloc(Process.pointerSize);
  const pending = new Map();
  let slots = [];
  let namList = NULL;
  let namPanel = NULL;
  let irController = NULL;
  let activeModel = NULL;
  let audition = null;
  let buttons = {};
  let tab = 0;

  function selectedSlot() {
    if (namList.isNull() || !getSelectedRows(namList, selectedRow, 1)) return 0;
    return selectedRow.readPointer().add(0x100).readS32() + 1;
  }

  function irList() {
    return irController.isNull() ? NULL : irController.add(0x3c).readPointer();
  }

  function hasProfile(list, slot) {
    if (list.isNull() || !Object.hasOwn(profiles, slot)) return false;
    const row = getIrRow(list, slot - 1);
    return !row.isNull() && !!row.add(0x10c).readU32() && row.readUtf8String() === profiles[slot];
  }

  function copiedSlot(list) {
    const start = irController.add(0x58).readU32();
    const end = irController.add(0x5c).readU32();
    const clipboard = irController.add(0x50).readPointer();
    if (end - start !== 1 || clipboard.isNull()) return 0;
    const slot = clipboard.add(start * 4).readU32() + 1;
    return hasProfile(list, slot) ? slot : 0;
  }

  function refreshButtons() {
    if (namPanel.isNull()) return;
    const list = irList();
    const selected = hasProfile(list, selectedSlot());
    const free = firstFreeSlot(list, 1) >= 0;
    const enabled = { copy: selected, paste: free && !!copiedSlot(list),
      import: free && namImportController.isNull(), export: selected, clear: selected };
    for (const [action, button] of Object.entries(buttons)) {
      if (!button.isNull()) setEnabled(button, Number(enabled[action]), 1);
    }
  }

  function selectStockRow(list, index) {
    clearSelection(list, 0, 0);
    selectRow(list, 1, index, 0, 0);
    refreshIrSelection(irController);
  }

  function runAction(action) {
    const list = irList();
    if (list.isNull()) return;
    if (action === 'import' || action === 'paste') {
      const target = firstFreeSlot(list, 1);
      if (target < 0) return;
      if (action === 'import') {
        if (!namImportController.isNull()) return;
        selectStockRow(list, target);
        namImportController = irController;
        importIr(irController);
      } else {
        const source = copiedSlot(list);
        if (!source) return;
        pending.set(target + 1, profiles[source]);
        pasteIr(irController, irController.add(0x48), target);
      }
    } else {
      const slot = selectedSlot();
      if (!hasProfile(list, slot)) return;
      selectStockRow(list, slot - 1);
      if (action === 'copy') copyIr(irController);
      if (action === 'export') exportIr(irController);
      if (action === 'clear') clearIr(irController);
    }
    refreshButtons();
  }

  function renderProfiles() {
    slots = Object.keys(profiles).map(Number).sort((a, b) => a - b);
    if (namList.isNull()) return;
    const previous = selectedSlot();
    clearRows(namList, 0);
    for (const slot of slots) {
      appendRow(namList, -1, Memory.allocUtf8String(profiles[slot]), NULL, 0, slot - 1, 1, 0, 0);
    }
    const message = findWidget(namPanel, 0x6e6d7367, 1); // nmsg
    if (!message.isNull()) setVisible(message, Number(slots.length === 0), 1);
    if (hasActiveModel()) syncSelection();
    else {
      const index = slots.indexOf(previous);
      if (index >= 0) selectRow(namList, 1, index, 0, 0);
    }
    redraw(namList);
  }

  function refreshProfiles(controller) {
    if (!controller.equals(irController)) return;
    const list = irList();
    if (list.isNull()) return;
    let changed = false;
    for (const slot of new Set([...slots, ...pending.keys()])) {
      const row = getIrRow(list, slot - 1);
      if (row.isNull()) continue;
      const name = row.readUtf8String();
      if (!row.add(0x10c).readU32()) {
        if (Object.hasOwn(profiles, slot)) {
          delete profiles[slot];
          changed = true;
        }
        continue;
      }
      const expected = pending.get(slot);
      if (expected && name && (name === expected || expected.startsWith(name) && name.length >= 31)) {
        pending.delete(slot);
        profiles[slot] = name;
        changed = true;
      }
    }
    if (changed) {
      renderProfiles();
      if (hasActiveModel()) rebuildModelMenu(activeModel);
    }
    refreshButtons();
  }

  function hasActiveModel() {
    // HX Edit caches the parameter widgets after detaching them from the editor.
    return !activeModel.isNull() && !getParent(activeModel).isNull() && isVisible(activeModel, 1);
  }

  function setModelSlot(slot) {
    if (!hasActiveModel()) return false;
    const slider = activeModel;
    const value = slot - 1;
    if (value === getValue(slider)) return true;
    const popup = slider.add(0x144).readPointer();
    if (popup.isNull()) return false;
    // The native popup stores the slot before handing its change to Model.
    setValue(popup, value, 0, 0);
    handleModelEvent(slider, 0x21617663, popup, NULL); // cva!
    return true;
  }

  function syncSelection() {
    if (namList.isNull()) return;
    const row = hasActiveModel() ? slots.indexOf(getValue(activeModel) + 1) : -1;
    if (row < 0) clearSelection(namList, 0, 1);
    else selectRow(namList, 1, row, 0, 1);
    refreshButtons();
  }

  renderProfiles();

  Interceptor.attach(address(0x20c3f0), {
    onEnter() { this.controller = this.context.ecx; },
    onLeave() { refreshProfiles(this.controller); },
  });

  Interceptor.attach(address(0x214ee0), {
    onEnter() {
      if (!this.context.ecx.add(0x5c).readPointer().equals(irController)) return;
      if (irController.equals(namImportController)) namImportController = NULL;
      irController = NULL;
    },
  });

  // Instantiate the same native list class and drawing mode as the IR pane.
  Interceptor.attach(address(0x422b10), {
    onEnter(args) {
      if (args[0].toUInt32() !== namListId) return;
      this.nam = true;
      args[0] = ptr(0x696c7374); // ilst
    },
    onLeave(result) {
      if (this.nam && !result.isNull()) result.add(0x54).readPointer().writeU32(namListId);
    },
  });

  Interceptor.attach(address(0x401500), {
    onEnter() {
      if (this.context.ecx.equals(namList)) {
        namList = NULL;
        namPanel = NULL;
        buttons = {};
      }
    },
  });

  Interceptor.attach(address(0x1971e0), {
    onEnter(args) {
      // This call from the IR renderer formats the number from the row index.
      if (this.returnAddress.equals(address(0x401a9f)) && this.context.edi.equals(namList)) {
        args[2] = ptr(this.context.esi.add(0x100).readU32() + 1);
      }
    },
  });

  Interceptor.attach(address(0x3bd120), {
    onEnter(args) {
      const sender = this.context.ecx;
      const event = args[0].toUInt32();
      this.selection = event === 0x216c6273 && sender.equals(namList); // sbl!
      if (event === 0x2162705f) { // _pb!
        this.action = Object.keys(buttons).find(action => sender.equals(buttons[action]));
      }
    },
    onLeave() {
      if (this.action) runAction(this.action);
      if (!this.selection) return;
      refreshButtons();
      const slot = selectedSlot();
      if (slot) setModelSlot(slot);
    },
  });

  // The stock constructor binds exactly three controllers. Keep that binding while
  // allowing the same radio widget to select the fourth, independently managed view.
  Interceptor.attach(address(0x363f00), {
    onEnter() {
      if (!this.returnAddress.equals(address(0x214de1))) return;
      const radio = this.context.ecx.add(0x50).readPointer();
      if (radio.isNull()) return;
      if (getRadioButton(radio, 3).isNull()) return;
      const maximum = radio.add(0x54).readPointer().add(0x24);
      if (maximum.readS32() !== 3) return;
      this.maximum = maximum;
      maximum.writeS32(2);
    },
    onLeave() {
      if (this.maximum) this.maximum.writeS32(3);
    },
  });

  Interceptor.attach(address(0x2156a0), {
    onEnter(args) {
      this.library = this.context.ecx.add(0x10).readPointer();
      irController = this.context.ecx.add(0x5c).readPointer();
      // The stock constructor replaces XML button IDs with generated IDs.
      // Native IR transactions request the IR tab to display their progress.
      // Keep the NAM tab when that request comes from the transfer dispatcher.
      if (tab === 3 && args[0].toUInt32() === 1 && this.returnAddress.equals(address(0x2153b4))) {
        args[0] = ptr(3);
      }
      this.tab = args[0].toUInt32();
      tab = this.tab;
    },
    onLeave() {
      if (this.library.isNull() || this.tab >= libraryViews.length) return;
      for (const [index, id] of libraryViews.entries()) {
        const panel = findWidget(this.library, id, 1);
        if (!panel.isNull()) setVisible(panel, Number(this.tab === index), 1);
      }
      if (this.tab !== 3) return;
      if (namList.isNull()) {
        namList = findWidget(this.library, namListId, 1);
        if (namList.isNull()) return;
        namPanel = findWidget(this.library, libraryViews[3], 1);
        buttons = Object.fromEntries(Object.entries(buttonIds)
          .map(([action, id]) => [action, findWidget(namPanel, id, 1)]));
        namList.add(0x1bc).writeS32(1); // single selection
        renderProfiles();
      }
      refreshProfiles(irController);
      if (hasActiveModel()) syncSelection();
    },
  });

  const constructing = new Map();
  const empty = Memory.allocUtf8String('No NAM profiles. Import one from NAM.');
  Interceptor.attach(address(0x26e680), {
    onEnter() {
      const slider = this.context.ecx;
      const label = slider.add(0x7c).readPointer();
      const format = slider.add(0x98).readPointer();
      if (label.isNull() || format.isNull()) return;
      const labelText = label.add(0x7c).readPointer();
      const displayType = format.add(0x10).readPointer();
      if (labelText.isNull() || displayType.isNull() || labelText.readCString() !== 'Model'
          || displayType.readCString() !== 'ir_select') return;
      this.model = slider;
      this.previous = constructing.get(this.threadId);
      constructing.set(this.threadId, { slider, menu: slider.add(0x144).readPointer(), count: 0 });
    },
    onLeave() {
      if (!this.model) return;
      if (this.previous) constructing.set(this.threadId, this.previous);
      else constructing.delete(this.threadId);
      activeModel = this.model;
      syncSelection();
    },
  });

  Interceptor.attach(address(0x26aa10), {
    onEnter() {
      if (!this.context.ecx.equals(activeModel)) return;
      activeModel = NULL;
      syncSelection();
    },
  });

  // The parameter is detached on block changes and laid out on attachment.
  for (const [rva, byParent] of [[0x3baae0, true], [0x3b5e00, false]]) {
    Interceptor.attach(address(rva), {
      onEnter(args) {
        this.model = (byParent ? args[0] : this.context.ecx).equals(activeModel);
      },
      onLeave() {
        if (this.model) syncSelection();
      },
    });
  }

  Interceptor.attach(address(0x26b9b0), {
    onEnter() {
      this.model = this.context.ecx.equals(activeModel);
    },
    onLeave() {
      if (this.model) syncSelection();
    },
  });

  const arguments_ = ['pointer', 'int', 'pointer', 'int', 'int', 'int'];
  const append = new NativeFunction(address(0x3ac110), 'pointer', arguments_, 'thiscall');
  Interceptor.replace(address(0x3ac110), new NativeCallback(function (menu, index, label, id, options, disabled) {
    const state = constructing.get(this.threadId);
    if (!state || !menu.equals(state.menu)) return append(menu, index, label, id, options, disabled);
    const parts = label.readCString().match(/^(\d+): (.+)$/);
    if (parts && Object.hasOwn(profiles, parts[1]) && profiles[parts[1]] === parts[2]) {
      return append(menu, index, label, id, options, disabled);
    }
    if (parts && audition && audition.slider.equals(state.slider) && Number(parts[1]) === audition.slot
        && parts[2] === audition.name) return append(menu, index, label, id, options, disabled);
    if (slots.length === 0 && state.count++ === 0) {
      return append(menu, index, empty, id, options, 1);
    }
    return NULL;
  }, 'pointer', arguments_, 'thiscall'));

  return {
    refreshProfiles,
    modelSlot: () => hasActiveModel() ? getValue(activeModel) + 1 : null,
    playPreview(transfer) {
      const name = this.previewName(transfer);
      if (!name || !hasActiveModel()) return false;
      audition = { slider: activeModel, slot: transfer.slot, name };
      rebuildModelMenu(activeModel);
      return setModelSlot(transfer.slot);
    },
    stopPreview() {
      if (!audition) return;
      audition = null;
      if (hasActiveModel()) rebuildModelMenu(activeModel);
    },
    freeSlots(excluded) {
      const list = irList();
      const free = [];
      if (list.isNull()) return free;
      for (let slot = 1; slot <= 128; slot++) {
        if (slot === excluded) continue;
        const row = getIrRow(list, slot - 1);
        if (!row.isNull() && !row.add(0x10c).readU32()) free.push(slot);
      }
      return free;
    },
    importPreview(file, slot) {
      const list = irList();
      if (list.isNull()) throw new Error('Connect your Helix to audition a tone.');
      if (!namImportController.isNull()) throw new Error('Wait for the current NAM import to finish.');
      const transfer = { controller: irController, slot, file };
      if (!this.previewSlotEmpty(transfer)) throw new Error(`User IR ${slot} is no longer free.`);
      toneImport = transfer;
      selectStockRow(list, slot - 1);
      namImportController = irController;
      importIr(irController);
      return transfer;
    },
    previewName(transfer) {
      if (!transfer.controller.equals(irController) || !transfer.name) return '';
      const list = irList();
      if (list.isNull()) return '';
      const row = getIrRow(list, transfer.slot - 1);
      if (row.isNull() || !row.add(0x10c).readU32()) return '';
      const name = row.readUtf8String();
      return name === transfer.name || (name.length >= 31 && transfer.name.startsWith(name)) ? name : '';
    },
    registerProfile(transfer) {
      const name = this.previewName(transfer);
      if (!name) return false;
      profiles[transfer.slot] = name;
      renderProfiles();
      if (hasActiveModel()) rebuildModelMenu(activeModel);
      return true;
    },
    selectProfile(transfer) {
      return !!this.previewName(transfer) && setModelSlot(transfer.slot);
    },
    clearPreview(transfer) {
      if (!this.previewName(transfer)) return false;
      const librarian = irController.add(0x270).readPointer();
      if (librarian.isNull()) return false;
      // Same single-slot array passed by the stock Clear confirmation handler.
      const index = Memory.alloc(4);
      index.writeU32(transfer.slot - 1);
      const slots = Memory.alloc(24);
      slots.writePointer(address(0x8bb0dc));
      slots.add(4).writeU32(1);
      slots.add(8).writePointer(index);
      slots.add(12).writeU32(1);
      slots.add(16).writeU32(0);
      slots.add(20).writeU32(1);
      clearIrSlots(librarian, slots);
      return true;
    },
    previewSlotEmpty(transfer) {
      if (!transfer.controller.equals(irController)) return false;
      const list = irList();
      if (list.isNull()) return false;
      const row = getIrRow(list, transfer.slot - 1);
      return !row.isNull() && !row.add(0x10c).readU32();
    },
    trackImport(first, count, imported) {
      for (let slot = first; slot < first + count; slot++) pending.delete(slot);
      for (const [slot, name] of Object.entries(imported)) pending.set(Number(slot), name);
    },
  };
}
