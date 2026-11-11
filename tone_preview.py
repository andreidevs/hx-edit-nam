"""Run the catalog off the HX Edit GUI thread and show the active audition."""

from html import escape
import os
from pathlib import Path
from queue import Empty, Queue
from string import Template
from threading import Lock, Thread, current_thread
from time import monotonic
from urllib.parse import urlsplit

import tempfile

from nam_convert import convert_batch
from nam_library import render_library
from tone3000 import API_HOSTS, ORIGIN, ToneError, get_tone, prepare_model, select_tone
from tone_browser import ToneBrowser


CARD = Path(__file__).with_name('tone_card.html')
KEY_HELP = ('Set T3K_PUBLISHABLE_KEY to the publishable key from TONE3000 → Settings → API Keys '
            'and restart HX Edit NAM.')


def render_card(tone=None, models=(), library=False):
    visible = tone is not None
    tone = tone or {}
    cover = (tone.get('images') or [''])[0]
    image = f'<img src="{escape(cover)}" alt="">' if urlsplit(cover).scheme == 'https' else ''
    return Template(CARD.read_text(encoding='utf-8')).substitute(
        hidden='' if visible else 'hidden',
        title=escape(tone.get('title', '')), author=escape('@' + tone.get('user', {}).get('username', '')),
        gear=escape(tone.get('gear', '')), license=escape(tone.get('license', '')), cover=image,
        options=''.join(f'<option value="{int(model["id"])}">{escape(model["name"])}</option>'
                        for model in models),
        library='' if library else 'hidden',
    )


class TonePreview:
    def __init__(self, script, workspace, converter, detached, message, *, browser_factory=ToneBrowser, client_id='',
                 library=None):
        self.script = script
        self.library = library  # nam_library.Library on Windows; None hides the library
        self.workspace = workspace
        self.converter = converter
        self.detached = detached
        self.message = message
        self.browser_factory = browser_factory
        self.client_id = client_id
        self.replies = Queue()
        self.thread = None
        self.lifecycle_lock = Lock()
        self.browser = None
        self.bounds = None
        self.session = None
        self.sequence = 0

    def receive(self, payload):
        if payload['type'] == 'toneReply':
            self.replies.put(payload)
        elif payload['type'] == 'toneBounds':
            if payload['session'] == self.session:
                self.bounds = payload['bounds']
                if self.browser:
                    self.browser.send('bounds', **self.bounds)
        else:
            with self.lifecycle_lock:
                if not self.thread or not self.thread.is_alive():
                    self.session = payload['session']
                    self.bounds = payload['bounds']
                    self.thread = Thread(target=self.run, args=(self.session, payload['window']), daemon=True)
                    self.thread.start()
                    return
            self.script.post({'type': 'toneCommand', 'payload': {
                'session': payload['session'], 'action': 'close', 'id': 0}})

    def command(self, session, action, **data):
        if self.detached.is_set():
            raise ToneError('HX Edit closed during the TONE3000 audition.')
        self.sequence += 1
        sequence = self.sequence
        self.script.post({'type': 'toneCommand', 'payload': {
            'id': sequence, 'session': session, 'action': action, **data}})
        deadline = monotonic() + 35
        while monotonic() < deadline and not self.detached.is_set():
            try:
                reply = self.replies.get(timeout=0.25)
            except Empty:
                continue
            if reply['id'] == sequence:
                if reply.get('error') and action == 'close':
                    raise ToneError(reply['error'])
                return reply
        raise ToneError('HX Edit did not confirm the operation. Check the IRs tab before retrying.')

    def run(self, session, window):
        browser = None
        notice = None
        slot = None
        try:
            client_id = (self.client_id or os.environ.get('T3K_PUBLISHABLE_KEY', '')).strip()
            if not client_id.startswith('t3k_pub_'):
                if not self.library:
                    raise ToneError(KEY_HELP)
                client_id = ''  # the local library still works without a TONE3000 key
            browser = self.browser = self.browser_factory(window, self.bounds, self.detached)
            if browser.wait_ready():
                browser.send('card', html=render_card(library=bool(self.library)), has_tone=False)
                slot = self.browse(browser, session, client_id)
        except (ToneError, ValueError, OSError) as error:
            if not self.detached.is_set():
                notice = (str(error), 0x10)
        except Exception:
            if not self.detached.is_set():
                notice = ('Could not complete the TONE3000 audition. Check the IRs tab before retrying.', 0x10)
        finally:
            if browser:
                browser.close()
                self.browser = None
            if not self.detached.is_set():
                try:
                    reply = self.command(session, 'close')
                    if reply.get('notice'):
                        notice = (reply['notice'], 0x40)
                except (ToneError, OSError) as error:
                    notice = notice or (str(error), 0x10)
            elif slot is not None:
                notice = (f'Check User IR {slot}. The audition profile may still be on Helix.', 0x40)
            # Device cleanup and close acknowledgement have finished. A modal
            # notice can remain open indefinitely; it must not reject new starts.
            # An old notice thread must never clear a newer session's ownership.
            with self.lifecycle_lock:
                if self.thread is current_thread():
                    self.thread = None
            if notice:
                self.message(*notice)

    def browse(self, browser, session, client_id):
        current = None
        slot = None
        selected = 0
        worker = None
        free_slots = []
        trial = 0
        kept = None  # the current trial's capture for Add to library / Save to Helix
        text = ''
        library = False

        def select():
            try:
                result = select_tone(client_id, browser, open_browser=browser.navigate)
                browser.actions.put((result, None))
            except (ToneError, ValueError, OSError, KeyError) as error:
                browser.actions.put((None, str(error)))

        def start_selection():
            nonlocal worker
            worker = Thread(target=select, daemon=True)
            worker.start()

        def status(message, busy=False):
            nonlocal text
            if not busy:
                text = message
            browser.send('status', text=message, busy=busy, trial=trial if slot is not None else None,
                         free_slots=free_slots, model=selected, keep=bool(self.library) and kept is not None and 'id' not in kept)

        def show_card():
            if library:
                browser.send('card', html=render_library(self.library.entries()), has_tone=False, library=True)
            elif current:
                browser.send('card', html=render_card(*current[:2], library=bool(self.library)), has_tone=True)
            else:
                browser.send('card', html=render_card(library=bool(self.library)), has_tone=False)
            status(text)

        def play(prepare, capture):
            """Audition a converted profile; return the status text, or None when already reported."""
            nonlocal slot, free_slots, trial, kept
            try:
                path = prepare()
                if browser.is_set():
                    return None
                slot = None
                reply = self.command(session, 'audition', file=path)
                slot = reply.get('slot')
                free_slots = reply.get('freeSlots', [])
                if reply.get('error'):
                    raise ToneError(reply['error'])
                trial += 1
                kept = capture(path) if self.library else None
                message = f'Auditioning in User IR {slot}.'
                if not free_slots:
                    message += ' No other free slot to save to.'
            except (ValueError, ToneError, OSError) as error:
                message = str(error)
                if slot is not None:
                    status(message)
                    return None
            return message

        def audition(candidate, index):
            nonlocal current, selected
            tone, models, token = candidate
            status('Downloading and loading the selected profile…', busy=True)

            def capture(path):
                source = tone.get('url') or f'{ORIGIN}/tones/{int(tone["id"])}'
                name = ' – '.join(part for part in (tone.get('title', ''), models[index]['name']) if part)
                return dict(path=Path(self.workspace, 'captures', Path(path).stem + '.nam'),
                            name=name, gear=tone.get('gear', ''), source=source)

            message = play(lambda: prepare_model(models[index], token, self.workspace, self.converter), capture)
            if message is None:
                return
            if current is not candidate:
                current = candidate
                if not library:
                    browser.send('card', html=render_card(tone, models, library=bool(self.library)), has_tone=True)
            selected = index
            status(message)

        def audition_local(identity):
            nonlocal current
            status('Loading the capture from the library…', busy=True)

            def prepare():
                folder = tempfile.mkdtemp(prefix='library-', dir=self.workspace)
                return convert_batch([self.library.export(identity, folder)], self.workspace, self.converter)[0]

            message = play(prepare, lambda _path: dict(id=identity))
            if message is not None:
                current = None  # the TONE3000 card no longer describes the audition
                status(message)

        def keep():
            if kept and 'id' not in kept and kept['path'].is_file():
                kept['id'] = self.library.add(kept['path'], name=kept['name'], gear=kept['gear'],
                                              source=kept['source'])

        if client_id:
            start_selection()
        else:
            library = True
            show_card()
        while (action := browser.next_action()) is not None:
            if isinstance(action, tuple):
                selection, error = action
                worker = None
                if error:
                    browser.send('browseError', text=error)
                    continue
                if selection is None:
                    break
                else:
                    start_selection()
                    tone_id, token = selection
                    try:
                        tone, models = get_tone(tone_id, token)
                        audition((tone, models, token), 0)
                    except (ToneError, ValueError, OSError) as error:
                        status(str(error))
                    continue
            if action == 'cancel':
                break
            if action == 'finish':
                break
            if action.startswith('save:'):
                if slot is None:
                    continue
                prefix, _, destination = action.rpartition(':')
                if prefix != f'save:{trial}' or not any(destination == str(free) for free in free_slots):
                    continue
                status(f'Saving to User IR {destination}…', busy=True)
                try:
                    reply = self.command(session, 'save', slot=int(destination))
                    slot = reply.get('slot')
                    free_slots = reply.get('freeSlots', [])
                    message = f'Saved in User IR {reply["savedSlot"]}.' if reply.get('savedSlot') else ''
                    if reply.get('savedSlot') and self.library:
                        try:
                            keep()
                        except (OSError, ValueError) as error:
                            message += f' Could not add it to the library: {error}'
                    if reply.get('error'):
                        message = f'{message} {reply["error"]}'.strip()
                    status(message)
                except ToneError as error:
                    status(str(error))
                continue
            if self.library:
                command, _, argument = action.partition(':')
                identity, _, value = argument.partition(':')
                try:
                    if command in {'library', 'catalog'}:
                        if command == 'catalog' and not client_id:
                            status(KEY_HELP)
                            continue
                        library = command == 'library'
                        show_card()
                    elif command == 'keep' and argument == str(trial):
                        keep()
                        status('Added to the library on this PC.')
                    elif command == 'pick' and identity in self.library.entries():
                        audition_local(identity)
                    elif command == 'gear':
                        self.library.update(identity, gear=value)
                    elif command == 'remove':
                        self.library.remove(identity)
                except (OSError, ValueError, KeyError) as error:
                    status(f'Library: {error}')
            if action == 'retry' and worker is None and client_id:
                start_selection()
            if current is None:
                continue
            tone, models, _ = current
            if action == 'source':
                original = tone.get('url') or ''
                location = urlsplit(original)
                if location.scheme != 'https' or location.netloc not in API_HOSTS:
                    original = f'{ORIGIN}/tones/{int(tone["id"])}'
                browser.send('source', url=original)
            elif action.startswith('model:'):
                for index, model in enumerate(models):
                    if action[6:] == str(model['id']):
                        audition(current, index)
                        break
        return slot
