interface CaptionWord { text: string }

export interface CaptionPreviewLine {
  start: number
  end: number
  /** Only a word wider than the entire frame needs a local size adjustment. */
  scale: number
}

export interface CaptionPreviewGroup {
  start: number
  end: number
  lines: CaptionPreviewLine[]
}

/** Keep timed word groups, split overflow, then balance the requested rows. */
export function captionPreviewGroups(
  words: readonly CaptionWord[],
  maxWords: number,
  maxLines: number | null | undefined,
  measure: (text: string) => number,
  separator = ' ',
  availableWidth = 960
): CaptionPreviewGroup[] {
  const groups: CaptionPreviewGroup[] = []
  const append = (start: number, end: number): void => {
    if (maxLines == null) {
      groups.push({ start, end, lines: [{ start, end, scale: 1 }] })
      return
    }
    let groupStart = start
    let lines: CaptionPreviewLine[] = []
    let lineStart = start
    let lineText = ''
    const pushLine = (lineEnd: number): void => {
      const width = measure(lineText)
      lines.push({ start: lineStart, end: lineEnd, scale: lineEnd - lineStart === 1 ? Math.min(1, availableWidth / Math.max(1, width)) : 1 })
    }
    for (let index = start; index < end; index++) {
      const text = words[index].text
      const wordWidth = measure(text)
      if (wordWidth > availableWidth) {
        if (index > lineStart) pushLine(index)
        if (lines.length) groups.push({ start: groupStart, end: index, lines })
        groups.push({ start: index, end: index + 1, lines: [{ start: index, end: index + 1, scale: availableWidth / wordWidth }] })
        groupStart = index + 1
        lineStart = index + 1
        lineText = ''
        lines = []
        continue
      }
      const nextText = lineText ? `${lineText}${separator}${text}` : text
      if (index > lineStart && measure(nextText) > availableWidth) {
        pushLine(index)
        if (lines.length === maxLines) {
          groups.push({ start: groupStart, end: index, lines })
          groupStart = index
          lines = []
        }
        lineStart = index
        lineText = text
      } else lineText = nextText
    }
    if (lineText) {
      pushLine(end)
      groups.push({ start: groupStart, end, lines })
    }
  }
  let start = 0
  for (let index = 0; index < words.length; index++) {
    const count = index - start + 1
    const word = words[index].text
    if (count >= maxWords || /[.!?]$/.test(word) || count >= 2 && /,$/.test(word) || index === words.length - 1) {
      append(start, index + 1)
      start = index + 1
    }
  }
  if (maxLines == null) return groups
  return groups.map(group => {
    if (group.end - group.start === 1) return group
    const target = Math.min(maxLines, group.end - group.start)
    const widths = new Map<string, number>()
    const width = (start: number, end: number): number => {
      const key = `${start}:${end}`
      if (!widths.has(key)) widths.set(key, measure(words.slice(start, end).map(word => word.text).join(separator)))
      return widths.get(key)!
    }
    let best: CaptionPreviewLine[] | null = null
    let bestWidest = Infinity
    let bestSquared = Infinity
    const visit = (start: number, remaining: number, lines: CaptionPreviewLine[], rowWidths: number[]): void => {
      if (remaining === 1) {
        const lastWidth = width(start, group.end)
        if (lastWidth > availableWidth) return
        const candidateWidths = [...rowWidths, lastWidth]
        const widest = Math.max(...candidateWidths)
        const squared = candidateWidths.reduce((sum, value) => sum + value * value, 0)
        if (widest < bestWidest - 1e-6 || Math.abs(widest - bestWidest) <= 1e-6 && squared < bestSquared - 1e-6) {
          best = [...lines, { start, end: group.end, scale: 1 }]
          bestWidest = widest
          bestSquared = squared
        }
        return
      }
      // Descending cuts keep earlier rows fuller when widths tie exactly.
      for (let end = group.end - remaining + 1; end > start; end--) {
        const rowWidth = width(start, end)
        if (rowWidth <= availableWidth) visit(end, remaining - 1, [...lines, { start, end, scale: 1 }], [...rowWidths, rowWidth])
      }
    }
    visit(group.start, target, [], [])
    return { ...group, lines: best ?? group.lines }
  })
}
