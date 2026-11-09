'use strict';

// HX Edit 3.82 x86. Use the native model selector, IR librarian and undo manager.
function installToneView() {
  const method = (rva, type, args) => new NativeFunction(base.add(rva), type, ['pointer', ...args], 'thiscall');
  const win = (name, type, args) => new NativeFunction(user32.getExportByName(name), type, args, 'stdcall');
  const post = win('PostMessageW', 'int', ['pointer', 'uint', 'uint', 'uint']);
  const wake = win('RegisterWindowMessageW', 'uint', ['pointer'])(Memory.allocUtf16String('HX Edit NAM TONE3000'));
  const rowCount = method(0x379fb0, 'uint', []);
  const selectedRow = method(0x380780, 'pointer', []);
  const selectRow = method(0x3821d0, 'void', ['int', 'int', 'int', 'int']);
  const clearSelection = method(0x37f690, 'void', ['int', 'int']);
  const appendRow = method(0x380940, 'void', ['int', 'pointer', 'pointer', 'int', 'int', 'pointer', 'int', 'int']);
  const findWidget = method(0x3b7ae0, 'pointer', ['uint', 'int']);
  const widgetOrigin = method(0x3b7e00, 'pointer', ['pointer']);
  const isVisible = method(0x3ba100, 'uint8', ['int']);
  const point = Memory.alloc(8);
  const selectionEvent = 0x216c6273; // sbl!
  const nam = 'NAM A2 Lite';
  const label = Memory.allocUtf8String('TONE3000');
  const title = Memory.allocUtf16String('TONE3000 · HX Edit NAM');
  const eventAddress = base.add(0x217120);
  const eventTypes = ['pointer', 'uint', 'pointer', 'pointer', 'pointer'];
  const modelEvent = new NativeFunction(eventAddress, 'void', eventTypes, 'thiscall');
  let active = null;
  let nextSession = 0;
  let command = null;

  function parameterPanel(list) {
    // editView.xml puts PRVW beside the model selector in the same edit view.
    let widget = list;
    for (let depth = 0; depth < 5 && !widget.isNull(); depth++) {
      const panel = findWidget(widget, 0x50525657, 1); // PRVW
      if (!panel.isNull()) return panel;
      widget = widget.add(0x54).readPointer().add(0x14).readPointer();
    }
    return NULL;
  }

  function panelBounds(panel) {
    if (!isVisible(panel, 1)) return { visible: false };
    widgetOrigin(panel, point);
    const geometry = panel.add(0x54).readPointer();
    return { visible: true, x: point.readS32(), y: point.add(4).readS32(),
      w: geometry.add(0xc).readS32() - geometry.add(4).readS32(),
      h: geometry.add(0x10).readS32() - geometry.add(8).readS32() };
  }

  function stringValue(value) {
    const data = value.add(4).readPointer();
    return data.isNull() ? '' : data.add(0x10).readPointer().readUtf8String();
  }

  function position(controller) {
    return [controller.add(0x34).readPointer(), controller.add(0x80).readS32(),
      controller.add(0x98).readS32(), controller.add(0x9c).readS32()].join(':');
  }

  function block(controller) {
    return stringValue(controller.add(0x84));
  }

  function atPosition() {
    return active && active.valid && position(active.controller) === active.position;
  }

  function atTarget() {
    return atPosition() && block(active.controller) === active.block;
  }

  function undoIndex() {
    return active.editor.add(0x294).readS32();
  }

  function insertNam() {
    const controller = active.controller;
    const list = controller.add(0x58).readPointer();
    if (list.isNull()) throw new Error('Reopen Amp → NAM to select the destination.');
    for (let index = 0, count = rowCount(list); index < count; index++) {
      if (getIrRow(list, index).readUtf8String() !== nam) continue;
      clearSelection(list, 0, 0);
      selectRow(list, 1, index, 0, 0);
      modelEvent(controller, selectionEvent, list, NULL, NULL);
      return;
    }
    throw new Error('Reopen Amp → NAM to select the destination.');
  }

  function ensureEntry(controller) {
    const list = controller.add(0x58).readPointer();
    if (list.isNull() || rowCount(list) !== 1) return;
    const row = getIrRow(list, 0);
    if (row.isNull() || row.readUtf8String() !== nam) return;
    appendRow(list, -1, label, row.add(0x104).readPointer(), 0, row.add(0x100).readS32(),
      row.add(0x10c).readPointer(), 0, 0);
  }

  Interceptor.attach(base.add(0x380940), {
    onEnter(args) {
      if (!this.context.ecx.readPointer().equals(base.add(0x91fcd0)) || args[1].isNull() ||
          args[1].readUtf8String() !== nam || args[5].isNull()) return;
      this.list = this.context.ecx;
      this.image = args[2];
      this.index = args[4].toInt32();
      this.model = args[5];
    },
    onLeave() {
      if (this.list) appendRow(this.list, -1, label, this.image, 0, this.index, this.model, 0, 0);
    },
  });

  Interceptor.replace(eventAddress, new NativeCallback(function (controller, event, sender, data, flags) {
    if (event !== selectionEvent || sender.isNull() || !sender.equals(controller.add(0x58).readPointer())) {
      modelEvent(controller, event, sender, data, flags);
      if (event === selectionEvent || event === 0x21617663) ensureEntry(controller);
      return;
    }
    const row = selectedRow(sender);
    if (row.isNull() || row.readUtf8String() !== 'TONE3000') {
      return modelEvent(controller, event, sender, data, flags);
    }
    clearSelection(sender, 0, 0);
    if (active) {
      messageBox(getActiveWindow(), Memory.allocUtf16String('Finish the current TONE3000 selection first.'), title, 0x40);
      return;
    }
    const window = getActiveWindow();
    const editor = controller.add(0x34).readPointer();
    if (window.isNull() || editor.isNull() || !editor.readPointer().add(0xdc).readPointer().equals(base.add(0x51aaf0))) return;
    const panel = parameterPanel(sender);
    const bounds = panel.isNull() ? null : panelBounds(panel);
    if (!bounds || !bounds.visible || bounds.w < 60 || bounds.h < 60) {
      messageBox(window, Memory.allocUtf16String('The TONE3000 pane cannot fit in the current editor view.'), title, 0x40);
      return;
    }
    active = { id: ++nextSession, controller, editor, position: position(controller),
      block: block(controller), window, valid: true, panel, layout: JSON.stringify(bounds) };
    active.selectionUndo = undoIndex();
    send({ type: 'toneStart', session: active.id, window: window.toUInt32(), bounds });
  }, 'void', eventTypes, 'thiscall'));

  Interceptor.attach(base.add(0x216e00), {
    onEnter() {
      if (active && active.controller.equals(this.context.ecx)) {
        active.valid = false;
        active.panel = NULL;
      }
    },
  });

  Interceptor.attach(base.add(0x218a00), {
    onEnter(args) {
      this.ours = active && active.controller.equals(this.context.ecx);
      if (!this.ours) return;
      const event = stringValue(args[0]);
      if (event === 'EditBuffer_PresetSavedToDevice') active.deviceSaved = true;
      if (/^EditBuffer_(?:TargetDeviceChanged|DevicePresetChanged|PresetChanged|HelixSnapshotWillChange)$/.test(event)) {
        active.valid = false;
      }
    },
    onLeave() {
      if (this.ours && active && !active.applying && !(active.inserting ? atPosition() : atTarget())) {
        active.valid = false;
      }
    },
  });

  function reply(request, result) {
    send({ type: 'toneReply', id: request.id, ...result });
  }

  function finishTransfer(transfer) {
    if (toneImport !== transfer) return;
    toneImport = null;
    if (namImportController.equals(transfer.controller)) namImportController = NULL;
  }

  function poll(request, next, timeout = 12000) {
    const deadline = Date.now() + timeout;
    function check() {
      if (!active || request.session !== active.id) return;
      command = { request, next, deadline, check };
      if (!post(active.window, wake, 0, 0)) {
        command = null;
        reply(request, { error: 'HX Edit closed during the TONE3000 operation.' });
      }
    }
    check();
  }

  function awaitImport(request, transfer, imported) {
    poll(request, expired => {
      if (transfer.error) {
        finishTransfer(transfer);
        throw new Error(transfer.error);
      }
      if (!namView.previewName(transfer)) {
        if (!expired && (request.action === 'save' || atTarget())) return null;
        finishTransfer(transfer);
        throw new Error(`HX Edit did not confirm the import. Check User IR ${transfer.slot} before retrying.`);
      }
      finishTransfer(transfer);
      imported();
      return {};
    });
  }

  function applyProfile(request, transfer) {
    if (!atTarget() || undoIndex() !== active.selectionUndo) {
      throw new Error(`The target changed. The downloaded profile is in User IR ${transfer.slot}.`);
    }
    const saving = request.action === 'save';
    if (!saving) active.transfer = transfer;
    active.undoBefore = undoIndex();
    active.originalSlot = namView.modelSlot();
    active.inserting = active.originalSlot === null;
    if (active.inserting) insertNam();
    let selecting = false;
    poll(request, expired => {
      if (!(active.inserting ? atPosition() : atTarget())) {
        throw new Error(`The target changed. The downloaded profile is in User IR ${transfer.slot}.`);
      }
      if (namView.modelSlot() === null && !expired) return null;
      if (active.inserting) {
        // Inserting into an empty cell gives it a block ID after the native edit.
        if (undoIndex() === active.undoBefore && !expired) return null;
        if (undoIndex() !== active.undoBefore + 1) {
          throw new Error(`HX Edit did not confirm the new block. Check User IR ${transfer.slot}.`);
        }
        active.block = block(active.controller);
        active.inserting = false;
      }
      if (!selecting) selecting = saving ? namView.selectProfile(transfer) : namView.playPreview(transfer);
      if (!selecting || namView.modelSlot() !== transfer.slot) {
        if (!expired) return null;
        throw new Error(`Could not apply the profile. Check User IR ${transfer.slot} on Helix.`);
      }
      const freeSlots = namView.freeSlots(active.previewSlot);
      if (saving) {
        active.selectionUndo = undoIndex();
        return { savedSlot: transfer.slot, freeSlots };
      }
      active.undoAfter = undoIndex();
      return { slot: transfer.slot, freeSlots };
    }, 3500);
  }

  function playing(transfer) {
    return transfer && atTarget() && active.undoAfter !== undefined &&
      namView.modelSlot() === transfer.slot && !!namView.previewName(transfer);
  }

  function canRestore(transfer) {
    return playing(transfer) && !active.deviceSaved && active.undoAfter === undoIndex();
  }

  function restore() {
    const { transfer, editor, undoBefore, undoAfter } = active;
    if (!transfer) return {};
    const retained = { notice: `Check User IR ${transfer.slot}. The audition profile was left on Helix.` };
    if (!canRestore(transfer)) return retained;
    const steps = undoAfter - undoBefore;
    if (steps < 0 || steps > 2 || (!steps && active.originalSlot !== transfer.slot)) return retained;
    const undo = new NativeFunction(editor.readPointer().add(0xdc).readPointer(), 'int', ['pointer'], 'thiscall');
    active.applying = true;
    try {
      for (let step = 0; step < steps; step++) {
        if (undo(editor) < 0 || undoIndex() !== undoAfter - step - 1) return retained;
      }
      if (!atPosition()) return retained;
      active.block = block(active.controller);
    } finally {
      active.applying = false;
    }
    return namView.clearPreview(transfer) ? { clearing: transfer } : retained;
  }

  const commandAddress = base.add(0x35e800);
  const dispatch = new NativeFunction(commandAddress, 'uint8', ['pointer', 'pointer'], 'thiscall');
  Interceptor.replace(commandAddress, new NativeCallback(function (app, event) {
    if (active && active.transfer && !event.isNull() && event.readU32() === 0x1b) {
      messageBox(active.window, Memory.allocUtf16String(
        'Use Save to Helix in TONE3000 before saving a preset with an audition profile.'), title, 0x40);
      return 0;
    }
    return dispatch(app, event);
  }, 'uint8', ['pointer', 'pointer'], 'thiscall'));

  function afterRestore(request, result, saved) {
    if (request.action !== 'close') {
      if (result.notice) throw new Error(result.notice);
      active.selectionUndo = undoIndex();
      active.undoAfter = undefined;
      active.deviceSaved = false;
      if (saved) {
        applyProfile(request, saved);
      } else {
        active.previewSlot ??= namView.freeSlots()[0];
        if (!active.previewSlot) throw new Error('No free User IR slots on the Helix.');
        const transfer = namView.importPreview(request.file, active.previewSlot);
        awaitImport(request, transfer, () => applyProfile(request, transfer));
      }
    } else {
      active = null;
      reply(request, result);
    }
    return {};
  }

  function finishRestore(request, result, saved) {
    if (result.notice && request.action !== 'close') throw new Error(result.notice);
    namView.stopPreview();
    active.transfer = null;
    if (result.clearing) {
      const transfer = result.clearing;
      poll(request, expired => {
        if (namView.previewSlotEmpty(transfer)) return afterRestore(request, {}, saved);
        return expired ? afterRestore(request, { notice: `Could not verify that User IR ${transfer.slot} was cleared.` }, saved) : null;
      }, 3500);
    } else {
      afterRestore(request, result, saved);
    }
  }

  function run(request) {
    if (request.action === 'save') {
      const trial = active.transfer;
      if (!canRestore(trial)) throw new Error('The audition changed. Reopen TONE3000 on the desired block.');
      const { slot } = request;
      if (!Number.isInteger(slot) || slot < 1 || slot > 128 || slot === active.previewSlot) {
        throw new Error('Select a different free User IR slot.');
      }
      const saved = namView.importPreview(trial.file, slot);
      awaitImport(request, saved, () => {
        if (!namView.registerProfile(saved)) throw new Error(`Check User IR ${slot} on Helix.`);
        request.savedSlot = slot;
        finishRestore(request, restore(), saved);
      });
      return;
    }
    if (request.action === 'audition' && (!atTarget() ||
        (!active.transfer && active.selectionUndo !== undoIndex()))) {
      throw new Error('The target changed. Select TONE3000 again on the desired block.');
    }
    finishRestore(request, restore());
  }

  Interceptor.attach(user32.getExportByName('DispatchMessageW'), {
    onEnter(args) {
      if (!active || !args[0].readPointer().equals(active.window)) return;
      const event = args[0].add(4).readU32();
      if (event === 5 || event === 0xf || event === 0x47 || event === 0x202 || event === wake) {
        this.layoutSession = active.id;
      }
      if (!command || event !== wake) return;
      const { request, next, deadline, check } = command;
      command = null;
      try {
        if (!next) return run(request);
        const result = next(Date.now() >= deadline);
        if (result === null) setTimeout(check, 75);
        else if ('slot' in result || 'savedSlot' in result) reply(request, result);
      } catch (error) {
        const result = { error: String(error.message) };
        if (request.action !== 'close') {
          const transfer = active.transfer;
          if (playing(transfer)) result.slot = transfer.slot;
          result.freeSlots = namView.freeSlots(active.previewSlot);
          if (request.savedSlot) result.savedSlot = request.savedSlot;
        }
        reply(request, result);
      }
    },
    onLeave() {
      if (!active || active.id !== this.layoutSession) return;
      const bounds = active.panel.isNull() ? { visible: false } : panelBounds(active.panel);
      const layout = JSON.stringify(bounds);
      if (layout === active.layout) return;
      active.layout = layout;
      send({ type: 'toneBounds', session: active.id, bounds });
    },
  });

  function listen() {
    recv('toneCommand', message => {
      const request = message.payload;
      if (active && active.id === request.session && !command) {
        command = { request };
        if (!post(active.window, wake, 0, 0)) {
          command = null;
          reply(request, { error: 'The HX Edit window is unavailable.' });
        }
      } else {
        reply(request, { error: 'This TONE3000 selection is no longer active.' });
      }
      listen();
    });
  }
  listen();
}
