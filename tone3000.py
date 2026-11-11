"""TONE3000 Select and authenticated downloads for the Windows launcher."""

import base64
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
import secrets
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from nam_convert import IR_NAME_LIMIT, convert_batch


ORIGIN = 'https://www.tone3000.com'
API = ORIGIN + '/api/v1'
CALLBACK = '/callback'
MAX_MODEL_BYTES = 4 * 1024 * 1024
API_HOSTS = {'tone3000.com', 'www.tone3000.com'}
WINDOWS_DEVICE = re.compile(r'CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$', re.IGNORECASE)


class ToneError(Exception):
    pass


class NoAuthRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        if urlsplit(url).scheme != 'https':
            raise ToneError('TONE3000 returned an insecure redirect.')
        redirect = super().redirect_request(request, fp, code, message, headers, url)
        if redirect is not None:
            redirect.remove_header('Authorization')
        return redirect


def read_url(url, *, token=None, form=None, limit=MAX_MODEL_BYTES):
    headers = {'User-Agent': 'HX Edit NAM (TONE3000 Select)'}
    if token:
        parts = urlsplit(url)
        if parts.scheme != 'https' or parts.netloc not in API_HOSTS or not parts.path.startswith('/api/v1/'):
            raise ToneError('TONE3000 returned an unexpected model URL.')
        headers['Authorization'] = f'Bearer {token}'
    request = Request(url, data=urlencode(form).encode() if form else None, headers=headers)
    try:
        with build_opener(NoAuthRedirect()).open(request, timeout=15) as response:
            data = response.read(limit + 1)
    except HTTPError as error:
        if error.code in {401, 403}:
            raise ToneError('TONE3000 denied access. Reopen the catalog and sign in again.') from None
        if error.code == 429:
            raise ToneError('TONE3000 is rate limiting requests. Try again in a moment.') from None
        raise ToneError(f'TONE3000 returned HTTP {error.code}.') from None
    except (URLError, OSError) as error:
        raise ToneError('Could not reach TONE3000. Check your connection and try again.') from error
    if len(data) > limit:
        raise ToneError('The TONE3000 response exceeded the download limit.')
    return data


def callback_result(path, state):
    parts = urlsplit(path)
    query = parse_qs(parts.query, keep_blank_values=True)
    if parts.path != CALLBACK or not secrets.compare_digest(
            query.get('state', [''])[0].encode(), state.encode()):
        return False, None
    if any(len(values) != 1 for values in query.values()):
        return False, None
    if query.get('canceled') == ['true'] or query.get('error') == ['access_denied']:
        return True, None
    if 'error' in query:
        return True, ToneError('TONE3000 could not complete sign-in.')
    code = query.get('code', [''])[0]
    tone_id = query.get('tone_id', [''])[0]
    if not code or len(code) > 2048 or not re.fullmatch(r'[1-9][0-9]{0,17}', tone_id):
        return False, None
    return True, (code, int(tone_id))


def select_tone(client_id, stopped, *, open_browser):
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    state = secrets.token_urlsafe(32)
    done, result = False, None

    class Callback(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(1)

        def do_GET(self):
            nonlocal done, result
            if self.headers.get('Host') == f'127.0.0.1:{server.server_port}' and not done:
                done, result = callback_result(self.path, state)
            body = (b'Loading the selected tone in HX Edit NAM...' if done
                    else b'Invalid or expired HX Edit NAM request.')
            self.send_response(200 if done else 400)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass  # Callback URLs contain the OAuth code.

    with HTTPServer(('127.0.0.1', 0), Callback) as server:
        server.timeout = 0.25
        redirect = f'http://127.0.0.1:{server.server_port}{CALLBACK}'
        params = dict(client_id=client_id, redirect_uri=redirect, response_type='code',
                      code_challenge=challenge, code_challenge_method='S256', state=state,
                      prompt='select_tone', gears='amp_amp-cab_pedal', format='nam', architecture='2',
                      menubar='true')
        if not open_browser(f'{API}/oauth/authorize?{urlencode(params)}'):
            if stopped.is_set():
                return None
            raise ToneError('Could not open the TONE3000 catalog in your browser.')
        # The open catalog keeps this callback URL until it returns a selection.
        while not done and not stopped.is_set():
            server.handle_request()
    if stopped.is_set() or result is None:
        return None
    if isinstance(result, ToneError):
        raise result
    code, tone_id = result
    form = dict(grant_type='authorization_code', code=code, code_verifier=verifier,
                redirect_uri=redirect, client_id=client_id)
    token = json.loads(read_url(f'{API}/oauth/token', form=form))['access_token']
    return tone_id, token


def get_tone(tone_id, token):
    tone = json.loads(read_url(f'{API}/tones/{tone_id}?architecture=2', token=token))
    if tone['format'] != 'nam' or tone['gear'] not in {'amp', 'amp-cab', 'pedal'}:
        raise ToneError('Choose a NAM amp, amp + cab or pedal tone.')
    models = []
    for page in range(1, 11):
        query = urlencode(dict(tone_id=tone_id, architecture=2, page=page, page_size=100))
        batch = json.loads(read_url(f'{API}/models?{query}', token=token))
        models.extend(model for model in batch['data'] if model['architecture_version'] in (2, '2'))
        if page >= batch['total_pages']:
            break
    if not models:
        raise ToneError('This tone has no A2 profiles.')
    return tone, models


def prepare_model(model, token, workspace, converter):
    with tempfile.TemporaryDirectory(prefix='tone-download-', dir=workspace) as folder:
        # HX Edit can rewrite non-ASCII paths in the native import batch.
        ascii_name = model['name'].encode('ascii', 'ignore').decode('ascii')
        label = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', '_', ascii_name).strip(' .')
        # A dot after a DOS device name still makes the filename reserved on Windows.
        if '.' in label and WINDOWS_DEVICE.fullmatch(label.split('.', 1)[0].rstrip()):
            label = '_' + label
        number = str(int(model['id']))
        if len(number) > IR_NAME_LIMIT - len('T3K ') or number == '0' or number.startswith('-'):
            raise ToneError('TONE3000 returned an invalid profile ID.')
        label = label[:IR_NAME_LIMIT - len(number) - 1].rstrip(' .')
        name = f'{label} {number}' if label else f'T3K {number}'
        capture = Path(folder, name + '.nam')
        capture.write_bytes(read_url(model['model_url'], token=token))
        converted = convert_batch([capture], workspace, converter)[0]
        # Keep the original for Add to library and Save to Helix during this session.
        kept = Path(workspace, 'captures')
        kept.mkdir(exist_ok=True)
        capture.replace(kept / capture.name)
        return converted
