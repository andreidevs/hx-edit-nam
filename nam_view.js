'use strict';

// HX Edit 3.82 x86, verified by the launcher before these offsets are used.
// Read HX Edit's in-memory edit buffer (SF variant tree) without native calls.
// Layout from the Helix Floor library contribution (PR #4), pinned to HX Edit 3.82 x86.
function readPresetTree(root) {
  const limits = { nodes: 512, properties: 512, array: 2048, depth: 24, string: 8192 };
  let budget = 30000;
  const fail = reason => { throw new Error(reason); };
  const present = p => (p.isNull() ? fail('missing-memory') : p);
  const spend = () => { if (--budget < 0) fail('value-budget'); };
  function put(object, key, value) {
    if (typeof key !== 'string' || !key || Object.hasOwn(object, key)) fail('invalid-key');
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
  }
  function bounds(rep, begin, end, maximum) {
    const first = rep.add(begin).readU32(), last = rep.add(end).readU32();
    if (last < first || first > 8192 || last - first > maximum) fail('invalid-bounds');
    return [first, last];
  }
  function tree(first, left, right, visit) {
    const pending = [first], seen = new Set();
    while (pending.length) {
      const node = pending.pop();
      if (node.isNull()) continue;
      if (seen.has(node.toString()) || seen.size >= limits.nodes) fail('invalid-tree');
      seen.add(node.toString());
      spend();
      visit(node);
      pending.push(node.add(left).readPointer(), node.add(right).readPointer());
    }
  }
  function value(p, depth = 0) {
    present(p);
    spend();
    if (depth > limits.depth) fail('value-depth');
    const tag = p.readU32(), v = p.add(8);
    if (tag === 4) return v.readS32();
    if (tag === 5) return v.readU32();
    if (tag === 8) return v.readFloat();
    if (tag === 9) return v.readU32() === 0 ? null : fail('opaque-pointer');
    if (tag === 11) return v.readU8() === 1;
    if (tag === 10) {
      const rep = present(v.readPointer()).add(4).readPointer();
      if (rep.isNull()) return '';
      const length = rep.add(4).readU32();
      if (length > limits.string) fail('string-budget');
      return length ? present(rep.add(16).readPointer()).readUtf8String(length) : '';
    }
    if (tag === 12) {
      const rep = present(v.readPointer());
      const [first, last] = bounds(rep, 16, 20, limits.array);
      const data = rep.add(8).readPointer(), out = [];
      for (let i = first; i < last; i++) out.push(value(present(data).add(i * 16), depth + 1));
      return out;
    }
    if (tag === 13) {
      const out = {};
      tree(present(v.readPointer()).add(4).readPointer(), 40, 44,
        node => put(out, value(node.add(8), depth + 1), value(node.add(24), depth + 1)));
      return out;
    }
    fail('unsupported-variant-' + tag); // unknown values are never silently dropped
  }
  function properties(array) {
    const [first, last] = bounds(array, 20, 24, limits.properties);
    const data = array.add(12).readPointer(), out = {};
    for (let i = first; i < last; i++) {
      const pair = present(present(data).add(i * 4).readPointer());
      put(out, value(pair), value(pair.add(16)));
    }
    return out;
  }
  function nodes(offset) {
    const out = {};
    tree(root.add(offset + 4).readPointer(), 68, 72, node => put(out, value(node.add(8)), properties(node.add(24))));
    return out;
  }
  return { global: properties(root.add(24)), globalNodes: nodes(68), dsp0: nodes(76), dsp1: nodes(84) };
}

// Every IR slot the current preset references, or a reason it cannot be known.
// irParameters maps each model symbol to its ir_select parameters ([] = no IR).
function presetIrSlots(tree, irParameters) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const scalar = value => value === null || ['boolean', 'number', 'string'].includes(typeof value);
  const slots = new Set();
  if (Object.entries(tree.global).some(([key, value]) => !key.startsWith('@') || !scalar(value))) {
    return { reason: 'unsupported-global-properties' };
  }
  if (!Object.keys(tree.dsp0).length) return { reason: 'empty-signal-flow' };
  for (const dsp of ['dsp0', 'dsp1']) {
    for (const node of Object.values(tree[dsp])) {
      const model = record(node) ? node['@model'] : undefined;
      if (typeof model !== 'string' || model.startsWith('HelixPlugin_')) return { reason: 'unknown-block' };
      const parameters = irParameters[model] ?? irParameters[model.replace(/(Mono|Stereo)$/, '')];
      if (!parameters) return { reason: 'unknown-model' };
      for (const parameter of parameters) {
        const slot = node[parameter];
        if (!Number.isInteger(slot) || slot < 1 || slot > 128) return { reason: 'invalid-slot-value' };
        slots.add(slot);
      }
      // Controller or snapshot assignments would appear as nested values here.
      if (Object.values(node).some(value => !scalar(value))) return { reason: 'unsupported-block-value' };
    }
  }
  const snapshotKeys = new Set(['@name', '@tempo', '@valid', '@custom_name', '@ledcolor', '@pedalstate']);
  const metadata = new Set(['global', 'variax', 'dt0', 'dt1', 'dtdual', 'powercab0', 'powercab1', 'powercabdual', 'footswitch']);
  for (const [name, node] of Object.entries(tree.globalNodes)) {
    if (!record(node)) return { reason: 'unsupported-global-node' };
    if (/^snapshot\d$/.test(name)) {
      for (const [key, value] of Object.entries(node)) {
        if (snapshotKeys.has(key) ? !scalar(value) : key !== 'blocks' || !record(value)) {
          return { reason: 'unsupported-snapshot-values' }; // e.g. a snapshot-controlled IR slot
        }
      }
    } else if (Object.keys(node).length && (!metadata.has(name) || Object.values(node).some(value => !scalar(value)))) {
      return { reason: 'unsupported-global-node' };
    }
  }
  return { slots };
}

function installNamView(profiles, savedSidebarWidth = 0, irParameters = {}) {
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
  const configureTab = method(0x1f77e0, 'void', ['int', 'int']);
  const layoutTab = method(0x1f7460, 'void', []);
  const getAnchor = method(0x3b7f30, 'int', ['int']);
  const setAnchor = method(0x3bbef0, 'void', ['int', 'int', 'int']);
  const widgetOrigin = method(0x3b7e00, 'pointer', ['pointer']);
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
  let libraryRoot = NULL;

  // HXCustomTab lays tabs out by its own visual index, not by X or radio index.
  // Show NAM before Favorites; native tab indexes and controllers stay unchanged.
  function orderTabs() {
    const radio = findWidget(libraryRoot, 0x6c627462, 1); // lbtb
    if (radio.isNull() || !radio.readPointer().equals(address(0x915358))) return;
    const favorites = getRadioButton(radio, 2);
    const nam = getRadioButton(radio, 3);
    if ([favorites, nam].some(tab => tab.isNull() || !tab.readPointer().equals(address(0x8c35a0)))) return;
    if (nam.add(0x218).readS32() === 2) return;
    for (const [tab, index] of [[favorites, 3], [nam, 2]]) {
      configureTab(tab, 1, index);
      layoutTab(tab);
    }
    redraw(radio);
  }

  // Drag the boundary between the librarian and the editor. main.xml starts at
  // the saved width; this only moves the native anchors and normal relayout.
  const sidebarIds = { library: 0x6c697677, editor: 0x65647677 }; // livw, edvw
  const sidebarLimits = { minimum: 220, maximum: 600, editor: 640, grip: 4 };
  const origin = Memory.alloc(8);
  const clientRect = Memory.alloc(16);
  const winApi = (name, type, args) => new NativeFunction(user32.getExportByName(name), type, args, 'stdcall');
  const getClientRect = winApi('GetClientRect', 'int', ['pointer', 'pointer']);
  const getAncestor = winApi('GetAncestor', 'pointer', ['pointer', 'uint']);
  const setCapture = winApi('SetCapture', 'pointer', ['pointer']);
  const releaseCapture = winApi('ReleaseCapture', 'int', []);
  const setCursor = winApi('SetCursor', 'pointer', ['pointer']);
  const resizeCursor = winApi('LoadCursorW', 'pointer', ['pointer', 'pointer'])(NULL, ptr(32644)); // IDC_SIZEWE
  let sidebarWidth = savedSidebarWidth;
  let drag = null;

  function canonical(widget) {
    // Some widgets hand their geometry to a proxy widget.
    for (let depth = 0; depth < 8 && !widget.isNull(); depth++) {
      const geometry = widget.add(0x54).readPointer();
      if (geometry.isNull()) return NULL;
      const proxy = geometry.add(0xb4).readPointer();
      if (proxy.isNull()) return widget;
      widget = proxy;
    }
    return NULL;
  }

  function box(widget) {
    const geometry = widget.add(0x54).readPointer();
    const x = geometry.add(4).readS32();
    const y = geometry.add(8).readS32();
    return { x, y, w: geometry.add(0xc).readS32() - x, h: geometry.add(0x10).readS32() - y };
  }

  function sidebar() {
    for (let widget = canonical(libraryRoot), depth = 0; !widget.isNull() && depth < 8; depth++) {
      const library = canonical(findWidget(widget, sidebarIds.library, 0));
      const editor = canonical(findWidget(widget, sidebarIds.editor, 0));
      if (!library.isNull() && !editor.isNull()) {
        if (!isVisible(library, 1)) return null;
        return { library, editor, parent: box(widget), side: box(library) };
      }
      widget = canonical(getParent(widget));
    }
    return null;
  }

  function resizeSidebar(view, width) {
    const maximum = Math.min(sidebarLimits.maximum, view.parent.w - view.side.x - sidebarLimits.editor);
    if (maximum < sidebarLimits.minimum) return;
    width = Math.max(sidebarLimits.minimum, Math.min(maximum, Math.round(width)));
    if (view.side.w === width && getAnchor(view.editor, 3) === view.side.x + width) return;
    setAnchor(view.library, 1, view.parent.w - view.side.x - width, 1);
    setAnchor(view.editor, 3, view.side.x + width, 1);
  }

  // Keep the chosen width after window resizes and the librarian show/hide button.
  function syncSidebar() {
    if (!sidebarWidth || drag) return;
    const view = sidebar();
    if (view) resizeSidebar(view, sidebarWidth);
  }

  function sidebarEdge(hwnd, x, y) {
    const view = sidebar();
    if (!view || !getAncestor(hwnd, 2).equals(hwnd) || !getClientRect(hwnd, clientRect) ||
        clientRect.add(8).readS32() < view.parent.w) return null; // the main editor window only
    widgetOrigin(view.library, origin);
    const left = origin.readS32();
    const top = origin.add(4).readS32();
    const near = Math.abs(x - (left + view.side.w)) <= sidebarLimits.grip && y >= top && y < top + view.side.h;
    return near ? { view, left } : null;
  }

  Interceptor.attach(user32.getExportByName('DispatchMessageW'), {
    onEnter(args) {
      const msg = args[0];
      const event = msg.add(4).readU32();
      this.event = event;
      if (event !== 0x200 && event !== 0x201 && event !== 0x202 && event !== 0x203) return;
      const hwnd = msg.readPointer();
      const position = msg.add(12).readU32();
      const x = (position << 16) >> 16;
      const y = position >> 16;
      if (drag) {
        if (!hwnd.equals(drag.hwnd)) return;
        msg.add(4).writeU32(0); // WM_NULL: the editor never sees the drag
        const view = sidebar();
        if (view) resizeSidebar(view, x - drag.left);
        if (event === 0x202) {
          drag = null;
          releaseCapture();
          const view = sidebar();
          if (view) {
            sidebarWidth = view.side.w;
            send({ type: 'sidebarWidth', width: sidebarWidth });
          }
        }
        setCursor(resizeCursor);
        return;
      }
      const edge = event === 0x202 ? null : sidebarEdge(hwnd, x, y);
      if (!edge) return;
      this.cursor = true;
      if (event === 0x201) {
        msg.add(4).writeU32(0);
        drag = { hwnd, left: edge.left };
        setCapture(hwnd);
      } else if (event === 0x203) {
        msg.add(4).writeU32(0);
        resizeSidebar(edge.view, sidebarLimits.minimum);
        sidebarWidth = sidebarLimits.minimum;
        send({ type: 'sidebarWidth', width: sidebarWidth });
      }
    },
    onLeave() {
      if (this.cursor) setCursor(resizeCursor);
      if (this.event === 5 || this.event === 0xf || this.event === 0x202) syncSidebar(); // size, paint, button up
    },
  });

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
      libraryRoot = NULL;
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
        libraryRoot = NULL;
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
      libraryRoot = this.library;
      orderTabs();
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

  // Clear protection: the stock IR Clear and the NAM tab's Clear both queue
  // through the librarian here. Block slots the current preset still uses.
  const kernel32 = Process.getModuleByName('kernel32.dll');
  const waitForObject = new NativeFunction(kernel32.getExportByName('WaitForSingleObject'), 'uint32', ['pointer', 'uint32'], 'stdcall');
  const releaseMutex = new NativeFunction(kernel32.getExportByName('ReleaseMutex'), 'int', ['pointer'], 'stdcall');
  const editorVtable = address(0x963dfc);
  let presetEditor = NULL;
  let presetRevision = 0;
  let presetNotifying = 0;
  let trustedClear = false;

  Interceptor.attach(address(0x218a00), {
    onEnter() {
      const editor = this.context.ecx.add(0x34).readPointer();
      if (!editor.isNull() && editor.readPointer().equals(editorVtable)) presetEditor = editor;
      presetRevision++;
      presetNotifying++;
    },
    onLeave() {
      presetRevision++;
      presetNotifying--;
    },
  });

  function readCurrentPreset() {
    const editor = presetEditor;
    if (editor.isNull() || !editor.readPointer().equals(editorVtable)) return { reason: 'editor-unavailable' };
    if (presetNotifying) return { reason: 'preset-changing' };
    const held = [];
    function lock(object) {
      // Try-lock only (timeout 0), in the editor's own order: edit buffer, then engine.
      if (!object.readPointer().equals(address(0x92dc4c))) throw new Error('unexpected-lock');
      const handle = object.add(4).readPointer().readPointer();
      const status = waitForObject(handle, 0);
      if (status === 0 || status === 0x80) held.push(handle);
      if (status !== 0) throw new Error('preset-busy');
    }
    try {
      lock(editor.add(0x134));
      const engine = editor.add(0x124).readPointer();
      lock(engine.add(0x18));
      const root = engine.add(0x30);
      if (root.add(4).readU32() !== 6) return { reason: 'unsupported-preset' };
      const revision = presetRevision;
      const first = readPresetTree(root), second = readPresetTree(root);
      if (JSON.stringify(first) !== JSON.stringify(second) || revision !== presetRevision) {
        return { reason: 'preset-changing' };
      }
      return presetIrSlots(first, irParameters);
    } catch (error) {
      return { reason: String(error.message) };
    } finally {
      for (const handle of held.reverse()) releaseMutex(handle);
    }
  }

  function selectedClearSlots(vector) {
    if (vector.isNull() || !vector.readPointer().equals(address(0x8bb0dc))) return null;
    const begin = vector.add(16).readU32(), end = vector.add(20).readU32();
    const data = vector.add(8).readPointer();
    if (begin >= end || end - begin > 128 || data.isNull()) return null;
    const slots = [];
    for (let index = begin; index < end; index++) slots.push(data.add(index * 4).readU32() + 1);
    return slots;
  }

  const clearIrSlotsOriginal = new NativeFunction(address(0x3da2b0), 'void', ['pointer', 'pointer'], 'thiscall');
  Interceptor.replace(address(0x3da2b0), new NativeCallback(function (librarian, vector) {
    if (trustedClear) return clearIrSlotsOriginal(librarian, vector);
    let text;
    try {
      const selected = selectedClearSlots(vector);
      const preset = readCurrentPreset();
      const used = selected && preset.slots ? selected.filter(slot => preset.slots.has(slot)) : [];
      if (selected && preset.slots && !used.length) return clearIrSlotsOriginal(librarian, vector);
      text = used.length
        ? `User IR ${used.join(', ')} ${used.length === 1 ? 'is' : 'are'} used by the current preset.\n\n` +
          'Switch to a preset that does not use these slots, then try Clear again.'
        : `Could not check which IR slots the current preset uses (${selected ? preset.reason : 'unknown selection'}).\n\n` +
          'Wait for the preset to finish loading and try again.';
    } catch (error) {
      text = `Could not check the current preset (${error.message}).`;
    }
    messageBox(getActiveWindow(), Memory.allocUtf16String(text + ' Nothing was deleted.'),
      Memory.allocUtf16String('IR slot protection'), 0x30);
  }, 'void', ['pointer', 'pointer'], 'thiscall'));

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
      for (let slot = 1; slot < AUDITION_SLOT; slot++) {
        if (slot === excluded) continue;
        const row = getIrRow(list, slot - 1);
        if (!row.isNull() && !row.add(0x10c).readU32()) free.push(slot);
      }
      return free;
    },
    importPreview(source, slot, audition = false) {
      const list = irList();
      if (list.isNull()) throw new Error('Connect your Helix to audition a tone.');
      if (!namImportController.isNull()) throw new Error('Wait for the current NAM import to finish.');
      const transfer = { controller: irController, slot, source };
      if (!this.previewSlotEmpty(transfer)) {
        throw new Error(slot === AUDITION_SLOT
          ? `Clear User IR ${slot}. It is reserved for TONE3000 auditions.`
          : `User IR ${slot} is no longer free.`);
      }
      transfer.file = requestImport({ type: 'stageTone', file: source, audition }).file;
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
      trustedClear = true; // our own audition slot, after Undo restored the block
      try {
        clearIrSlots(librarian, slots);
      } finally {
        trustedClear = false;
      }
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
