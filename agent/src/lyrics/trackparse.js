'use strict';

/**
 * Turns a YouTube video title into something a lyrics database can match.
 *
 * YouTube titles are a landfill: "ARTIST - Song (Official Music Video) [4K]
 * | Label". YouTube Music, by contrast, hands us a clean title/author pair, so
 * that path skips almost all of this.
 */

/** Bracketed segments containing any of these are promotional noise. */
const NOISE_WORDS = [
  'official',
  'officiel',
  'video',
  'videoclip',
  'audio',
  'lyric',
  'lyrics',
  'letra',
  'visualizer',
  'visualiser',
  'mv',
  'm/v',
  'hd',
  'hq',
  '4k',
  '8k',
  '1080p',
  '720p',
  'full album',
  'free download',
  'out now',
  'explicit',
  'clean version',
  'color coded',
  'sub español',
  'legendado',
  'music video',
  'clip officiel',
];

/** Bracketed segments containing these are meaningful — keep them. */
const KEEP_WORDS = [
  'remix',
  'edit',
  'mix',
  'version',
  'acoustic',
  'live',
  'cover',
  'remaster',
  'instrumental',
  'feat',
  'ft.',
  'prod',
  'bootleg',
  'vip',
  'extended',
  'radio',
];

const SEPARATORS = [' - ', ' – ', ' — ', ' -- ', ' ~ ', ' | ', ' • '];

/**
 * @param {object} snapshot playback snapshot from the extension
 * @returns {{ artist: string, artistFull: string, track: string, confident: boolean }}
 *   `artist` is the primary name only, because lyrics databases index it that
 *   way and featured names ruin the match. `artistFull` keeps every
 *   collaborator, for display where the whole credit belongs.
 */
function parseTrack(snapshot) {
  // YouTube Music already gives us structured metadata; trust it.
  if (snapshot.source === 'ytmusic' && snapshot.title) {
    return {
      artist: cleanArtist(snapshot.artist || ''),
      artistFull: stripNoise(snapshot.artist || ''),
      track: stripNoise(snapshot.title),
      confident: true,
    };
  }

  const title = stripNoise(snapshot.title || '');
  if (!title) return { artist: '', artistFull: '', track: '', confident: false };

  // "Artist - Topic" auto-generated channels are reliable artist labels.
  const topicArtist = /^(.*?)\s*-\s*Topic$/i.exec(snapshot.channel || '');
  if (topicArtist) {
    const artist = cleanArtist(topicArtist[1]);
    const split = splitOnSeparator(title);
    // The title may still repeat the artist ("Artist - Song"); prefer the tail.
    const track = split && looseEquals(split.left, artist) ? split.right : title;
    const artistFull = split && looseEquals(split.left, artist) ? split.left : topicArtist[1];
    return { artist, artistFull: stripNoise(artistFull), track, confident: true };
  }

  const split = splitOnSeparator(title);
  if (split) {
    return {
      artist: cleanArtist(split.left),
      artistFull: stripNoise(split.left),
      track: stripNoise(split.right),
      confident: true,
    };
  }

  // No separator: the channel is the best artist guess we have.
  return {
    artist: cleanArtist(snapshot.channel || ''),
    artistFull: stripNoise(snapshot.channel || ''),
    track: title,
    confident: false,
  };
}

/** Split on the first separator that leaves non-trivial text on both sides. */
function splitOnSeparator(title) {
  for (const separator of SEPARATORS) {
    const index = title.indexOf(separator);
    if (index <= 0) continue;

    const left = title.slice(0, index).trim();
    const right = title.slice(index + separator.length).trim();
    if (left.length >= 1 && right.length >= 1) return { left, right };
  }
  return null;
}

/** Remove promotional brackets, trailing pipes, and stray quoting. */
function stripNoise(input) {
  let text = String(input || '');

  text = text.replace(/[([{]([^)\]}]*)[)\]}]/g, (match, inner) => {
    const lower = inner.toLowerCase();
    if (KEEP_WORDS.some((word) => lower.includes(word))) return match;
    if (NOISE_WORDS.some((word) => lower.includes(word))) return ' ';
    return match;
  });

  // Trailing "| Label" / "| Out Now" style suffixes.
  text = text.replace(/\s*\|\s*[^|]{0,40}$/u, (match) => {
    const lower = match.toLowerCase();
    return NOISE_WORDS.some((word) => lower.includes(word)) ? '' : match;
  });

  text = text
    .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return text;
}

/** Drop "VEVO"/"Official" suffixes and collapse featured-artist lists. */
function cleanArtist(input) {
  let artist = stripNoise(input);

  artist = artist
    // VEVO channels glue the suffix straight onto the name ("DaftPunkVEVO"),
    // so a word boundary on the left would never match. Anchor on the end.
    .replace(/\s*vevo\s*$/i, '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\bOfficial\b/gi, '')
    .replace(/\bMusic\b$/i, '')
    .trim();

  // Lyrics databases index the primary artist; featured names hurt matching.
  artist = artist.split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bx\b|\bwith\b)\s*/i)[0] || artist;

  return artist.replace(/\s{2,}/g, ' ').trim();
}

function looseEquals(a, b) {
  const normalise = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  return normalise(a) === normalise(b) && normalise(a).length > 0;
}

/**
 * Collaboration markers that separate several artists in one string.
 * Requires surrounding whitespace so a name like "Malibu" survives the "x".
 */
const ARTIST_SPLIT =
  /\s+(?:x|×|&|\+|feat\.?|ft\.?|featuring|vs\.?|and|und|with|mit)\s+|\s*,\s*/gi;

/**
 * Normalise a multi-artist string to the comma form Spotify uses.
 *
 * "doli x szevczor x yokinashi" -> "doli, szevczor, yokinashi"
 *
 * @param {string} input
 * @param {string} [separator]
 * @returns {string}
 */
function formatArtists(input, separator = ', ') {
  if (!input) return '';

  const seen = new Set();
  const unique = [];

  for (const part of String(input).split(ARTIST_SPLIT)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue; // "Doli x Doli" is a typo, not a duo
    seen.add(key);
    unique.push(name);
  }

  return unique.join(separator);
}

module.exports = { parseTrack, stripNoise, cleanArtist, formatArtists };
