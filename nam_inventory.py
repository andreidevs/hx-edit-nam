"""Read and classify User IR slots before HX Edit claims the editor interface."""

from contextlib import contextmanager
import ctypes as ct
from ctypes import wintypes as win
import struct
import sys
import time
from uuid import UUID


DEVICE_INTERFACE = UUID('fd7bdaab-7d76-b4c8-b9be-209c747294d0')
# Editor interfaces of Helix LT (0x424A) and Helix Floor (0x4248).
INTERFACES = ('vid_0e41&pid_424a&mi_00', 'vid_0e41&pid_4248&mi_00')
BEGIN_EXPORT, END_EXPORT = 0xFF, 0xFE
GET_IR_DATA, GET_IR_INFO = 0x0B, 0x0C


def is_nam_profile(payload):
    if not isinstance(payload, bytes) or len(payload) != 8192:
        return False
    first, second, channels, scale, weights = struct.unpack_from('<5I', payload)
    # Float32 words used by helix-lt-nam's 3-channel, 1871-weight IR format.
    return ((first, second, channels, weights) == (0x3F000000, 0xBF000000, 0x40400000, 0x3FE9E000)
            and 0x3F800000 <= scale <= 0x41000000 and scale & 0x007FFFFF == 0)


def read_profiles(channel):
    from hx_ctl import HxError, clean_name

    profiles = {}
    channel.request(BEGIN_EXPORT, {})
    try:
        for slot in range(128):
            try:
                info = channel.request(GET_IR_INFO, {0x70: slot})
            except HxError:
                continue
            if not isinstance(info, dict) or info.get(0x70) != slot or info.get(0x72) != 1:
                continue
            name = clean_name(info.get(0x6D))
            if not name or name == '<EMPTY>':
                continue
            data = channel.request(GET_IR_DATA, {0x70: slot, 0x65: 2})
            if is_nam_profile(data):
                profiles[slot + 1] = name
    finally:
        channel.request(END_EXPORT, {})
    return profiles


def win_api(dll, name, result, *arguments):
    function = getattr(dll, name)
    function.restype = result
    function.argtypes = arguments
    return function


def device_path():
    cfg = ct.WinDLL('cfgmgr32')
    guid = (ct.c_ubyte * 16).from_buffer_copy(DEVICE_INTERFACE.bytes_le)
    count = win.ULONG()
    size = win_api(cfg, 'CM_Get_Device_Interface_List_SizeW', win.ULONG,
                   ct.POINTER(win.ULONG), ct.c_void_p, win.LPCWSTR, win.ULONG)
    read = win_api(cfg, 'CM_Get_Device_Interface_ListW', win.ULONG,
                   ct.c_void_p, win.LPCWSTR, win.LPWSTR, win.ULONG, win.ULONG)
    if size(ct.byref(count), guid, None, 0):
        raise OSError('Could not enumerate Line 6 WinUSB interfaces.')
    paths = ct.create_unicode_buffer(count.value)
    if read(guid, None, paths, count, 0):
        raise OSError('Could not read the Line 6 WinUSB interface list.')
    matches = [path for path in paths[:].split('\0') if any(i in path.lower() for i in INTERFACES)]
    if len(matches) > 1:
        raise OSError('Connect one Helix to scan NAM profiles.')
    return matches[0] if matches else None


class PipeInfo(ct.Structure):
    _fields_ = [('type', ct.c_int), ('endpoint', ct.c_ubyte),
                ('packet_size', ct.c_ushort), ('interval', ct.c_ubyte)]


class UsbLink:
    def __init__(self, usb, handle):
        self.handle = handle
        self.endpoints = {}
        query = win_api(usb, 'WinUsb_QueryPipe', win.BOOL, win.HANDLE, ct.c_ubyte,
                        ct.c_ubyte, ct.POINTER(PipeInfo))
        for index in range(2):
            pipe = PipeInfo()
            if not query(handle, 0, index, ct.byref(pipe)) or pipe.type != 2:
                raise OSError('The Helix editor interface has unexpected USB endpoints.')
            self.endpoints[bool(pipe.endpoint & 0x80)] = pipe.endpoint
            if pipe.endpoint & 0x80:
                self.mtu = pipe.packet_size
        if len(self.endpoints) != 2:
            raise OSError('The Helix did not expose both bulk directions.')
        signature = (win.HANDLE, ct.c_ubyte, ct.c_void_p, win.ULONG, ct.POINTER(win.ULONG), ct.c_void_p)
        self.read_pipe = win_api(usb, 'WinUsb_ReadPipe', win.BOOL, *signature)
        self.write_pipe = win_api(usb, 'WinUsb_WritePipe', win.BOOL, *signature)
        self.policy = win_api(usb, 'WinUsb_SetPipePolicy', win.BOOL,
                              win.HANDLE, ct.c_ubyte, win.ULONG, win.ULONG, ct.c_void_p)
        self.timeout = None

    def set_timeout(self, reading, timeout):
        value = win.ULONG(timeout)
        if not self.policy(self.handle, self.endpoints[reading], 3, ct.sizeof(value), ct.byref(value)):
            raise ct.WinError(ct.get_last_error())

    def write(self, data, _description):
        count = win.ULONG()
        if not self.write_pipe(self.handle, self.endpoints[False], data, len(data), ct.byref(count), None):
            raise ct.WinError(ct.get_last_error())
        if count.value != len(data):
            raise OSError('Short Helix USB write.')

    def read(self, timeout_ms=100):
        if timeout_ms != self.timeout:
            self.set_timeout(True, timeout_ms)
            self.timeout = timeout_ms
        buffer = ct.create_string_buffer(max(self.mtu, 512))
        count = win.ULONG()
        if self.read_pipe(self.handle, self.endpoints[True], buffer, len(buffer), ct.byref(count), None):
            return buffer.raw[:count.value]
        error = ct.get_last_error()
        if error == 121:
            return b''
        raise ct.WinError(error)


@contextmanager
def open_link(path):
    kernel = ct.WinDLL('kernel32', use_last_error=True)
    usb = ct.WinDLL('winusb', use_last_error=True)
    create = win_api(kernel, 'CreateFileW', win.HANDLE, win.LPCWSTR, win.DWORD, win.DWORD,
                     ct.c_void_p, win.DWORD, win.DWORD, win.HANDLE)
    close = win_api(kernel, 'CloseHandle', win.BOOL, win.HANDLE)
    initialize = win_api(usb, 'WinUsb_Initialize', win.BOOL, win.HANDLE, ct.POINTER(win.HANDLE))
    free = win_api(usb, 'WinUsb_Free', win.BOOL, win.HANDLE)
    file = create(path, 0xC0000000, 3, None, 3, 0x40000000, None)
    if file == ct.c_void_p(-1).value:
        raise ct.WinError(ct.get_last_error())
    try:
        handle = win.HANDLE()
        if not initialize(file, ct.byref(handle)):
            raise ct.WinError(ct.get_last_error())
        try:
            link = UsbLink(usb, handle)
            link.set_timeout(False, 2000)
            yield link
        finally:
            free(handle)
    finally:
        close(file)


def scan_profiles(firmware_tools):
    path = device_path()
    if not path:
        return {}
    with open_link(path) as link:
        return scan_link(firmware_tools, link)


def scan_link(firmware_tools, link):
    sys.path.insert(0, str(firmware_tools))
    try:
        from hx_ctl import Channel, LIBRARIAN
    finally:
        sys.path.pop(0)
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline and link.read(50):
        pass
    channel = Channel(link, timeout=1.5, **LIBRARIAN)
    try:
        return read_profiles(channel)
    finally:
        channel.close()
