'use strict';

// HX Edit 3.82 arm64. All editor calls and WebKit work run on the AppKit thread.
function installToneMac(nam) {
  const base = Process.mainModule.base;
  const at = offset => base.add(offset);
  const method = (offset, result, args = []) => new NativeFunction(at(offset), result, ['pointer', ...args]);
  const library = Process.getModuleByName('tone-browser-macos.dylib');
  const dispatch = new NativeFunction(library.getExportByName('hx_nam_dispatch'), 'void', ['pointer']);
  const windowNumber = new NativeFunction(library.getExportByName('hx_tone_window'), 'long', []);
  const browser = new NativeFunction(library.getExportByName('hx_tone_browser'), 'void', ['pointer', 'pointer']);
  const browserEvent = new NativeCallback(json => send({type: 'toneBrowserEvent', event: JSON.parse(json.readUtf8String())}),
    'void', ['pointer']);
  const queue = [];
  const drain = new NativeCallback(() => queue.shift()?.(), 'void', []);
  const main = fn => new Promise((resolve, reject) => {
    queue.push(() => {
      try { resolve(fn()); } catch (error) { reject(error); }
    });
    dispatch(drain);
  });
  const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
  async function until(read, timeout) {
    const deadline = Date.now() + timeout;
    do {
      const result = await main(read);
      if (result) return result;
      await sleep(75);
    } while (Date.now() < deadline);
    return null;
  }

  const find = method(0x511fc8, 'pointer', ['uint', 'bool']);
  const parent = method(0x512178, 'pointer');
  const getRect = method(0x5141ec, 'pointer');
  const visible = method(0x5128d0, 'bool', ['bool']);
  const getItem = method(0x271ef4, 'pointer', ['uint']);
  const getCount = method(0x2722a4, 'uint');
  const selected = method(0x272a4c, 'pointer');
  const clearSelection = method(0x2725ec, 'void', ['bool', 'bool']);
  const append = method(0x271af8, 'void', ['int', 'pointer', 'pointer', 'uint', 'int', 'pointer', 'uint', 'bool']);
  const chooseModel = method(0x6c38c0, 'void', ['pointer']);
  const undo = method(0x234e08, 'int');
  const modelEvent = method(0x6c0dac, 'void', ['uint', 'pointer', 'pointer', 'pointer']);
  const catalogLabel = Memory.allocUtf8String('TONE3000');
  const modelList = controller => controller.add(0xa8).readPointer();
  const editorOf = controller => controller.add(0x60).readPointer();
  const positionOf = controller => [editorOf(controller), controller.add(0xf0).readS32(),
    controller.add(0x11c).readS32(), controller.add(0x120).readS32()].join(':');
  function string(value) {
    const data = value.add(8).readPointer();
    return data.isNull() ? '' : data.add(0x10).readPointer().readUtf8String();
  }
  const blockOf = controller => string(controller.add(0xf8));
  const undoIndex = editor => editor.add(0x3fc).readS32();

  let active = null;
  let nextSession = 0;
  const samePosition = state => state.valid && positionOf(state.controller) === state.position;
  const sameTarget = state => samePosition(state) && blockOf(state.controller) === state.block;

  function bounds(panel) {
    if (panel.isNull() || !visible(panel, 1)) return {visible: false};
    const rect = getRect(panel);
    const w = rect.add(8).readS32() - rect.readS32();
    const h = rect.add(12).readS32() - rect.add(4).readS32();
    let x = 0, y = 0;
    for (let item = panel; !item.isNull(); item = parent(item)) {
      const position = getRect(item);
      x += position.readS32();
      y += position.add(4).readS32();
    }
    return {visible: true, x, y, w, h};
  }

  function parameterPanel(list) {
    for (let item = list; !item.isNull(); item = parent(item)) {
      const panel = find(item, 0x50525657, 1); // PRVW
      if (!panel.isNull()) return panel;
    }
    return NULL;
  }

  function findModelRow(list, name) {
    for (let index = 0, count = getCount(list); index < count; index++) {
      const row = getItem(list, index);
      if (!row.isNull() && row.readUtf8String() === name) return row;
    }
    return NULL;
  }

  function ensureEntry(controller) {
    const list = modelList(controller);
    if (list.isNull() || !findModelRow(list, 'TONE3000').isNull()) return;
    const row = findModelRow(list, 'NAM A2 Lite');
    if (row.isNull()) return;
    append(list, -1, catalogLabel, row.add(0x108).readPointer(), 0,
      row.add(0x100).readS32(), row.add(0x118).readPointer(), 0, 1);
  }

  Interceptor.attach(at(0x6c3220), { // HXModelSelectViewController::setupModelList
    onEnter(args) { this.controller = args[0]; },
    onLeave() { ensureEntry(this.controller); },
  });

  Interceptor.replace(at(0x6c0dac), new NativeCallback(function (controller, event, sender, data, flags) {
    if (event !== 0x216c6273 || sender.isNull() || !sender.equals(modelList(controller))) {
      modelEvent(controller, event, sender, data, flags);
      if (event === 0x216c6273 || event === 0x21617663) ensureEntry(controller);
      return;
    }
    const row = selected(sender);
    if (row.isNull() || row.readUtf8String() !== 'TONE3000') {
      return modelEvent(controller, event, sender, data, flags);
    }
    clearSelection(sender, 0, 1);
    if (active) return;
    const editor = editorOf(controller);
    const panel = parameterPanel(sender);
    const layout = bounds(panel);
    const window = windowNumber().toNumber();
    if (editor.isNull() || !editor.readPointer().equals(at(0xa8c978)) ||
        !window || !layout.visible || layout.w < 60 || layout.h < 60) return;
    const namRow = findModelRow(sender, 'NAM A2 Lite');
    if (namRow.isNull()) return;
    const model = namRow.add(0x118).readPointer();
    if (model.isNull()) return;
    active = {id: ++nextSession, controller, editor, panel, model, position: positionOf(controller),
      block: blockOf(controller), index: undoIndex(editor), layout: JSON.stringify(layout), valid: true};
    send({type: 'toneStart', session: active.id, window, bounds: layout});
    followLayout(active);
  }, 'void', ['pointer', 'uint', 'pointer', 'pointer', 'pointer']));

  Interceptor.attach(at(0x6c0d54), { // HXModelSelectViewController::onViewWillDestroy
    onEnter(args) {
      if (active && args[0].equals(active.controller)) {
        active.valid = false;
        active.panel = NULL;
      }
    },
  });
  Interceptor.attach(at(0x6bd424), { // HXModelSelectViewController::handleEdLibNotification
    onEnter(args) {
      const state = active;
      if (!state || !args[0].equals(state.controller)) return;
      const event = string(args[1]);
      if (/^EditBuffer_(?:TargetDeviceChanged|DevicePresetChanged|PresetChanged|HelixSnapshotWillChange|PresetSavedToDevice)$/.test(event)) {
        state.valid = false;
      }
    },
  });

  async function followLayout(state) {
    while (active === state) {
      await sleep(125);
      await main(() => {
        if (active !== state) return;
        const layout = bounds(state.panel);
        const value = JSON.stringify(layout);
        if (value !== state.layout) {
          state.layout = value;
          send({type: 'toneBounds', session: state.id, bounds: layout});
        }
      });
    }
  }

  // Every UI save of the current edit buffer reaches this method.
  const savePreset = method(0x23e350, 'int', ['pointer']);
  Interceptor.replace(at(0x23e350), new NativeCallback(function (editor, destination) {
    if (active?.trial && editor.equals(active.editor) && !active.restored) {
      send({type: 'toneError', message: 'Use Save to Helix in TONE3000 before saving a preset with an audition profile.'});
      return -1;
    }
    return savePreset(editor, destination);
  }, 'int', ['pointer', 'pointer']));

  function requireTarget(state) {
    if (!sameTarget(state) || undoIndex(state.editor) !== state.index) {
      throw new Error('The target changed. Select TONE3000 again on the desired block.');
    }
  }

  function playing(state) {
    return state.trial && state.undoAfter !== undefined && sameTarget(state) &&
      nam.modelSlot() === state.trial.slot && !!nam.previewName(state.trial);
  }

  async function upload(state, file, slot, audition) {
    const transfer = await main(() => {
      requireTarget(state);
      const transfer = nam.importPreview(file, slot, audition);
      if (audition) state.trial = transfer;
      return transfer;
    });
    const loaded = await until(() => sameTarget(state) && nam.previewName(transfer), 12000);
    if (loaded) return transfer;
    if (!audition) await main(() => nam.release(transfer));
    throw new Error(`HX Edit did not confirm the import. Check User IR ${slot} before retrying.`);
  }

  async function apply(state, transfer, audition) {
    const original = await main(() => {
      requireTarget(state);
      const slot = nam.modelSlot();
      if (audition) state.originalSlot = slot;
      if (slot === null) chooseModel(state.controller, state.model);
      return slot;
    });
    if (original === null) {
      const inserted = await until(() => {
        if (!samePosition(state)) throw new Error('The target changed during the TONE3000 operation.');
        if (nam.modelSlot() === null || undoIndex(state.editor) !== state.index + 1) return false;
        state.block = blockOf(state.controller);
        return true;
      }, 3500);
      if (!inserted) throw new Error(`HX Edit did not confirm the NAM block. Check User IR ${transfer.slot}.`);
    }
    const applied = await main(() => sameTarget(state) &&
      (audition ? nam.playPreview(transfer) : nam.selectProfile(transfer)));
    const confirmed = applied && await until(() => {
      if (!sameTarget(state) || nam.modelSlot() !== transfer.slot || !nam.previewName(transfer)) return false;
      const expected = state.index + Number(original === null) + Number(original !== transfer.slot);
      const actual = undoIndex(state.editor);
      // Inserting NAM can already select the imported slot as its default.
      if (actual !== expected && !(original === null && actual === expected - 1)) return false;
      if (audition) state.undoAfter = actual;
      else state.index = actual;
      return true;
    }, 3500);
    if (!confirmed) throw new Error(`Could not apply the profile. Check User IR ${transfer.slot} on Helix.`);
  }

  async function restore(state) {
    const trial = state.trial;
    if (!trial) return;
    const notice = `Check User IR ${trial.slot}. The audition profile was left on Helix.`;
    const undone = await main(() => {
      if (state.undoIssued) return true;
      if (!sameTarget(state) || !nam.previewName(trial)) return false;
      const current = undoIndex(state.editor);
      if (state.undoAfter === undefined) {
        if (current !== state.index || nam.modelSlot() === trial.slot) return false;
      } else {
        if (current !== state.undoAfter || !playing(state)) return false;
        const steps = state.undoAfter - state.index;
        if (steps < 0 || steps > 2 || (!steps && state.originalSlot !== trial.slot)) return false;
        for (let step = 0; step < steps; step++) {
          if (undo(state.editor) < 0 || undoIndex(state.editor) !== current - step - 1) return false;
        }
      }
      state.undoIssued = true;
      return true;
    });
    if (!undone) throw new Error(notice);

    // Undo updates the model widget through a later editor notification.
    const cleared = await until(() => {
      if (!samePosition(state) || undoIndex(state.editor) !== state.index) throw new Error(notice);
      const slot = nam.modelSlot();
      if (slot === trial.slot || (state.undoAfter !== undefined && slot !== state.originalSlot)) return false;
      state.block = blockOf(state.controller);
      state.restored = true;
      nam.stopPreview();
      if (!nam.previewSlotEmpty(trial) && !nam.clearPreview(trial)) throw new Error(notice);
      return true;
    }, 3500);
    if (!cleared || !await until(() => nam.previewSlotEmpty(trial), 3500)) throw new Error(notice);
    await main(() => {
      nam.release(trial);
      state.trial = null;
      state.undoAfter = undefined;
      state.undoIssued = false;
      state.restored = false;
    });
  }

  async function operate(state, request) {
    let result = {};
    try {
      if (request.action === 'close') {
        await restore(state);
      } else if (request.action === 'audition') {
        await restore(state);
        if (!state.scratch && !await main(() => nam.auditionSlotEmpty())) {
          throw new Error(`Clear User IR ${AUDITION_SLOT}. It is reserved for TONE3000 auditions.`);
        }
        state.scratch = AUDITION_SLOT;
        const transfer = await upload(state, request.file, state.scratch, true);
        await apply(state, transfer, true);
        result.slot = transfer.slot;
      } else if (request.action === 'save') {
        const trial = await main(() => {
          if (!playing(state) || undoIndex(state.editor) !== state.undoAfter ||
              !Number.isInteger(request.slot) || request.slot < 1 || request.slot > 128 ||
              request.slot === state.scratch) throw new Error('Choose another free slot while a profile is auditioning.');
          return state.trial;
        });
        // The target must remain at the audition's undo index until the copy is confirmed.
        const before = state.index;
        let saved;
        try {
          state.index = state.undoAfter;
          saved = await upload(state, trial.file, request.slot, false);
        } finally {
          state.index = before;
        }
        await main(() => {
          if (!nam.registerProfile(saved)) throw new Error(`Check User IR ${saved.slot} on Helix.`);
          nam.release(saved);
          result.savedSlot = saved.slot;
        });
        await restore(state);
        await apply(state, saved, false);
      }
    } catch (error) {
      if (request.action === 'close') result.notice = String(error.message);
      else {
        result.error = String(error.message);
        await main(() => { if (playing(state)) result.slot = state.trial.slot; });
      }
    } finally {
      await main(() => {
        if (request.action === 'close') {
          if (state.trial) nam.release(state.trial);
          nam.stopPreview();
          active = null;
        } else {
          result.freeSlots = nam.freeSlots().filter(slot => slot !== state.scratch);
        }
        state.busy = false;
        send({type: 'toneReply', id: request.id, ...result});
      });
    }
  }

  function listenCommands() {
    recv('toneCommand', ({payload: request}) => {
      if (!active || active.id !== request.session || active.busy) {
        send({type: 'toneReply', id: request.id, error: 'This TONE3000 selection is no longer active.'});
      } else {
        active.busy = true;
        operate(active, request).catch(error => send({type: 'toneError', message: String(error.message)}));
      }
      listenCommands();
    });
  }
  function listenBrowser() {
    recv('toneBrowser', ({payload}) => {
      main(() => browser(Memory.allocUtf8String(JSON.stringify(payload)), browserEvent));
      listenBrowser();
    });
  }
  listenCommands();
  listenBrowser();
}
