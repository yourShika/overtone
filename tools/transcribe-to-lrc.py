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


def transcribe(path: str, model_name: str, language, device: str,
               max_line: int = 60, gap: float = 0.6):
    from stable_whisper import load_faster_whisper

    print('Loading Whisper %r on %s ...' % (model_name, device), file=sys.stderr)
    model = load_faster_whisper(
        model_name,
        device=device,
        compute_type='int8' if device == 'cpu' else 'float16',
    )

    print('Transcribing (this takes a while on CPU) ...', file=sys.stderr)
    result = model.transcribe_stable(path, language=language, regroup=False)
    model_info = getattr(result, 'ori_dict', None) or {}
    model_info = type('Info', (), {
        'language': model_info.get('language', language or '?'),
        'language_probability': model_info.get('language_probability', 1.0),
    })()

    # Regrouping decides where one lyric line ends. Sung lines follow breaths
    # and phrases rather than punctuation, which Whisper rarely emits for
    # singing, so gaps carry most of the signal here.
    #
    # The default cap is 60 rather than the field limit of 128: Overtone packs
    # several lines into one update, and short lines pack far better. One
    # 120-character line fills a block on its own, where two 60-character lines
    # share it and read as a couplet.
    (
        result
        .clamp_max()
        .split_by_punctuation([('.', ' '), '?', ('!', ' ')])
        .split_by_gap(gap)
        .split_by_length(max_line)
    )
    return result, model_info


def check_quality(lines, info, forced_language):
    """
    Reject output that is obviously wrong, rather than filing it as lyrics.

    Whisper fails on music in two recognisable ways, both seen while building
    this. It misidentifies the language and returns fluent nonsense in the wrong
    script, and it falls into a repetition loop that emits one phrase for the
    whole song. Both look like a normal result to the caller, so they have to be
    caught here — a bad .lrc is worse than none, because it silently replaces a
    working source and looks deliberate.

    Returns a list of complaints; empty means the result looks usable.
    """
    problems = []
    texts = [text for _, text in lines]

    if len(texts) >= 6:
        unique = len(set(texts))
        if unique / len(texts) < 0.5:
            problems.append(
                'repetition loop: only %d distinct lines out of %d'
                % (unique, len(texts)))

    probability = getattr(info, 'language_probability', 1.0) or 1.0
    if not forced_language and probability < 0.5:
        problems.append(
            'unsure of the language: %s at %.0f%% confidence - pass --language to pin it'
            % (getattr(info, 'language', '?'), probability * 100))

    return problems

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
    parser.add_argument('--max-line', type=int, default=60, dest='max_line',
                        help='longest lyric line in characters (default: 60)')
    parser.add_argument('--gap', type=float, default=0.6,
                        help='silence in seconds that ends a line (default: 0.6)')
    parser.add_argument('--force', action='store_true',
                        help='write even if the result looks wrong')
    args = parser.parse_args()

    if not os.path.isfile(args.audio):
        raise SystemExit('No such file: %s' % args.audio)
    if not args.video_id and not args.name:
        raise SystemExit('Give --video-id (preferred) or --name, so Overtone can find the file.')

    result, info = transcribe(
        args.audio, args.model, args.language, args.device,
        max_line=args.max_line, gap=args.gap,
    )

    lines = []
    for segment in result.to_dict()['segments']:
        text = segment['text'].strip()
        if text:
            lines.append((float(segment['start']), text))

    if not lines:
        raise SystemExit('Whisper returned nothing usable.')

    problems = check_quality(lines, info, args.language)
    if problems and not args.force:
        for problem in problems:
            print('Rejected - %s' % problem, file=sys.stderr)
        raise SystemExit(
            'Nothing written. Re-run with --language <code> to pin the language, '
            'or --force to keep this result anyway.')

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
