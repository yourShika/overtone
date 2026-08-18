"""
Guard against filing a bad transcription as lyrics.

    python agent/test/quality.test.py

Both failure cases below are real Whisper output captured while building this,
not invented examples. The third case is the one that matters most: a chorus
genuinely repeats, and rejecting those songs would be its own bug.
"""

import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location(
    'tool', os.path.join(ROOT, 'tools', 'transcribe-to-lrc.py'))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class Info:
    def __init__(self, language, probability):
        self.language = language
        self.language_probability = probability


def check(name, lines, info, forced, expect_rejected):
    problems = tool.check_quality(lines, info, forced)
    rejected = bool(problems)
    status = 'ok  ' if rejected == expect_rejected else 'FAIL'
    print('%s %s' % (status, name))
    for problem in problems:
        print('       %s' % problem)
    return rejected == expect_rejected


def main():
    results = [
        # medium, auto-detect, on a Polish track: one phrase for the whole song.
        check('repetition loop is rejected',
              [(i * 10.0, 'Moya milost') for i in range(11)],
              Info('ru', 0.43), None, True),

        # small with the language pinned: imperfect but usable.
        check('a real, usable result is kept',
              [(30.0, 'Niestety mala sukupuna nie spalej sie nigdy'),
               (32.9, 'Nie musisz mi wierzyc, nie musisz mi wierzyc'),
               (36.0, 'Nie musisz mi wierzyc, mala chcialbym pozbyc sie tej presji'),
               (39.8, 'W kloce mlywysci kto z nas jest najlepszy'),
               (42.5, 'Prosze powiedziec jak moz trafic bysmy znowu byli dziedzimi'),
               (45.8, 'Moze wezmy kretki, narysujmy swiat i gniesc'),
               (48.6, 'On nam mowi do mnie chlopcy, chlopcy, chlopcy')],
              Info('pl', 1.0), 'pl', False),

        # The false positive to avoid: choruses repeat on purpose.
        check('a genuinely repeating chorus is not mistaken for a loop',
              [(0.0, 'Verse one'), (4.0, 'Verse two'), (8.0, 'Chorus'),
               (12.0, 'Chorus'), (16.0, 'Verse three'), (20.0, 'Verse four'),
               (24.0, 'Chorus'), (28.0, 'End')],
              Info('en', 0.95), None, False),

        check('low language confidence is rejected when nothing was pinned',
              [(i * 4.0, 'Line %d' % i) for i in range(8)],
              Info('bg', 0.22), None, True),

        check('a pinned language silences the confidence check',
              [(i * 4.0, 'Line %d' % i) for i in range(8)],
              Info('bg', 0.22), 'pl', False),

        check('too few lines to judge repetition is left alone',
              [(0.0, 'Same'), (4.0, 'Same'), (8.0, 'Same')],
              Info('de', 0.9), None, False),
    ]
    failed = results.count(False)
    print('\n%d passed, %d failed' % (results.count(True), failed))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
