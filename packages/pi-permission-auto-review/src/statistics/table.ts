export type StatusRow = readonly [label: string, value: string]

function wrapLabel(label: string, width: number): string[] {
  if (label.length <= width) {
    return [label]
  }
  const lines: string[] = []
  let rest = label
  while (rest.length > width) {
    const space = rest.lastIndexOf(' ', width)
    const end = space > 0 ? space : width
    lines.push(rest.slice(0, end))
    rest = rest.slice(end).trimStart()
  }
  if (rest.length > 0) {
    lines.push(rest)
  }

  return lines
}

/** Label and value rows, the values right-aligned, wrapping labels that do not fit `columns` */
export function statusTable(rows: readonly StatusRow[], columns: number): string[] {
  const valueWidth = Math.max(0, ...rows.map(([, value]) => value.length))
  const labelWidth = Math.min(
    Math.max(0, ...rows.map(([label]) => label.length)),
    Math.max(8, columns - valueWidth - 2),
  )

  return rows.flatMap(([label, value]) => {
    const [first = '', ...rest] = wrapLabel(label, labelWidth)

    return [`${first.padEnd(labelWidth)}  ${value.padStart(valueWidth)}`.trimEnd(), ...rest]
  })
}

/** A table with a label column and right-aligned value columns */
export function statusComparison(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0)))

  return [headers, ...rows].map(row =>
    row
      .map((value, index) => (index === 0 ? value.padEnd(widths[index] ?? 0) : value.padStart(widths[index] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}
