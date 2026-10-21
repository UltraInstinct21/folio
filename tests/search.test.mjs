// self-check for src/vendor/foliate-js/search.js — pure logic, no DOM needed
import { search } from '../src/vendor/foliate-js/search.js'

let n = 0
const ok = (cond, msg) => {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1) }
  n++
}

// match spanning a node boundary, exact offsets
const strs = ['hello ', 'world, this ', 'is a book']
const [m] = [...search(strs, 'hello world', {})]
ok(m.range.startIndex === 0 && m.range.startOffset === 0, 'start at first node')
ok(m.range.endIndex === 1 && m.range.endOffset === 5, 'end spans node boundary')
ok(m.excerpt.match === 'hello world', 'excerpt text')

// case-insensitive, no-match, repeated matches
ok([...search(strs, 'WORLD', {})].length === 1, 'case-insensitive')
ok([...search(strs, 'zebra', {})].length === 0, 'no match')
ok([...search(['a a a'], 'a', {})].length === 3, 'repeated matches')

// zero-length node edge case (upstream crash): simpleSearch path only
// runs when Intl.Segmenter is unavailable or sensitivity forces it
const simple = { granularity: 'grapheme', sensitivity: 'variant' }
const e1 = [...search(['a ', '', 'b'], 'a b', simple)]
ok(e1.length === 1, 'match across empty node')
ok(e1[0].range.endIndex === 2 && e1[0].range.endOffset === 1, 'end lands on last node')
const e2 = [...search(['x', ''], 'x', simple)]
ok(e2.length === 1, 'match with trailing empty node')
ok(e2[0].range.endIndex === 1 && e2[0].range.endOffset === 0, 'end maps to empty node start (same boundary)')
// segmenter path (the way searchMatcher calls it: explicit granularity)
const seg = { locales: 'en', granularity: 'grapheme', sensitivity: 'base' }
const s1 = [...search(['a ', '', 'b'], 'a b', seg)]
ok(s1.length === 1 && s1[0].excerpt.match === 'a b', 'segmenter: match across empty node')
const s2 = [...search(['x', ''], 'x', seg)]
ok(s2.length === 1 && s2[0].range.endIndex === 0 && s2[0].range.endOffset === 1, 'segmenter: boundary end')
const s3 = [...search(['abc', 'def'], 'cde', seg)]
ok(s3.length === 1 && s3[0].excerpt.match === 'cde', 'segmenter: cross-node word')
const s4 = [...search(strs, 'HELLO WORLD', seg)]
ok(s4.length === 1 && s4[0].excerpt.match.toLowerCase() === 'hello world', 'segmenter: case-insensitive')

// match fully inside one node (simpleSearch path)
const [m2] = [...search(['abc', 'def'], 'cde', simple)]
ok(m2.range.startIndex === 0 && m2.range.startOffset === 2, 'start inside first node')
ok(m2.range.endIndex === 1 && m2.range.endOffset === 2, 'end inside second node')

// accented text + empty query is no crash
ok([...search(['naïve ', 'café'], 'café', {})].length === 1, 'accented text')
ok([...search(['abc'], '', {})].length === 0, 'empty query')

console.log(`SEARCH SELF-CHECK PASSED (${n} checks)`)
