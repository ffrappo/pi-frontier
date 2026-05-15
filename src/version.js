// version.js — version-aware family/version parsing for model keys.
// Parses the version token OUT of a model name, leaving a bare family name
// plus a comparable version value. Pure deterministic, no AI.

// Context-size and qualifier tokens stripped before family-keying (point 2).
const CONTEXT_RE   = /-(?:8k|16k|32k|64k|128k|256k|512k|1m|2m)\b/gi;
const QUALIFIER_RE = /-(?:latest|preview|nightly|beta|exp|experimental|customtools)\b/gi;

// Provider prefix inside a key, e.g. "xai/grok-3", "openrouter/openai/gpt-4o".
function stripProviderPrefix(key) {
  let n = key;
  // strip leading "vendor/" segments (one or more); vendor may contain hyphens
  while (/^[a-z0-9_-]+\//i.test(n)) n = n.replace(/^[a-z0-9_-]+\//i, '');
  // strip vendor dot-prefixes (anthropic., amazon., meta.)
  n = n.replace(/^(?:anthropic|amazon|meta|writer|twelvelabs)\./i, '');
  // strip image-size prefixes like "1024-x-1024/"
  n = n.replace(/^\d+-x-\d+\//, '');
  return n;
}

// Compare two version arrays (numeric tuples). Returns >0 if a newer than b.
function cmpTuple(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// Reduce a version object's semver to a single comparable number when it came
// from a DOTTED form (`X.Y` like `4.20`, `4.3`): the segment after the first
// dot is a decimal fraction, so `4.20` (=4.2) < `4.3`. Dashed/multi-segment
// semver (`claude-opus-4-7`, full `X.Y.Z`) keeps segment-wise comparison.
function cmpSemver(a, b) {
  const sa = a.semver || [], sb = b.semver || [];
  // dotted 2-segment on both sides → compare major then minor-as-decimal
  if (a.dotted && b.dotted && sa.length === 2 && sb.length === 2) {
    if (sa[0] !== sb[0]) return sa[0] - sb[0];
    const fa = +`0.${sa[1]}`, fb = +`0.${sb[1]}`;
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  }
  return cmpTuple(sa, sb);
}

// Compare two parsed version objects {semver:[], date:number, dotted:bool}.
// Semver primary, date tiebreak (point 1).
export function cmpVersion(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const s = cmpSemver(a, b);
  if (s !== 0) return s;
  return (a.date || 0) - (b.date || 0);
}

// Parse a model key → { family, version, raw }.
// version is { semver:[..numbers..], date:YYYYMMDD|0 } or null if unparseable.
export function parseModelKey(key) {
  let n = stripProviderPrefix(key).toLowerCase();

  // strip context-size + qualifier tokens (point 2)
  n = n.replace(CONTEXT_RE, '').replace(QUALIFIER_RE, '');
  // strip trailing region/commitment junk like ":0", "@001", "-v1:0"
  n = n.replace(/-v\d+:\d+$/, '').replace(/:\d+$/, '').replace(/@\d+$/, '');
  n = n.replace(/--+/g, '-').replace(/-+$/, '').trim();

  let semver = null;
  let date = 0;
  let dotted = false;        // true when semver came from a `X.Y` dotted form
  let dateApprox = false;    // true when date is a MMDD code with no real year

  // ── date-codes ──────────────────────────────────────────────────
  // full date: 2026-01-23  or  -20260416  or  03-2025 (MM-YYYY)
  let m;
  if ((m = n.match(/(20[12]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/))) {
    date = +(m[1] + m[2] + m[3]);
    n = n.replace(m[0], '');
  } else if ((m = n.match(/(?:^|[-_])(20[12]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:$|[-_])/))) {
    date = +(m[1] + m[2] + m[3]);
    n = n.replace(m[1] + m[2] + m[3], '');
  } else if ((m = n.match(/(0[1-9]|1[0-2])-(20[12]\d)/))) {
    date = +(m[2] + m[1] + '00');
    n = n.replace(m[0], '');
  } else if ((m = n.match(/-(\d{2})(\d{2})-(20[12]\d)\b/))) {
    // command-r-08-2024 style: -MM-DD-YYYY is unusual; treat -MM-YYYY handled above.
  }

  // doubao-style 6-digit YYMMDD: -251201, -260215  (parse before YYMM)
  if (!date && (m = n.match(/-(\d{2})(\d{2})(\d{2})(?=$|-)/))) {
    const yy = +m[1], mo = +m[2], dd = +m[3];
    if (yy >= 23 && yy <= 30 && mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      date = +('20' + m[1] + m[2] + m[3]);
      n = n.slice(0, m.index) + n.slice(m.index + m[0].length);
    }
  }
  // YYMM/MMDD date-code: mistral-large-2512, grok-2-1212, *-0825, *-0430, *-0709
  // Standalone 4-digit token after a dash. YYMM (yy>=23) preferred; else MMDD.
  if (!date && (m = n.match(/-(\d{4})(?=$|-)/))) {
    const a = +m[1].slice(0, 2), b = +m[1].slice(2);
    let ok = false;
    if (a >= 23 && a <= 30 && b >= 1 && b <= 12) { date = +('20' + m[1] + '00'); ok = true; }      // YYMM
    else if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {                                             // MMDD (no year)
      // No real year — store the MMDD as a low-priority tiebreak only, and
      // mark it approximate so reports don't print a misleading 2000-.. date.
      date = +m[1]; dateApprox = true; ok = true;
    }
    if (ok) n = n.slice(0, m.index) + n.slice(m.index + m[0].length);
  }

  // ── semver / integer version ────────────────────────────────────
  // dotted: glm-4.6, grok-4.3, gpt-5.5, v3.2
  if ((m = n.match(/(?:^|[-/])v?(\d+)\.(\d+)(?:\.(\d+))?(?=$|[-_])/))) {
    // 2-segment dotted (`4.20`) → minor compares as a decimal fraction;
    // explicit 3-segment (`X.Y.Z`) is full semver, compared segment-wise.
    semver = m[3] ? [+m[1], +m[2], +m[3]] : [+m[1], +m[2]];
    dotted = !m[3];
    n = n.slice(0, m.index) + (m.index > 0 ? n[m.index] : '') + n.slice(m.index + m[0].length);
  }
  // dotted attached to letter: minimax-m2.5, kimi-k2.6
  if (!semver && (m = n.match(/([a-z])(\d+)\.(\d+)(?:\.(\d+))?(?=$|[-_])/))) {
    semver = m[4] ? [+m[2], +m[3], +m[4]] : [+m[2], +m[3]];
    dotted = !m[4];
    n = n.slice(0, m.index + 1) + n.slice(m.index + m[0].length);
  }
  // dashed two-part semver: claude-opus-4-7, grok-4-1, glm-4-7
  if (!semver && (m = n.match(/-(\d+)-(\d+)(?=$|-)/))) {
    semver = [+m[1], +m[2]];
    n = n.slice(0, m.index) + n.slice(m.index + m[0].length);
  }
  // explicit -vN(.N): deepseek-v3, moonshot-v1, codestral-2405 handled by date
  if (!semver && (m = n.match(/-v(\d+)(?:-(\d+))?(?=$|-)/))) {
    semver = m[2] ? [+m[1], +m[2]] : [+m[1]];
    n = n.slice(0, m.index) + n.slice(m.index + m[0].length);
  }
  // plain dashed integer: grok-2, gpt-4, grok-code-fast-1
  if (!semver && (m = n.match(/-(\d+)(?=$|-)/))) {
    semver = [+m[1]];
    n = n.slice(0, m.index) + n.slice(m.index + m[0].length);
  }
  // leading-integer families: o1/o3/o4
  if (!semver && (m = n.match(/^o(\d+)(?=$|-)/))) {
    semver = [+m[1]];
    n = 'o' + n.slice(m[0].length);
  }

  let family = n.replace(/--+/g, '-').replace(/^-+|-+$/g, '').trim();
  if (!family) family = stripProviderPrefix(key).toLowerCase();

  const hasVersion = semver || date;
  return {
    family,
    version: hasVersion ? { semver: semver || [], date, dotted, dateApprox } : null,
    raw: key,
  };
}

// Human-readable version string for reports.
export function versionStr(v) {
  if (!v) return '—';
  const parts = [];
  if (v.semver && v.semver.length) parts.push(v.semver.join('.'));
  if (v.date) {
    // Real YYYYMMDD dates print as 2026-04-16; approximate MMDD codes (no year)
    // print as a bare mmdd tiebreak hint, not a misleading 2000-.. date.
    parts.push(v.dateApprox
      ? `mmdd:${String(v.date).padStart(4, '0')}`
      : String(v.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
  }
  return parts.join(' / ') || '—';
}
