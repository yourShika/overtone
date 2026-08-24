'use strict';

/**
 * Builds the Discord activity payload from a playback snapshot.
 *
 * Field limits enforced by Discord (exceeding them makes the whole frame fail
 * silently, which is miserable to debug, so we clamp defensively):
 *   details / state / *_text : 128 characters
 *   buttons                  : max 2, label <= 32 chars, url <= 512 chars
 */

const { parseTrack, formatArtists, stripNoise } = require('../lyrics/trackparse');
const { t } = require('../i18n');

const MAX_TEXT = 128;
const MAX_BUTTON_LABEL = 32;
const MAX_BUTTONS = 2;

/** Discord activity types that SET_ACTIVITY accepts. */
const ActivityType = {
  PLAYING: 0,
  LISTENING: 2,
  WATCHING: 3,
  COMPETING: 5,
};

/**
 * Discord requires details/state to be at least 2 characters; a single
 * character is rejected. Pad rather than drop, so a song literally called "4"
 * still shows up.
 */
function clamp(value, max = MAX_TEXT) {
  if (value == null) return undefined;
  let text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  if (text.length < 2) text = `${text} `;
  return text;
}

/** Page names for the browsing presence. */
/** Page names come from the dictionary, keyed by the same identifiers. */
const PAGES = ['home', 'search', 'subscriptions', 'history', 'playlist', 'channel', 'shorts', 'browsing'];

/**
 * A YouTube tab is open but nothing is playing.
 *
 * Deliberately sparse: no timestamps, no buttons, no artwork. Scrolling the
 * home page does not warrant a progress bar, and a stale one would be worse
 * than none. The header falls back to the application name, so it reads
 * "Watching YouTube" rather than naming a song that is not playing.
 */
function buildBrowsing(state, config) {
  if (!config.showWhenBrowsing) return null;

  const isMusic = state.source === 'ytmusic';
  const page = PAGES.includes(state.page) ? state.page : 'browsing';
  return {
    type: ActivityType.WATCHING,
    details: clamp(isMusic ? t('presence.youtubeMusic') : t('presence.browsing')),
    state: clamp(t(`presence.page.${page}`)),
  };
}

/**
 * The little corner badge: playing, paused, looping, live.
 *
 * Prefers asset keys when the user uploaded their own, since those render
 * without a trip through Discord's image proxy. Otherwise it points at the
 * icons shipped with the project — Discord accepts external URLs here just as
 * it does for the large image, so nobody has to upload art assets to their own
 * application before this works.
 */
function stateBadge(state, config) {
  if (!config.showStateBadge || state.idle) return null;

  let name;
  let text;
  if (state.paused) {
    name = 'paused';
    text = t('presence.paused');
  } else if (state.live) {
    name = 'live';
    text = t('presence.live');
  } else if (state.loop) {
    name = 'loop';
    text = t('presence.loop');
  } else {
    name = 'playing';
    text = t(state.source === 'ytmusic' ? 'presence.youtubeMusic' : 'presence.youtube');
  }

  // Name the app in the tooltip. The badge is the only place someone hovering
  // an unfamiliar presence can learn what is producing it.
  text = `${text} · ${t('app.name')}`;

  const custom = state.paused ? config.pausedAssetKey : config.sourceAssetKey;
  const base = String(config.stateIconBase || '').replace(/\/+$/, '');
  const image = custom || (base ? base + '/' + name + '.png' : undefined);

  return image ? { image, text } : null;
}

/**
 * The activity header — the line Discord renders as "Hört <name> zu".
 *
 * By default Discord fills this with the application's name from the developer
 * portal, which is why it reads "YouTube" for every song. RPC does accept an
 * explicit name, so a template can put the actual artist and title there
 * instead, the way Spotify's header names what is playing.
 *
 * Returns undefined to fall back to the application name: with no template, in
 * privacy mode (the header must not leak what the rest of the payload hides),
 * and whenever substitution leaves nothing usable.
 *
 * @returns {string|undefined}
 */
function resolveName(state, config) {
  const template = String(config.activityName || '').trim();
  if (!template || config.privacyMode) return undefined;

  const parsed = parseTrack(state);
  const artist = formatArtists(parsed.artistFull || parsed.artist || state.artist || state.channel || '');
  const title = parsed.track || state.title || '';

  const filled = template
    .replace(/\{artist\}/gi, artist)
    .replace(/\{title\}/gi, title)
    .replace(/\{channel\}/gi, state.channel || '');

  // An empty placeholder leaves a dangling separator — "- 162020" for a track
  // with no artist. Trim those rather than showing the punctuation.
  const tidy = filled
    .replace(/\s*[-–—|·]\s*$/, '')
    .replace(/^\s*[-–—|·]\s*/, '')
    .trim();

  return clamp(tidy, MAX_TEXT);
}

/**
 * @param {object} params
 * @param {object} params.state    normalised playback snapshot (see session.js)
 * @param {object} params.config   user configuration
 * @param {string|null} [params.lyric] current lyric line, when lyrics are on
 * @param {string|null} [params.image] resolved artwork URL
 * @returns {object|null} activity payload, or null when nothing should show
 */
function buildActivity({ state, config, lyric = null, image = null }) {
  if (!state) return null;
  if (state.idle) return buildBrowsing(state, config);
  if (!state.title) return null;
  if (state.paused && config.hideWhenPaused) return null;

  const isMusic = state.source === 'ytmusic';
  const byline = state.artist || state.channel || '';
  // What the profile shows, free of "(Official Music Video)" and its relatives.
  const title = config.cleanTitles === false ? state.title : stripNoise(state.title) || state.title;

  const activity = {
    type: resolveType(state, config, isMusic),
  };

  // Omitted unless a template is configured, so Discord keeps using the
  // application name exactly as before.
  const name = resolveName(state, config);
  if (name) activity.name = name;

  // --- line 1 + line 2 -------------------------------------------------------
  // With lyrics active we mirror Spotify's shape: title on top, the moving line
  // underneath. Without lyrics the second line carries the channel/artist.
  if (config.privacyMode) {
    activity.details = clamp(t('presence.privateTitle'));
    activity.state = clamp('Titel ausgeblendet');
  } else if (lyric && config.lyricsProminent) {
    // Lyric first, title demoted — the closest legitimate stand-in for putting
    // the line in the custom status field.
    activity.details = clamp(`♪ ${lyric}`);
    activity.state = clamp(secondLine(title, byline));
  } else {
    activity.details = clamp(title);
    if (lyric) {
      activity.state = clamp(`♪ ${lyric}`);
    } else if (byline) {
      activity.state = clamp(isMusic ? byline : `von ${byline}`);
    }
  }

  // --- progress --------------------------------------------------------------
  // Supplying `end` makes Discord render the countdown/progress bar. Live
  // streams have no meaningful duration, so they only get an elapsed counter.
  if (!state.paused && config.showTimestamps) {
    const now = Date.now();
    const position = Math.max(0, state.position || 0);

    if (state.live || !Number.isFinite(state.duration) || state.duration <= 0) {
      activity.timestamps = { start: Math.round(now - position * 1000) };
    } else {
      const start = Math.round(now - position * 1000);
      const end = Math.round(start + state.duration * 1000);
      // Guard against a stale snapshot putting `end` in the past, which Discord
      // renders as a nonsensical negative countdown.
      activity.timestamps = end > now ? { start, end } : { start };
    }
  }

  // --- artwork ---------------------------------------------------------------
  const assets = {};
  const artwork = image || state.thumbnail;
  if (artwork && !config.privacyMode) {
    assets.large_image = artwork;
    assets.large_text = clamp(byline || title);
  } else if (config.fallbackAssetKey) {
    assets.large_image = config.fallbackAssetKey;
    assets.large_text = clamp(byline || t('app.name'));
  }

  const badge = stateBadge(state, config);
  if (badge) {
    assets.small_image = badge.image;
    assets.small_text = clamp(badge.text);
  }

  if (Object.keys(assets).length) activity.assets = assets;

  // --- buttons ---------------------------------------------------------------
  // The large image itself is NOT clickable in Discord — buttons are the only
  // way to hand someone the link.
  if (config.showButton && state.url && !config.privacyMode) {
    const buttons = [
      {
        label: clamp(
          config.buttonLabel || t(isMusic ? 'presence.listenButton' : 'presence.watchButton'),
          MAX_BUTTON_LABEL,
        ),
        url: state.url,
      },
    ];

    if (config.showChannelButton && state.channelUrl) {
      buttons.push({
        label: clamp(config.channelButtonLabel || t('presence.channelButton'), MAX_BUTTON_LABEL),
        url: state.channelUrl,
      });
    }

    activity.buttons = buttons.slice(0, MAX_BUTTONS).filter((b) => b.label && isSafeUrl(b.url));
    if (!activity.buttons.length) delete activity.buttons;
  }

  return activity;
}

/**
 * "Artist – Title", but only when that actually adds information. Most YouTube
 * titles already lead with the artist ("Daft Punk - Instant Crush"), and
 * prefixing those again reads as a bug.
 */
function secondLine(title, byline) {
  if (!byline) return title;
  if (!title) return byline;

  const simplify = (value) =>
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');

  return simplify(title).includes(simplify(byline)) ? title : `${byline} – ${title}`;
}

function resolveType(state, config, isMusic) {
  if (config.activityType === 'auto') {
    return isMusic ? ActivityType.LISTENING : ActivityType.WATCHING;
  }
  const mapped = {
    playing: ActivityType.PLAYING,
    listening: ActivityType.LISTENING,
    watching: ActivityType.WATCHING,
  }[config.activityType];
  return mapped ?? ActivityType.WATCHING;
}

/** Discord rejects non-http(s) button targets; so do we, before it gets there. */
function isSafeUrl(url) {
  if (typeof url !== 'string' || url.length > 512) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

module.exports = { buildActivity, ActivityType, clamp, isSafeUrl };
