/**
 * .dockerignore matching with Docker's own rules (moby/patternmatcher), which differ from
 * gitignore: every pattern is tested against the path AND each of its parent folders, the last
 * matching pattern wins, and a `!exception` can bring back a file inside an excluded folder
 * (e.g. `**` followed by `!scripts/build.mjs`).
 */

/** Turn one cleaned Docker pattern into a RegExp over POSIX relative paths. */
function patternRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        // "**/" matches zero or more folders; a trailing or inner "**" matches anything.
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) {
        re += '\\[';
      } else {
        let cls = pattern.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (cls.startsWith('!') || cls.startsWith('^')) cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = end;
      }
    } else if (ch === '\\' && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Clean a pattern the way Docker does (filepath.Clean, no leading slash). */
function cleanPattern(p) {
  const parts = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Parse .dockerignore text into a matcher with the same interface listFiles uses.
 * @param {string} text
 * @returns {{ignores: (rel: string) => boolean, mayDescend: (relDir: string) => boolean, patterns: object[]}}
 */
export function dockerMatcher(text) {
  const patterns = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const exclusion = line.startsWith('!');
    const p = cleanPattern(exclusion ? line.slice(1).trim() : line);
    if (!p) continue;
    const globAt = p.search(/[*?[\\]/);
    patterns.push({ exclusion, regex: patternRegex(p), prefix: globAt < 0 ? p : p.slice(0, globAt), glob: globAt >= 0 });
  }
  patterns.push({ exclusion: false, regex: /^\.git$/, prefix: '.git' }); // never upload .git (last match wins)

  const ignores = (relIn) => {
    const rel = relIn.replace(/\/+$/, '');
    const segs = rel.split('/');
    const candidates = segs.map((_, i) => segs.slice(0, i + 1).join('/'));
    let matched = false;
    for (const pat of patterns) {
      if (pat.exclusion === !matched) continue; // cannot change the result
      if (candidates.some((c) => pat.regex.test(c))) matched = !pat.exclusion;
    }
    return matched;
  };
  const exceptions = patterns.filter((p) => p.exclusion);
  // An excluded folder is still walked when an exception could match something inside it.
  const mayDescend = (relDir) => {
    const dir = relDir.replace(/\/+$/, '');
    return exceptions.some((e) => e.prefix === '' || e.prefix.startsWith(`${dir}/`) || (e.glob && `${dir}/`.startsWith(e.prefix)));
  };
  return { ignores, mayDescend, patterns };
}
