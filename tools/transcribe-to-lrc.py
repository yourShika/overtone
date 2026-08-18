#!/usr/bin/env python3
"""
Turn an audio file you already have into a synced .lrc for Overtone.

For songs no lyrics database knows. Transcribes with Whisper through stable-ts,
regroups the words into sung lines, and writes the result straight into
Overtone's lyrics folder, where the agent picks it up on the next play.

    python tools/transcribe-to-lrc.py song.mp3 --video-id o33IHl7-g9Y
    python tools/transcribe-to-lrc.py song.mp3 --name "doli - 162020"

Requires stable-ts and faster-whisper:

    python -m pip install stable-ts faster-whisper

This deliberately transcribes a file you point it at. It does not download
anything: fetching audio from YouTube is blocked by the site and, for some
streams, protected by DRM.

Whisper guesses. Expect errors on sung vocals, especially over a dense mix, and
treat the output as a first draft you can correct — the .lrc is plain text, and
Overtone never overwrites a file you have edited.
"""

import argparse
import os
import re
import sys

MANAGED_MARKER = '[re:overtone]'

# Windows rejects these; Overtone's own safeName strips exactly the same set.
ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def lyrics_dir() -> str:
    """Overtone's lyrics folder, per platform."""
    if sys.platform == 'win32':
        base = os.environ.get('APPDATA')
        if not base:
            raise SystemExit('APPDATA is not set; pass --out explicitly.')
        return os.path.join(base, 'Overtone', 'lyrics')
    if sys.platform == 'darwin':
        return os.path.expanduser('~/Library/Application Support/Overtone/lyrics')
    return os.path.expanduser('~/.config/Overtone/lyrics')


def safe_name(value: str) -> str:
    cleaned = ILLEGAL.sub('', value)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned.rstrip('. ')[:120]


def timestamp(seconds: float) -> str:
    seconds = max(0.0, seconds)
    minutes = int(seconds // 60)
    return '[%02d:%05.2f]' % (minutes, seconds - minutes * 60)


def transcribe(path: str, model_name: str, language, device: str):
    from stable_whisper import load_faster_whisper

    print('Loading Whisper %r on %s ...' % (model_name, device), file=sys.stderr)
    model = load_faster_whisper(
        model_name,
        device=device,
        compute_type='int8' if device == 'cpu' else 'float16',
    )

    print('Transcribing (this takes a while on CPU) ...', file=sys.stderr)
    result = model.transcribe_stable(path, language=language, regroup=False)

    # Regrouping decides where one lyric line ends. Sung lines follow breaths
    # and phrases rather than punctuation, which Whisper rarely emits for
    # singing, so gaps carry most of the signal here. The length cap keeps a
    # line inside Discord's 128-character field.
    (
        result
        .clamp_max()
        .split_by_punctuation([('.', ' '), '?', ('!', ' ')])
        .split_by_gap(0.6)
        .split_by_length(90)
    )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('audio', help='audio file to transcribe')
    parser.add_argument('--video-id', help='YouTube id; the exact name Overtone looks for first')
    parser.add_argument('--name', help='fallback name, e.g. "Artist - Title"')
    parser.add_argument('--model', default='small', help='Whisper model (default: small)')
    parser.add_argument('--language', default=None, help='force a language, e.g. pl')
    parser.add_argument('--device', default='cpu', choices=['cpu', 'cuda'])
    parser.add_argument('--out', help='output directory (default: Overtone lyrics folder)')
    parser.add_argument('--title', default='', help='[ti:] tag')
    parser.add_argument('--artist', default='', help='[ar:] tag')
    args = parser.parse_args()

    if not os.path.isfile(args.audio):
        raise SystemExit('No such file: %s' % args.audio)
    if not args.video_id and not args.name:
        raise SystemExit('Give --video-id (preferred) or --name, so Overtone can find the file.')

    result = transcribe(args.audio, args.model, args.language, args.device)

    lines = []
    for segment in result.to_dict()['segments']:
        text = segment['text'].strip()
        if text:
            lines.append((float(segment['start']), text))

    if not lines:
        raise SystemExit('Whisper returned nothing usable.')

    out_dir = args.out or lyrics_dir()
    os.makedirs(out_dir, exist_ok=True)
    stem = args.video_id if args.video_id else safe_name(args.name)
    out_path = os.path.join(out_dir, stem + '.lrc')

    if os.path.exists(out_path):
        with open(out_path, encoding='utf-8') as handle:
            if MANAGED_MARKER not in handle.read():
                raise SystemExit(
                    'Refusing to overwrite %s — it was not written by this tool, '
                    'so it may be a version you corrected by hand.' % out_path)

    header = [
        '[ti:%s]' % args.title,
        '[ar:%s]' % args.artist,
        '[by:Overtone (whisper %s)]' % args.model,
        MANAGED_MARKER,
        '',
    ]
    body = ['%s%s' % (timestamp(start), text) for start, text in lines]

    with open(out_path, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(header + body) + '\n')

    print('\n%d lines -> %s' % (len(lines), out_path), file=sys.stderr)
    print('Check the first few and fix anything wrong; Overtone will not '
          'overwrite the file once you edit it.', file=sys.stderr)
    for start, text in lines[:5]:
        print('  %s%s' % (timestamp(start), text), file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
