/**
 * Parser regression tests, using card text captured from the live page on
 * 2026-11-20. When Douyin changes its card layout these are the first things to
 * fail, and they fail without launching a browser.
 *
 *   node scripts/test-parse.mjs
 */
import { parseCard, parseLikes, parseDuration, cardId } from '../lib/adapters/douyin/feed.js'

const samples = [
  {
    text: '06:29 1.3万 唐王大人花费千万哈弗币领养三个大哥，会发生什么有意思的事情呢 #三角洲行动 #三角洲s12微光新赛季#三角洲行动手游 #游戏 #搞笑 @尾巴（三角洲行动） · 2天前',
    expect: { durationSec: 389, likes: 13000, author: '尾巴（三角洲行动）', age: '2天前' }
  },
  {
    text: '05:29 28.5万 《我好想你》把所有藏在心底、说不出口的克制，唱成了最汹涌的呼唤。 #音乐 @某人 · 1周前',
    expect: { durationSec: 329, likes: 285000, author: '某人', age: '1周前' }
  },
  {
    // published date instead of a relative age: the bug found in the first live round
    text: '《绝了大坝》亿！镜！到！底！ #三角洲行动 @叶开 · 11月12日',
    expect: { durationSec: null, author: '叶开', age: '11月12日', titleExcludes: '11月12日' }
  },
  {
    text: '04:41 3423 爸妈！今天你们化身职业德穆兰！ #三角洲行动 @成成大王 · 10月22日',
    expect: { durationSec: 281, likes: 3423, age: '10月22日' }
  },
  {
    // a promo tile with no title must be rejected rather than stored
    text: '共创 手机随时看更方便 下载 APP',
    expect: null
  }
]

let failed = 0
const check = (name, actual, expected) => {
  const ok = Object.is(actual, expected)
  if (!ok) {
    failed++
    console.error(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

for (const [i, sample] of samples.entries()) {
  const parsed = parseCard(sample.text)
  if (sample.expect === null) {
    if (parsed !== null) {
      failed++
      console.error(`  FAIL sample ${i}: expected null, got ${JSON.stringify(parsed)}`)
    } else {
      console.log(`  ok   sample ${i}: rejected as intended`)
    }
    continue
  }
  if (!parsed) {
    failed++
    console.error(`  FAIL sample ${i}: parser returned null`)
    continue
  }
  if (sample.expect.durationSec != null) check(`sample ${i} durationSec`, parsed.durationSec, sample.expect.durationSec)
  if (sample.expect.likes != null) check(`sample ${i} likes`, parsed.likes, sample.expect.likes)
  if (sample.expect.author != null) check(`sample ${i} author`, parsed.author, sample.expect.author)
  if (sample.expect.age != null) check(`sample ${i} age`, parsed.ageText, sample.expect.age)
  if (sample.expect.titleExcludes) {
    const leaked = parsed.title.includes(sample.expect.titleExcludes)
    if (leaked) {
      failed++
      console.error(`  FAIL sample ${i}: title leaked "${sample.expect.titleExcludes}" -> ${parsed.title}`)
    }
  }
  console.log(`  ok   sample ${i}: ${parsed.title.slice(0, 42)} | @${parsed.author ?? '-'} | ${parsed.likesText ?? '-'}`)
}

// helpers
check('parseLikes 1.3万', parseLikes('1.3万'), 13000)
check('parseLikes 2.1亿', parseLikes('2.1亿'), 210000000)
check('parseLikes 3423', parseLikes('3423'), 3423)
check('parseDuration 06:29', parseDuration('06:29'), 389)
check('parseDuration 1:02:03', parseDuration('1:02:03'), 3723)

// ids must be stable for the same video and differ across videos
const a = parseCard(samples[0].text)
const b = parseCard(samples[0].text)
check('cardId stable', cardId(a), cardId(b))
const c = parseCard(samples[1].text)
check('cardId differs', cardId(a) !== cardId(c), true)

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall parser checks passed')
