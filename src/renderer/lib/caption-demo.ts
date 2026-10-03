/** Local speech alignment of the bundled captions-demo.mp3, in milliseconds. */
export const CAPTION_DEMO_WORDS = [
  { text: 'This', start: 180, end: 280 },
  { text: 'is', start: 280, end: 420 },
  { text: 'how', start: 420, end: 630 },
  { text: 'captions', start: 630, end: 1180 },
  { text: 'will', start: 1180, end: 1460 },
  { text: 'look', start: 1460, end: 1760 },
  { text: 'in', start: 1760, end: 1880 },
  { text: 'your', start: 1880, end: 2160 },
  { text: 'shorts.', start: 2160, end: 2800 }
] as const

export const CAPTION_DEMO_DURATION_MS = 2847

/** Locally aligned to captions-demo-longer.mp3, including the spoken pauses. */
export const CAPTION_LONG_DEMO_WORDS = [
  { text: 'This', start: 120, end: 340 },
  { text: 'is', start: 340, end: 510 },
  { text: 'an', start: 510, end: 680 },
  { text: 'example', start: 680, end: 1310 },
  { text: 'of', start: 1310, end: 1450 },
  { text: 'longer', start: 1450, end: 1950 },
  { text: 'text.', start: 1950, end: 2600 },
  { text: 'With', start: 2600, end: 2900 },
  { text: 'this', start: 2900, end: 3200 },
  { text: 'example,', start: 3200, end: 3850 },
  { text: 'you', start: 3850, end: 3990 },
  { text: 'should', start: 3990, end: 4270 },
  { text: 'be', start: 4270, end: 4390 },
  { text: 'able', start: 4390, end: 4560 },
  { text: 'to', start: 4560, end: 4700 },
  { text: 'see', start: 4700, end: 5280 },
  { text: 'how', start: 5280, end: 5360 },
  { text: 'captions', start: 5360, end: 5790 },
  { text: 'behave', start: 5790, end: 6500 },
  { text: 'in', start: 6500, end: 6550 },
  { text: 'a', start: 6550, end: 6620 },
  { text: 'longer', start: 6620, end: 7070 },
  { text: 'conversation.', start: 7070, end: 8200 }
] as const

export const CAPTION_LONG_DEMO_DURATION_MS = 8281
