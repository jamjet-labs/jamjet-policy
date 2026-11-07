// Policy glob matching without regular expressions.
//
// `*` matches any run of characters (newlines included), `?` matches exactly
// one character, everything else is literal, and the match is anchored to the
// whole name. This is the usual two-pointer wildcard match: on a mismatch it
// only ever backs up to the most recent `*`, so the work is bounded by
// pattern length times name length. The regex form (`.*` per star) can
// backtrack polynomially in the number of stars, which a policy author can
// push past Claude Code's hook timeout.

export function globMatch(pattern: string, name: string): boolean {
  let p = 0
  let n = 0
  let starP = -1
  let starN = 0
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
      p++
      n++
    } else if (p < pattern.length && pattern[p] === '*') {
      starP = p++
      starN = n
    } else if (starP >= 0) {
      p = starP + 1
      n = ++starN
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}
