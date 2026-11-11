'use strict';

// OPENFILENAMEW is the 32-bit Windows layout used by HX Edit 3.82.
const fields = { owner: 4, filter: 12, file: 28, capacity: 32, title: 36,
  titleCapacity: 40, fileOffset: 56, extensionOffset: 58 };
const openFile = Process.getModuleByName('comdlg32.dll').getExportByName('GetOpenFileNameW');
const openFileDialog = new NativeFunction(openFile, 'int', ['pointer'], 'stdcall');
const user32 = Process.getModuleByName('user32.dll');
const getActiveWindow = new NativeFunction(user32.getExportByName('GetActiveWindow'), 'pointer', [], 'stdcall');
const messageBox = new NativeFunction(
  user32.getExportByName('MessageBoxW'),
  'int', ['pointer', 'pointer', 'pointer', 'uint'], 'stdcall');

function readStrings(buffer, capacity) {
  const strings = [];
  for (let index = 0; index < capacity;) {
    const end = index;
    while (index < capacity && buffer.add(index * 2).readU16() !== 0) index++;
    if (index === capacity || end === index) break;
    strings.push(buffer.add(end * 2).readUtf16String(index - end));
    index++;
  }
  return strings;
}

function requestImport(payload) {
  let reply;
  send(payload);
  recv('converted', message => { reply = message.payload; }).wait();
  if (reply.error) throw new Error(reply.error);
  return reply;
}

if (Process.arch !== 'ia32') throw new Error('Expected the 32-bit HX Edit executable.');

// Import button and file drop converge here with the complete batch and its
// actual zero-based destination. Reject before HX Edit starts any transfers.
const base = Process.mainModule.base;
const importAddress = base.add(0x2123c0);
const importTypes = ['pointer', 'pointer', 'int'];
const importFiles = new NativeFunction(importAddress, 'void', importTypes, 'thiscall');
const getIrRow = new NativeFunction(base.add(0x380610), 'pointer', ['pointer', 'int'], 'thiscall');
let namImportController = NULL;
let toneImport = null;
// TONE3000 auditions always use the last User IR; NAM imports and saves stay in 1–127.
const AUDITION_SLOT = 128;

function firstFreeSlot(list, count) {
  if (list.isNull()) return -1;
  let available = 0;
  for (let slot = 0; slot < AUDITION_SLOT - 1; slot++) {
    const row = getIrRow(list, slot);
    available = !row.isNull() && !row.add(0x10c).readU32() ? available + 1 : 0;
    if (available === count) return slot - count + 1;
  }
  return -1;
}

Interceptor.attach(base.add(0x20e020), {
  onEnter() {
    this.controller = this.context.ecx;
    this.nam = this.controller.equals(namImportController);
  },
  onLeave() {
    if (this.nam) {
      namImportController = NULL;
      namView.refreshProfiles(this.controller);
    }
  },
});

Interceptor.replace(importAddress, new NativeCallback(function (controller, batch, first) {
  try {
    const array = batch.add(8).readPointer();
    const begin = batch.add(0x10).readU32();
    const end = batch.add(0x14).readU32();
    if (end === begin) return;
    const list = controller.add(0x3c).readPointer();
    if (array.isNull() || list.isNull()) throw new Error('Could not read the import batch.');
    const namOnly = controller.equals(namImportController);
    if (namOnly) {
      first = toneImport ? toneImport.slot - 1 : firstFreeSlot(list, end - begin);
      if (first < 0) throw new Error('There are not enough consecutive free User IR slots for this batch.');
    }
    if (first < 0 || end < begin || end - begin > 128 || first + end - begin > 128) {
      throw new Error('Select enough consecutive slots within User IR 1–128.');
    }
    const files = [], occupied = [];
    for (let i = begin; i < end; i++) {
      const file = array.add(i * 8 + 4).readPointer();
      const slot = first + i - begin;
      const row = getIrRow(list, slot);
      if (file.isNull() || row.isNull()) throw new Error('Could not read the file or destination slot.');
      files.push(file.add(0x10).readPointer().readUtf8String());
      if (row.add(0x10c).readU32()) occupied.push(slot + 1);
    }
    if (namOnly && toneImport && (files.length !== 1 || !toneImport.supplied ||
        files[0].toLowerCase() !== toneImport.file.toLowerCase())) {
      throw new Error('HX Edit returned a different file for the TONE3000 import.');
    }
    const { profiles } = requestImport({ type: 'validateImport', files, firstSlot: first + 1, occupied, namOnly });
    if (namOnly && toneImport) {
      toneImport.name = profiles[first + 1];
    } else {
      namView.trackImport(first + 1, files.length, profiles);
    }
  } catch (error) {
    if (controller.equals(namImportController) && toneImport) {
      toneImport.error = String(error.message);
      return;
    }
    messageBox(getActiveWindow(), Memory.allocUtf16String(String(error.message)),
      Memory.allocUtf16String('HX Edit NAM Import'), 0x10);
    return;
  }
  importFiles(controller, batch, first);
  namView.refreshProfiles(controller);
}, 'void', importTypes, 'thiscall'));

Interceptor.replace(openFile, new NativeCallback(function (dialog) {
  if (dialog.isNull() || dialog.readU32() < 76) return openFileDialog(dialog);
  const filterField = dialog.add(fields.filter);
  const filters = filterField.readPointer();
  if (filters.isNull()) return openFileDialog(dialog);
  const entries = readStrings(filters, 2048);
  const wav = entries.findIndex((entry, index) => index % 2 && entry.toLowerCase().split(';').includes('*.wav'));
  if (wav < 0) return openFileDialog(dialog);

  const nam = !namImportController.isNull();
  const buffer = dialog.add(fields.file).readPointer();
  const capacity = dialog.add(fields.capacity).readU32();
  const title = dialog.add(fields.title).readPointer();
  const titleCapacity = dialog.add(fields.titleCapacity).readU32();
  if (nam && toneImport && !toneImport.supplied) {
    const file = toneImport.file;
    if (buffer.isNull() || file.length + 2 > capacity) {
      toneImport.error = 'The TONE3000 file path is too long for HX Edit.';
      return 0;
    }
    const offset = file.lastIndexOf('\\') + 1;
    buffer.writeUtf16String(file + '\0');
    dialog.add(fields.fileOffset).writeU16(offset);
    dialog.add(fields.extensionOffset).writeU16(file.length - 3);
    if (!title.isNull() && file.length - offset < titleCapacity) title.writeUtf16String(file.slice(offset));
    toneImport.supplied = true;
    return 1;
  }

  if (nam) {
    entries.splice(0, entries.length, 'NAM A2 Lite profiles (*.nam;*.wav)', '*.nam;*.wav');
  } else {
    entries[wav] += ';*.nam';
    entries[wav - 1] = 'Cabinet IRs and NAM profiles (' + entries[wav] + ')';
  }
  const replacement = Memory.allocUtf16String(entries.join('\0') + '\0');
  filterField.writePointer(replacement);
  let result;
  try {
    result = openFileDialog(dialog);
  } finally {
    filterField.writePointer(filters);
  }
  if (!result) return 0;

  const first = buffer.readUtf16String();
  const multiple = dialog.add(fields.fileOffset).readU16() > first.length;
  const selected = multiple
    ? readStrings(buffer, capacity).slice(1).map(name => first + '\\' + name)
    : [first];
  if (!selected.some(file => /\.nam$/i.test(file))) return result;

  try {
    const { files } = requestImport({ type: 'convert', files: selected });
    const slash = files[0].lastIndexOf('\\');
    const folder = files[0].slice(0, slash);
    const names = files.map(file => file.slice(slash + 1));
    const value = multiple ? [folder, ...names].join('\0') : files[0];
    if (value.length + 2 > capacity || (!multiple && !title.isNull() && names[0].length + 1 > titleCapacity)) {
      throw new Error('The converted file names are too long for the HX Edit import dialog.');
    }
    buffer.writeUtf16String(value + '\0');
    dialog.add(fields.fileOffset).writeU16(slash + 1);
    dialog.add(fields.extensionOffset).writeU16(multiple ? 0 : value.length - 3);
    if (!multiple && !title.isNull()) title.writeUtf16String(names[0]);
  } catch (error) {
    messageBox(dialog.add(fields.owner).readPointer(),
      Memory.allocUtf16String(String(error.message)), Memory.allocUtf16String('NAM A2 Lite import'), 0x10);
    return 0;
  }
  return result;
}, 'int', ['pointer'], 'stdcall'));
